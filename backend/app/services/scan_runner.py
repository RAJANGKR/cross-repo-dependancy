"""Runs one scan through its stages: FETCHING, PARSING, ANALYZING, then
COMPLETED or FAILED. A failing repository or upstream service degrades the
result (warning, lower confidence) instead of failing the scan; the scan only
fails when no repository could be analyzed at all."""
import asyncio
import json
import logging
import os
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from packaging.utils import canonicalize_name

from app.core.config import settings
from app.core.security import InvalidTarget, manifest_kind, parse_github_url
from app.parsers.lockfiles import LOCK_ECOSYSTEM, is_lockfile, parse_lockfile
from app.parsers.registry import default_registry
from app.schemas.scan import ScanCreateRequest, ScanOptions
from app.services import changelog_service, explain, github_fetcher, graph_service, osv_client, usage_scanner
from app.services import range_service as ranges
from app.services.cache import Cache
from app.services.classifier import Classification, Declaration, classify
from app.services.http import FetchError, Http
from app.services.registry_client import PackageInfo, package_info
from app.services.scan_store import ScanStore
from app.services.scoring import score_drift

logger = logging.getLogger("driftlock.scan")

ECOSYSTEMS = ("npm", "python", "maven")
_DISPARITY_RANK = {"MAJOR_DRIFT": 0, "MINOR_DRIFT": 1, "INFO": 2, "IN_SYNC": 3}
_RISK_RANK = {"CONFIRMED_BREAKING": 0, "SUSPECTED_BREAKING": 1, "UNKNOWN_IMPACT": 2, "NONE": 3}
_REQ_SKIP = re.compile(r"^\s*(-e\s|--editable|git\+|hg\+|svn\+|https?://|\.{0,2}/|file:)|\s@\s", re.IGNORECASE)
_HOSTS = {
    "GitHub": ("api.github.com", "raw.githubusercontent.com", "codeload.github.com"),
    "npm registry": ("registry.npmjs.org",),
    "PyPI": ("pypi.org",),
    "Maven Central": ("repo1.maven.org",),
    "OSV": ("api.osv.dev",),
    "Gemini": ("generativelanguage.googleapis.com",),
}

_cache: Optional[Cache] = None


def shared_cache() -> Optional[Cache]:
    global _cache
    if _cache is None and settings.CACHE_ENABLED:
        _cache = Cache(settings.CACHE_PATH)
    return _cache


@dataclass
class Target:
    """A validated scan target."""

    kind: str  # "github" | "pasted"
    name: str
    url: Optional[str] = None
    owner: str = ""
    repo: str = ""
    ref_path: Optional[str] = None
    files: Dict[str, str] = field(default_factory=dict)
    # Filled while fetching:
    ref: str = ""
    commit: str = ""
    subdir: str = ""
    error: Optional[str] = None
    code_scanned: bool = False


def validate_request(request: ScanCreateRequest) -> List[Target]:
    """Turn the request into targets, or raise InvalidTarget (HTTP 400)."""
    count = len(request.repository_targets)
    if not settings.MIN_TARGETS <= count <= settings.MAX_TARGETS:
        raise InvalidTarget(f"A scan must contain between {settings.MIN_TARGETS} and {settings.MAX_TARGETS} repository targets.")
    targets: List[Target] = []
    seen = set()
    for index, raw in enumerate(request.repository_targets, start=1):
        if raw.type == "pasted":
            name = (raw.name or "").strip()
            if not name or len(name) > 100:
                raise InvalidTarget(f"Target {index}: a pasted project needs a name of 1 to 100 characters.")
            if not raw.files:
                raise InvalidTarget(f'Target {index} ("{name}"): add at least one manifest file.')
            files: Dict[str, str] = {}
            for item in raw.files:
                if manifest_kind(item.filename) is None:
                    raise InvalidTarget(f'Target {index} ("{name}"): "{item.filename[:60]}" is not a supported manifest.')
                if len(item.content.encode("utf-8")) > settings.MAX_PASTED_FILE_BYTES:
                    raise InvalidTarget(f'Target {index} ("{name}"): {item.filename} is over the 200 KB limit.')
                files[item.filename] = item.content
            target = Target(kind="pasted", name=name, files=files)
            identity = f"pasted:{name.lower()}"
        else:
            try:
                owner, repo, url_ref = parse_github_url(raw.url or "")
            except InvalidTarget as error:
                raise InvalidTarget(f"Target {index}: {error}") from error
            ref_path = url_ref or ((raw.ref or "").strip().strip("/") or None)
            target = Target(kind="github", name=repo, url=f"https://github.com/{owner}/{repo}", owner=owner, repo=repo, ref_path=ref_path)
            identity = f"github:{owner}/{repo}@{ref_path or ''}".lower()
        if identity in seen:
            raise InvalidTarget(f"Target {index} is listed more than once.")
        seen.add(identity)
        targets.append(target)

    # Results are keyed by repository name, so names must be unique.
    for attempt in (lambda t: f"{t.owner}/{t.repo}", lambda t: f"{t.owner}/{t.repo}@{t.ref_path or 'default'}"):
        counts = Counter(t.name.lower() for t in targets)
        for target in targets:
            if counts[target.name.lower()] > 1 and target.kind == "github":
                target.name = attempt(target)
    if len({t.name.lower() for t in targets}) != len(targets):
        raise InvalidTarget("Two targets resolve to the same name. Rename one of the pasted projects.")
    return targets


