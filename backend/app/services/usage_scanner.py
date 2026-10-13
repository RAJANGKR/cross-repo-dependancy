"""Code-usage scan. Repository source is read as TEXT from an in-memory zip:
nothing is extracted to disk and nothing is executed or imported.

Three honest tiers:
  Tier 1  import map: where a library is imported. No claim about breakage.
  Tier 2  rule packs (app/rules/*.json): names a library's official migration
          guide says changed. Items with "verified": false are reported as
          candidates, never as verified.
  Tier 3  AI-suggested candidate names: not implemented in this build.
"""
import ast
import io
import json
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from app.core.config import settings
from app.services.github_fetcher import SKIP_DIRS

LIMITATIONS = (
    "Finds changed names, not silent behavior changes. Cannot see unpushed or indirectly "
    "called code. Cannot confirm a runtime failure."
)
SOURCE_SUFFIXES = (".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java")
#: Python import name differs from the distribution name.
PYTHON_ALIASES = {"pyyaml": "yaml", "scikit-learn": "sklearn", "pillow": "PIL", "beautifulsoup4": "bs4"}
_MAX_ITEMS_PER_LIBRARY = 25

_JS_IMPORT = re.compile(
    r"""(?:\bimport\s+(?:[^'"()]*?\s+from\s+)?|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]"""
)
_JAVA_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([\w.]+)\s*;", re.MULTILINE)
_PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import\s+(.+)|import\s+([\w., ]+))", re.MULTILINE)

_KIND_PATTERNS = {
    "decorator": r"@\s*(?:\w+\.)?{name}\b",
    "inner_class": r"^\s+class\s+{name}\b",
    "config_key": r"\b{name}\s*=",
    "method": r"\.{name}\s*\(",
}


@dataclass
class LibraryTarget:
    """One drifted library as seen from one repository."""

    drift_id: str
    ecosystem: str
    name: str
    #: Major version this repository is on, and the highest major another repository uses.
    repo_major: Optional[int]
    other_major: Optional[int]
    change: str


def load_rule_packs(directory: Optional[Path] = None) -> Dict[Tuple[str, str], dict]:
    packs: Dict[Tuple[str, str], dict] = {}
    for path in sorted((directory or Path(__file__).resolve().parent.parent / "rules").glob("*.json")):
        try:
            pack = json.loads(path.read_text(encoding="utf-8"))
            packs[(pack["ecosystem"], pack["library"])] = pack
        except (OSError, ValueError, KeyError):
            continue
    return packs


def import_names(ecosystem: str, name: str, pack: Optional[dict]) -> Optional[List[str]]:
    """Names to look for in import statements, or None when the mapping is unknown."""
    if pack and pack.get("import_names"):
        return list(pack["import_names"])
    if ecosystem == "npm":
        return [name]
    if ecosystem == "python":
        return [PYTHON_ALIASES.get(name.lower(), name.replace("-", "_"))]
    return None  # Maven: a groupId is not reliably the Java package name


def read_zip(data: bytes) -> Dict[str, str]:
    """Source files from a GitHub zipball as {path: text}. Skips symlinks,
    binaries, oversized files and vendored folders."""
    files: Dict[str, str] = {}
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return files
    for info in archive.infolist():
        path = info.filename.split("/", 1)[-1]  # drop the "{repo}-{sha}/" folder
        is_symlink = (info.external_attr >> 16) & 0o170000 == 0o120000
        if info.is_dir() or is_symlink or not path.endswith(SOURCE_SUFFIXES):
            continue
        if info.file_size > settings.MAX_SOURCE_FILE_BYTES or any(part in SKIP_DIRS for part in path.split("/")[:-1]):
            continue
        raw = archive.read(info)
        if b"\x00" in raw:
            continue
        files[path] = raw.decode("utf-8", errors="replace")
    return files


