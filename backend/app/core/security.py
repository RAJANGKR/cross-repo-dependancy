"""Input validation for scan targets. Nothing here touches the network."""
import os
import re
from typing import Optional, Tuple

_SEGMENT = re.compile(r"^[A-Za-z0-9._-]+$")
_PREFIX = "https://github.com/"

SUPPORTED_MANIFESTS = (
    "package.json",
    "package-lock.json",
    "requirements.txt",
    "pyproject.toml",
    "poetry.lock",
    "pom.xml",
)


class InvalidTarget(ValueError):
    """Raised for a target the API must reject with HTTP 400."""


def parse_github_url(url: str) -> Tuple[str, str, Optional[str]]:
    """Return (owner, repo, ref_path) for https://github.com/{owner}/{repo}[/tree/{ref...}].

    `ref_path` is everything after /tree/; it may contain slashes and may end
    with a sub-folder, which the fetcher disambiguates. Anything else (other
    hosts, http, /blob/, /issues, query strings) is rejected.
    """
    value = (url or "").strip()
    if not value.startswith(_PREFIX) or re.search(r"[\s?#]", value):
        raise InvalidTarget("Only https://github.com/{owner}/{repo} URLs are accepted")
    value = value.rstrip("/")
    parts = value[len(_PREFIX):].split("/")
    if len(parts) < 2:
        raise InvalidTarget("The URL must include an owner and a repository")
    owner, repo = parts[0], parts[1]
    ref_path: Optional[str] = None
    if len(parts) == 2:
        if repo.endswith(".git"):
            repo = repo[:-4]
    else:
        if parts[2] != "tree" or len(parts) < 4 or any(p == "" for p in parts[3:]):
            raise InvalidTarget("Only repository links and /tree/{branch} links are accepted")
        ref_path = "/".join(parts[3:])
    for segment in (owner, repo):
        if not _SEGMENT.match(segment) or segment in (".", ".."):
            raise InvalidTarget("The owner or repository name is not valid")
    return owner, repo, ref_path


def manifest_kind(filename: str) -> Optional[str]:
    """Canonical manifest name for a path, or None when it is not supported."""
    base = os.path.basename(filename or "").lower()
    if base in SUPPORTED_MANIFESTS:
        return base
    if "requirements" in base and base.endswith((".txt", ".in")):
        return "requirements.txt"
    return None