def parse_target(target: Target, ecosystems: List[str]) -> Tuple[Dict[Tuple[str, str], Declaration], List[str], int]:
    """Declared ranges and lockfile pins for one target, kept separate."""
    declared: Dict[Tuple[str, str], Declaration] = {}
    skipped: List[str] = []
    ordered = sorted(target.files, key=lambda path: (path.count("/"), path))

    pins: Dict[Tuple[str, str], Dict[str, str]] = {}
    for path in ordered:
        if is_lockfile(path):
            pins[(os.path.dirname(path), LOCK_ECOSYSTEM[os.path.basename(path).lower()])] = parse_lockfile(path, target.files[path])

    manifests = 0
    for path in ordered:
        content = target.files[path]
        if manifest_kind(path) is None:
            continue
        manifests += 1
        if is_lockfile(path):
            continue
        if os.path.basename(path).lower() == "package.json":
            try:
                json.loads(content)
            except ValueError:
                skipped.append(f"{target.name}/{path}: not valid JSON, so it was not read")
                continue
        if manifest_kind(path) == "requirements.txt":
            for line in content.splitlines():
                text = line.split(" #", 1)[0].strip()
                if text and not text.startswith("#") and _REQ_SKIP.search(text):
                    skipped.append(f"{target.name}/{path}: {text[:80]} (unsupported spec)")
        for item in default_registry.parse_file(path, content):
            eco = item.ecosystem.value
            if eco not in ecosystems:
                continue
            reason = ranges.unsupported_reason(eco, item.version_spec)
            if reason:
                skipped.append(f"{target.name}/{path}: {item.name} {item.version_spec or '(no version)'} ({reason})")
                continue
            key = (eco, item.name)
            if key in declared:
                continue  # the shallowest manifest wins
            lock = pins.get((os.path.dirname(path), eco), {})
            resolved = lock.get(item.name) or (lock.get(canonicalize_name(item.name)) if eco == "python" else None)
            declared[key] = Declaration(target.name, item.version_spec, resolved, item.dep_type.value, path)
    return declared, skipped, manifests


@dataclass
class _Lib:
    eco: str
    name: str
    declarations: List[Declaration]
    info: PackageInfo = field(default_factory=PackageInfo)
    cls: Optional[Classification] = None

    @property
    def id(self) -> str:
        return f"{self.eco}:{self.name}"


def _row(lib: _Lib, all_repos: List[str]) -> dict:
    cls = lib.cls
    present = [d.repo for d in lib.declarations]
    return {
        "id": lib.id,
        "dependency_name": lib.name,
        "ecosystem": lib.eco,
        "drift_disparity": cls.drift_disparity,
        "compatibility_risk": cls.compatibility_risk,
        "declarations_by_repo": {
            d.repo: {
                "declared_range": d.declared_range,
                "resolved_version": d.resolved_version,
                "dep_type": d.dep_type,
                "source_file": d.source_file,
            }
            for d in lib.declarations
        },
        "present_in_repos": present,
        "missing_in_repos": [repo for repo in all_repos if repo not in present],
        "recommended_version": cls.recommended_version if cls.drifted else None,
        "evidence": None,
    }


