"""Release-note evidence. Text fetched here is untrusted data: it is quoted,
never interpreted as instructions, and it can only raise a risk classification
through the literal-match rule in `verify_excerpt`."""
import re
from dataclasses import dataclass, field
from typing import List, Optional

from app.services import github_fetcher, range_service
from app.services.http import FetchError, Http

#: Markers that count as a stated breaking change.
BREAKING = re.compile(r"\bBREAKING\b|breaking change|\bremoved?\b|no longer", re.IGNORECASE)
#: Markers worth showing, but not proof of a break on their own.
NOTABLE = re.compile(r"deprecat|migrat", re.IGNORECASE)

_VERSION = re.compile(r"\d+\.\d+(?:\.\d+)?(?:[-.+][0-9A-Za-z.+-]+)?")
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_HEADING = re.compile(r"^\s{0,3}(?:#{1,4}\s*|v?\d+\.\d+)", re.MULTILINE)
_MAX_LINES, _MAX_LINE_CHARS = 12, 300


@dataclass
class MatchedLine:
    version: str
    line: str
    breaking: bool
    url: Optional[str]


@dataclass
class Changelog:
    #: True when release text for the compared range was actually retrieved.
    fetched: bool = False
    lines: List[MatchedLine] = field(default_factory=list)
    #: All text scanned, whitespace-normalized. The only text an excerpt can be verified against.
    text: str = ""
    error: Optional[str] = None


def normalize(text: str) -> str:
    return " ".join(_CONTROL.sub(" ", text or "").split())


def verify_excerpt(excerpt: str, fetched_text: str) -> bool:
    """True only if the excerpt appears literally in the fetched text."""
    needle = normalize(excerpt)
    return bool(needle) and needle in normalize(fetched_text)


def _clean_line(line: str) -> str:
    return normalize(re.sub(r"^\s*(?:[-*+>]|\d+\.)\s+", "", line))[:_MAX_LINE_CHARS]


def _in_range(eco: str, version: str, older: str, newer: str) -> bool:
    v, low, high = (range_service.parse_version(eco, x) for x in (version, older, newer))
    return v is not None and low is not None and high is not None and low < v <= high


def _scan(result: Changelog, version: str, body: str, url: Optional[str]) -> None:
    result.text += " " + normalize(body)
    for raw in body.splitlines():
        if len(result.lines) >= _MAX_LINES:
            return
        line = _clean_line(raw)
        if len(line) < 8:
            continue
        breaking = bool(BREAKING.search(line))
        if breaking or NOTABLE.search(line):
            result.lines.append(MatchedLine(version, line, breaking, url if url and url.startswith("https://") else None))


def _sections(text: str):
    """Split a CHANGELOG file into (version, body) by its version headings."""
    starts = [m.start() for m in _HEADING.finditer(text)]
    for index, start in enumerate(starts):
        chunk = text[start: starts[index + 1] if index + 1 < len(starts) else len(text)]
        heading, _, body = chunk.partition("\n")
        match = _VERSION.search(heading)
        if match:
            yield match.group(0), body


async def collect(http: Http, owner: str, repo: str, eco: str, older: str, newer: str) -> Changelog:
    """Release notes for versions in (older, newer], from GitHub Releases or a CHANGELOG file."""
    result = Changelog()
    try:
        for release in await github_fetcher.fetch_releases(http, owner, repo):
            versions = _VERSION.findall(str(release.get("tag_name") or ""))
            if versions and _in_range(eco, versions[-1], older, newer) and release.get("body"):
                result.fetched = True
                _scan(result, versions[-1], str(release["body"]), release.get("html_url"))
        if not result.fetched:
            found = await github_fetcher.fetch_changelog_file(http, owner, repo)
            if found:
                text, url = found
                for version, body in _sections(text):
                    if _in_range(eco, version, older, newer):
                        result.fetched = True
                        _scan(result, version, body, url)
    except FetchError as error:
        result.error = f"release notes could not be fetched ({error.kind})"
    result.text = result.text.strip()
    return result


def to_evidence(changelog: Changelog) -> Optional[dict]:
    """The frontend's evidence object: one literal line, and whether it is a verified break."""
    if not changelog.lines:
        return None
    best = next((line for line in changelog.lines if line.breaking), changelog.lines[0])
    return {
        "source_url": best.url,
        "cited_excerpt": best.line,
        "verified_breaking": best.breaking and verify_excerpt(best.line, changelog.text),
        "notes": "",
    }
