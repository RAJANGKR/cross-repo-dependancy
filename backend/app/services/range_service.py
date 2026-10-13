"""Version and range logic for npm, Python and Maven.

Every function answers `None` when it cannot know. Nothing here guesses: an
unparseable range or a missing version list is "unknown", never True or False.
npm ranges use semantic_version.NpmSpec, Python uses packaging (PEP 440), and
Maven supports exact versions and simple bracket ranges only.
"""
import re
from typing import Any, Iterable, List, Optional

from packaging.specifiers import InvalidSpecifier, SpecifierSet
from packaging.version import InvalidVersion, Version as PyVersion
from semantic_version import NpmSpec, Version as SemVer

NPM, PYTHON, MAVEN = "npm", "python", "maven"

_NPM_NON_REGISTRY = ("git", "http:", "https:", "file:", "link:", "workspace:", "npm:", "github:", "portal:", "patch:")
_NUMERIC_PREFIX = re.compile(r"^v?(\d+(?:\.\d+)*)")


def unsupported_reason(eco: str, spec: str) -> Optional[str]:
    """Why a declared spec cannot be compared, or None when it can."""
    text = (spec or "").strip()
    if eco == MAVEN:
        if not text:
            return "version not declared in this pom.xml (inherited or managed elsewhere)"
        return "unresolved ${property}" if "${" in text else None
    if text in ("", "*", "x", "X", "latest"):
        return "unpinned spec"
    if eco == NPM:
        if text.startswith(_NPM_NON_REGISTRY) or ("/" in text and not text[0].isdigit()):
            return "unsupported spec (not a registry version)"
        if re.fullmatch(r"[A-Za-z][A-Za-z-]*", text):
            return "dist-tag, not a version range"
    elif "@" in text or "://" in text:
        return "unsupported spec (not a registry version)"
    return None


def parse_version(eco: str, text: str) -> Any:
    """A comparable version object, or None."""
    value = (text or "").strip().lstrip("=").strip()
    if not value:
        return None
    try:
        if eco == NPM:
            value = value[1:] if value[:1] == "v" else value
            return SemVer(value) if value.count(".") >= 2 else SemVer.coerce(value) if re.fullmatch(r"\d+(\.\d+)?", value) else None
        return PyVersion(value)
    except (ValueError, InvalidVersion):
        if eco == MAVEN:  # e.g. "31.1-jre": compare on the numeric part
            match = _NUMERIC_PREFIX.match(value)
            return PyVersion(match.group(1)) if match else None
        return None


def _release(eco: str, version: Any) -> tuple:
    if eco == NPM:
        return (version.major, version.minor, version.patch)
    return tuple(list(version.release) + [0, 0, 0])[:3]


def is_stable(eco: str, version: Any) -> bool:
    return not version.prerelease if eco == NPM else not (version.is_prerelease or version.is_devrelease)


def _python_spec(spec: str) -> Optional[SpecifierSet]:
    """PEP 440 specifier set; also accepts Poetry's caret, tilde and bare versions."""
    clauses = []
    for clause in (c.strip() for c in spec.split(",")):
        if not clause:
            continue
        if clause[0] in "^~" and not clause.startswith("~="):
            version = parse_version(PYTHON, clause[1:])
            if version is None:
                return None
            parts = list(version.release)
            if clause[0] == "^":
                index = next((i for i, n in enumerate(parts) if n != 0), len(parts) - 1)
            else:
                index = 0 if len(parts) == 1 else 1
            upper = parts[:index] + [parts[index] + 1]
            clauses.append(f">={clause[1:].strip()},<{'.'.join(map(str, upper))}")
        elif clause[0].isdigit():
            clauses.append(f"=={clause}")
        else:
            clauses.append(clause)
    try:
        return SpecifierSet(",".join(clauses))
    except InvalidSpecifier:
        return None