async def run_scan(scan_id: str, targets: List[Target], options: ScanOptions, store: ScanStore, http: Optional[Http] = None) -> None:
    owns_http = http is None
    http = http or Http(cache=shared_cache(), github_token=settings.GITHUB_TOKEN, timeout=settings.HTTP_TIMEOUT_SECONDS, retries=settings.HTTP_RETRIES)
    try:
        await _run(scan_id, targets, options, store, http)
    except Exception:  # last line of defense: a scan must always reach a terminal status
        logger.exception("Scan %s failed unexpectedly", scan_id)
        store.fail(scan_id, "SCAN_FAILED", "Unexpected failure during analysis.")
    finally:
        if owns_http:
            await http.aclose()


async def _run(scan_id: str, targets: List[Target], options: ScanOptions, store: ScanStore, http: Http) -> None:
    warnings: List[str] = []
    skipped: List[str] = []
    ecosystems = [eco for eco in options.ecosystems if eco in ECOSYSTEMS] or list(ECOSYSTEMS)

    # ---- FETCHING ----------------------------------------------------------
    github_targets = [t for t in targets if t.kind == "github"]
    store.progress(scan_id, "FETCHING", 10, f"Fetching manifests from {len(github_targets)} GitHub repositories" if github_targets else "Reading pasted manifests")
    repo_gate = asyncio.Semaphore(settings.REPO_CONCURRENCY)

    async def fetch(target: Target) -> None:
        async with repo_gate:
            fetched = await github_fetcher.fetch_repo(http, target.owner, target.repo, target.ref_path)
        target.ref, target.commit, target.subdir, target.error = fetched.ref, fetched.commit, fetched.subdir, fetched.error
        target.files = fetched.files
        warnings.extend(fetched.warnings)

    await asyncio.gather(*(fetch(target) for target in github_targets))

    # ---- PARSING -----------------------------------------------------------
    store.progress(scan_id, "PARSING", 40, "Parsing manifests and lockfiles")
    libs: Dict[Tuple[str, str], _Lib] = {}
    repositories: List[dict] = []
    analyzed: List[Target] = []
    for target in targets:
        if target.error:
            warnings.append(f"{target.name}: {target.error}. It was skipped; the other repositories were analyzed.")
            repositories.append({"name": target.name, "url": target.url, "manifest_count": 0, "total_dependencies": 0})
            continue
        declared, target_skipped, manifests = parse_target(target, ecosystems)
        skipped.extend(target_skipped)
        repositories.append({"name": target.name, "url": target.url, "manifest_count": manifests, "total_dependencies": len(declared)})
        if manifests == 0:
            warnings.append(f"{target.name}: no supported manifest found (package.json, requirements.txt, pyproject.toml, pom.xml).")
            continue
        if target.kind == "pasted":
            warnings.append(f"{target.name}: pasted input, so there is no code scan and resolved versions exist only if a lockfile was pasted.")
        analyzed.append(target)
        for key, declaration in declared.items():
            libs.setdefault(key, _Lib(key[0], key[1], [])).declarations.append(declaration)

    if not analyzed:
        reason = next((t.error for t in targets if t.error), "No supported manifest was found in any repository")
        code = "RATE_LIMIT_EXCEEDED" if "rate limit" in reason.lower() else "NO_REPOSITORIES_ANALYZED"
        store.fail(scan_id, code, f"No repository could be analyzed. {reason}.")
        return

    all_repos = [t.name for t in targets]
    total = len(all_repos)

    # ---- ANALYZING ---------------------------------------------------------
    store.progress(scan_id, "ANALYZING", 55, "Comparing versions across repositories")
    lib_gate = asyncio.Semaphore(settings.LIBRARY_CONCURRENCY)

    async def first_pass(lib: _Lib) -> None:
        differs = len({d.declared_range for d in lib.declarations}) > 1 or len({d.resolved_version for d in lib.declarations}) > 1
        if len(lib.declarations) > 1 and differs:
            async with lib_gate:
                lib.info = await package_info(http, lib.eco, lib.name)
            if not lib.info.found and not lib.info.error:
                skipped.append(f"{lib.name}: not found in public registry")
        lib.cls = classify(lib.eco, lib.declarations, total, lib.info.versions)

    await asyncio.gather(*(first_pass(lib) for lib in libs.values()))
    drifted = [lib for lib in libs.values() if lib.cls.drifted]

    # Code-usage scan: GitHub targets only, and only for drifted libraries.
    code_impact: Optional[List[dict]] = None
    tier2: Dict[str, int] = {}
    unmapped: set = set()
    if options.scan_code and drifted:
        store.progress(scan_id, "ANALYZING", 70, "Scanning source code for affected usages")
        packs = usage_scanner.load_rule_packs()

        async def scan(target: Target) -> List[dict]:
            wanted = []
            for lib in drifted:
                mine = lib.cls.effective.get(target.name)
                if target.name not in lib.cls.effective:
                    continue
                others = [ranges.major_of(lib.eco, v) for repo, v in lib.cls.effective.items() if repo != target.name and v]
                span = lib.cls.low_and_high
                wanted.append(usage_scanner.LibraryTarget(
                    lib.id, lib.eco, lib.name,
                    ranges.major_of(lib.eco, mine) if mine else None,
                    max((m for m in others if m is not None), default=None),
                    f"{lib.name} {span[0]} to {span[1]}" if span else f"{lib.name} version drift",
                ))
            if not wanted:
                target.code_scanned = True
                return []
            try:
                async with repo_gate:
                    archive = await github_fetcher.fetch_zipball(http, target.owner, target.repo, target.commit)
            except FetchError as error:
                warnings.append(f"{target.name}: code scan skipped ({github_fetcher.describe(error, 'the source archive')}).")
                return []
            def work() -> dict:
                files = usage_scanner.read_zip(archive)
                if target.subdir:  # a /tree/{ref}/{folder} target only covers that folder
                    files = {path: text for path, text in files.items() if path.startswith(target.subdir + "/")}
                return usage_scanner.scan_repository(target.name, files, wanted, packs)

            found = await asyncio.to_thread(work)
            target.code_scanned = True
            for drift_id, hits in found["tier2"].items():
                tier2[drift_id] = tier2.get(drift_id, 0) + hits
            unmapped.update(found["unmapped"])
            return found["items"]

        scannable = [t for t in analyzed if t.kind == "github" and t.commit]
        if scannable:
            code_impact = [item for items in await asyncio.gather(*(scan(t) for t in scannable)) for item in items]

    store.progress(scan_id, "ANALYZING", 85, f"Checking release notes and vulnerabilities for {len(drifted)} drifted packages")
    scanned_names = {t.name for t in analyzed if t.code_scanned}
    extras: Dict[str, dict] = {}

    async def finalize(lib: _Lib) -> None:
        cls = lib.cls
        missing = list(cls.signals_missing)
        span = cls.low_and_high

        vulnerabilities: List[dict] = []
        if options.check_vulnerabilities:
            looked_up = True
            for version in sorted({v for v in cls.effective.values() if v}):
                async with lib_gate:
                    found = await osv_client.query(http, lib.eco, lib.name, version)
                if found is None:
                    looked_up = False
                    continue
                for repo, effective in cls.effective.items():
                    if effective == version:
                        vulnerabilities.extend({**vuln, "affects_repo": repo} for vuln in found)
            if not looked_up or not any(cls.effective.values()):
                missing.append("vulnerabilities")
        else:
            missing.append("vulnerabilities")

        changelog = changelog_service.Changelog()
        if options.check_changelogs and lib.info.upstream and span and span[0] != span[1]:
            async with lib_gate:
                changelog = await changelog_service.collect(http, lib.info.upstream[0], lib.info.upstream[1], lib.eco, span[0], span[1])
        if not changelog.fetched:
            missing.append("changelog")
        evidence = changelog_service.to_evidence(changelog)

        involved = [d.repo for d in lib.declarations]
        if code_impact is None or any(repo not in scanned_names for repo in involved):
            missing.append("code_scan")
        if lib.id in unmapped:
            missing.append("import_mapping")

        hits = tier2.get(lib.id, 0)
        lib.cls = cls = classify(lib.eco, lib.declarations, total, lib.info.versions,
                                 verified_breaking=bool(evidence and evidence["verified_breaking"]), tier2_hit=hits > 0)
        score = score_drift(
            gap=cls.gap, overlap=cls.overlap, breaking_marker=any(line.breaking for line in changelog.lines),
            vulnerable=bool(vulnerabilities), repo_count=len(involved), tier2_hits=hits, signals_missing=missing,
        )
        versions = [v for v in cls.effective.values() if v]
        explanation = explain.template(lib.name, versions, cls.gap, cls.compatibility_risk, cls.recommended_version)
        if changelog.fetched and not changelog.lines:
            explanation["text"] += " Release notes for these versions were read and no breaking marker was found."
        if evidence and score.level != "Low":
            async with lib_gate:
                notes = await explain.ai_notes(http, lib.name, versions, [item["signal"] for item in score.breakdown], [line.line for line in changelog.lines])
            if notes:
                evidence["notes"] = notes
                explanation = {"text": notes, "source": "ai"}
        extras[lib.id] = {
            "evidence": evidence,
            "score": score.score,
            "risk_level": score.level,
            "breakdown": score.breakdown,
            "confidence": score.confidence,
            "signals_missing": score.signals_missing,
            "vulnerabilities": vulnerabilities,
            "explanation": explanation,
        }

    await asyncio.gather(*(finalize(lib) for lib in drifted))

    rows = []
    for lib in libs.values():
        row = _row(lib, all_repos)
        row.update(extras.get(lib.id, {}))
        rows.append(row)
    rows.sort(key=lambda r: (_DISPARITY_RANK.get(r["drift_disparity"], 9), _RISK_RANK.get(r["compatibility_risk"], 9), r["dependency_name"]))

    severity = Counter(row["drift_disparity"] for row in rows)
    risk = Counter(row["compatibility_risk"] for row in rows)
    if http.used_stale_cache:
        warnings.append("Some upstream requests failed, so older cached data was used for them.")
    if any(lib.info.error for lib in libs.values()):
        failed = sorted(lib.name for lib in libs.values() if lib.info.error)
        warnings.append(f"Registry lookup failed for {len(failed)} package(s): {', '.join(failed[:8])}. They were compared on declared versions only.")
    if http.rate_limit_remaining is not None and http.rate_limit_remaining < 10:
        warnings.append(f"GitHub rate limit is low ({http.rate_limit_remaining} requests left). Set GITHUB_TOKEN on the backend to raise it.")
    gemini_failures = http.failures.get("generativelanguage.googleapis.com", 0)
    gemini_calls = http.calls.get("generativelanguage.googleapis.com", 0)
    if settings.GEMINI_API_KEY and gemini_calls > 0 and gemini_failures >= gemini_calls:
        warnings.append("Gemini API request failed; falling back to deterministic explanation templates.")

    def source(name: str) -> dict:
        hosts = _HOSTS[name]
        calls = sum(http.calls.get(host, 0) for host in hosts)
        failures = sum(http.failures.get(host, 0) for host in hosts)
        if name == "Gemini" and not settings.GEMINI_API_KEY:
            return {"name": name, "status": "not_configured"}
        status = "not_used" if calls == 0 else "ok" if failures == 0 else "failed" if failures >= calls else "degraded"
        return {"name": name, "status": status}

    store.complete(scan_id, {
        "scanned_repositories": repositories,
        "summary": {
            "total_unique_dependencies": len(rows),
            "shared_dependencies_count": sum(1 for row in rows if len(row["present_in_repos"]) > 1),
            "drift_count": severity["MAJOR_DRIFT"] + severity["MINOR_DRIFT"],
            "in_sync_count": severity["IN_SYNC"],
            "severity_counts": {key: severity.get(key, 0) for key in ("MAJOR_DRIFT", "MINOR_DRIFT", "INFO", "IN_SYNC")},
            "compatibility_risk_counts": {key: risk.get(key, 0) for key in ("CONFIRMED_BREAKING", "SUSPECTED_BREAKING", "UNKNOWN_IMPACT", "NONE")},
        },
        "drift_matrix": rows,
        "graph_summary": graph_service.summarize(rows),
        "warnings": list(dict.fromkeys(warnings)),
        "skipped_items": list(dict.fromkeys(skipped)),
        "contract_analysis": None,
        "code_impact": code_impact,
        "data_sources": [source(name) for name in _HOSTS],
        "repository_details": [
            {"name": t.name, "kind": t.kind, "ref": t.ref or None, "commit": t.commit or None,
             "manifests": sorted(p for p in t.files if manifest_kind(p)), "code_scanned": t.code_scanned, "error": t.error}
            for t in targets
        ],
    })