def python_imports(text: str) -> List[Tuple[str, List[str], int]]:
    """(module, imported symbols, line) for each import statement."""
    found: List[Tuple[str, List[str], int]] = []
    try:
        for node in ast.walk(ast.parse(text)):
            if isinstance(node, ast.Import):
                found.extend((alias.name, [], node.lineno) for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                found.append((node.module, [alias.name for alias in node.names], node.lineno))
    except (SyntaxError, ValueError, RecursionError):
        for match in _PY_IMPORT.finditer(text):  # Python 2 or a broken file: fall back to text
            line = text.count("\n", 0, match.start()) + 1
            if match.group(1):
                found.append((match.group(1), [s.strip().split(" ")[0] for s in match.group(2).strip("() ").split(",") if s.strip()], line))
            else:
                found.extend((m.strip().split(" ")[0], [], line) for m in match.group(3).split(",") if m.strip())
    return found


def js_imports(text: str) -> List[Tuple[str, int]]:
    return [(m.group(1), text.count("\n", 0, m.start()) + 1) for m in _JS_IMPORT.finditer(text)]


def java_imports(text: str) -> List[Tuple[str, int]]:
    return [(m.group(1), text.count("\n", 0, m.start()) + 1) for m in _JAVA_IMPORT.finditer(text)]


def _file_imports(path: str, text: str, names: List[str]) -> Optional[Tuple[int, List[str]]]:
    """(first import line, symbols) if this file imports one of `names`."""
    hits: List[Tuple[int, List[str]]] = []
    if path.endswith(".py"):
        for module, symbols, line in python_imports(text):
            if any(module == n or module.startswith(n + ".") for n in names):
                hits.append((line, symbols))
    elif path.endswith(".java"):
        for imported, line in java_imports(text):
            if any(imported == n or imported.startswith(n + ".") for n in names):
                hits.append((line, [imported.rsplit(".", 1)[-1]]))
    else:
        for specifier, line in js_imports(text):
            if any(specifier == n or specifier.startswith(n + "/") for n in names):
                hits.append((line, []))
    if not hits:
        return None
    return min(line for line, _ in hits), sorted({s for _, symbols in hits for s in symbols})


def _line(text_lines: List[str], number: int) -> str:
    return text_lines[number - 1].strip()[:240] if 0 < number <= len(text_lines) else ""


def scan_repository(repo: str, files: Dict[str, str], targets: List[LibraryTarget], packs: Dict[Tuple[str, str], dict]) -> dict:
    """Returns {"items": code_impact items, "tier2": {drift_id: hit count}, "unmapped": [drift_id]}."""
    items: List[dict] = []
    tier2: Dict[str, int] = {}
    unmapped: List[str] = []

    for target in targets:
        pack = packs.get((target.ecosystem, target.name))
        names = import_names(target.ecosystem, target.name, pack)
        if names is None:
            unmapped.append(target.drift_id)
            continue

        importing: List[Tuple[str, int, List[str]]] = []
        for path, text in files.items():
            hit = _file_imports(path, text, names)
            if hit:
                importing.append((path, hit[0], hit[1]))
        if not importing:
            continue
        importing.sort()

        # Tier 1: one informational item per repository and library.
        first_path, first_line, _ = importing[0]
        symbols = sorted({s for _, _, file_symbols in importing for s in file_symbols})[:12]
        items.append({
            "repository": repo,
            "file": first_path,
            "line": first_line,
            "snippet": _line(files[first_path].splitlines(), first_line),
            "related_change": target.change,
            "dependency_name": target.name,
            "impact": (
                f"Tier 1 import map: {len(importing)} file(s) in this repository import {target.name}"
                + (f" (symbols: {', '.join(symbols)})" if symbols else "")
                + ". This shows where the library is used. It is not evidence that anything breaks."
            ),
            "confidence": "low",
            "limitations": LIMITATIONS,
        })

        # Tier 2: rule-pack names, only for the repository on the older major.
        rules = [
            (change, item)
            for change in (pack or {}).get("changes", [])
            if change.get("from_major") == target.repo_major and change.get("to_major") == target.other_major
            for item in change.get("items", [])
            if item.get("kind") in _KIND_PATTERNS
        ]
        count = 0
        for path, _, _ in importing:
            lines = files[path].splitlines()
            for change, item in rules:
                pattern = re.compile(_KIND_PATTERNS[item["kind"]].format(name=re.escape(item["name"])))
                for number, line in enumerate(lines, start=1):
                    if count >= _MAX_ITEMS_PER_LIBRARY or not pattern.search(line):
                        continue
                    verified = item.get("verified") is True
                    wording = f"{item['name']} is {item['status']} in {target.name} {change['to_major']}"
                    if item.get("replacement"):
                        wording += f"; use {item['replacement']}"
                    items.append({
                        "repository": repo,
                        "file": path,
                        "line": number,
                        "snippet": "\n".join(l.rstrip()[:240] for l in lines[number - 1: number + 2]),
                        "related_change": f"{target.change}: {wording}",
                        "dependency_name": target.name,
                        "impact": (
                            f"Tier 2 verified rule: {wording}. Source: {change.get('source_url', 'official migration guide')}"
                            if verified
                            else f"Candidate rule (not verified against official docs): {wording}"
                        ),
                        "confidence": item.get("confidence", "high") if verified else "low",
                        "limitations": LIMITATIONS,
                    })
                    count += 1
                    if verified:
                        tier2[target.drift_id] = tier2.get(target.drift_id, 0) + 1
    return {"items": items, "tier2": tier2, "unmapped": unmapped}