def _maven_matches(spec: str, version: Any) -> Optional[bool]:
    text = spec.strip()
    if text[:1] in "[(" and text[-1:] in "])":
        bounds = [b.strip() for b in text[1:-1].split(",")]
        if len(bounds) == 1:
            pin = parse_version(MAVEN, bounds[0])
            return None if pin is None else version == pin
        if len(bounds) != 2:
            return None
        low = parse_version(MAVEN, bounds[0]) if bounds[0] else None
        high = parse_version(MAVEN, bounds[1]) if bounds[1] else None
        if (bounds[0] and low is None) or (bounds[1] and high is None):
            return None
        if low is not None and (version < low or (version == low and text[0] == "(")):
            return False
        if high is not None and (version > high or (version == high and text[-1] == ")")):
            return False
        return True
    pin = parse_version(MAVEN, text)
    return None if pin is None else version == pin


def satisfies(eco: str, spec: str, version_text: str) -> Optional[bool]:
    version = parse_version(eco, version_text)
    if version is None or unsupported_reason(eco, spec):
        return None
    try:
        if eco == NPM:
            return NpmSpec(spec.strip()).match(version)
        if eco == PYTHON:
            specifier = _python_spec(spec)
            return None if specifier is None else specifier.contains(version, prereleases=True)
        return _maven_matches(spec, version)
    except ValueError:
        return None


def exact_pin(eco: str, spec: str) -> Optional[str]:
    """The version a spec pins exactly ("1.2.3", "==1.2.3", "[1.2.3]"), else None."""
    text = (spec or "").strip()
    if eco == PYTHON:
        match = re.fullmatch(r"={2,3}\s*([^,*\s]+)", text)
        text = match.group(1) if match else (text if text[:1].isdigit() and "," not in text else "")
    elif eco == MAVEN:
        match = re.fullmatch(r"\[\s*([^,\]]+)\s*\]", text)
        text = match.group(1) if match else text
        if text[:1] in "[(":
            return None
    else:
        text = text.lstrip("=").strip()
        if not re.fullmatch(r"v?\d+\.\d+\.\d+[0-9A-Za-z.+-]*", text):
            return None
    return text if text and parse_version(eco, text) is not None else None


def sort_versions(eco: str, versions: Iterable[str]) -> List[str]:
    """Parseable versions, lowest first."""
    parsed = [(parse_version(eco, v), v) for v in versions]
    return [text for version, text in sorted(((p, t) for p, t in parsed if p is not None), key=lambda item: item[0])]


def resolve(eco: str, spec: str, available: Iterable[str]) -> Optional[str]:
    """Highest stable version satisfying `spec`; a prerelease only if nothing stable fits."""
    matching = [v for v in sort_versions(eco, available) if satisfies(eco, spec, v)]
    if not matching:
        return None
    stable = [v for v in matching if is_stable(eco, parse_version(eco, v))]
    return (stable or matching)[-1]


def ranges_overlap(eco: str, a: str, b: str, available: Iterable[str]) -> Optional[bool]:
    """True if some available version satisfies both ranges. None when unknown."""
    versions = list(available)
    if not versions:
        return None
    found = False
    for version in versions:
        in_a, in_b = satisfies(eco, a, version), satisfies(eco, b, version)
        if in_a is None or in_b is None:
            if parse_version(eco, version) is None:
                continue
            return None
        found = found or (in_a and in_b)
    return found


def gap(eco: str, first: str, second: str) -> str:
    """major | minor | patch | none | unknown. A 0.x minor change counts as major."""
    a, b = parse_version(eco, first), parse_version(eco, second)
    if a is None or b is None:
        return "unknown"
    ra, rb = _release(eco, a), _release(eco, b)
    if ra[0] != rb[0]:
        return "major"
    if ra[1] != rb[1]:
        return "major" if ra[0] == 0 else "minor"
    if ra[2] != rb[2]:
        return "patch"
    return "none" if a == b else "patch"


def major_of(eco: str, version_text: str) -> Optional[int]:
    version = parse_version(eco, version_text)
    return None if version is None else _release(eco, version)[0]
