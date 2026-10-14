"""Reads GitHub repositories over the REST API. Files are fetched as text
only; nothing downloaded is ever executed.

Public repositories are read anonymously or with the shared GITHUB_TOKEN. A
private repository is read only with the installation token its scan was
given (see credentials.py); without one it is refused, not read with
whatever access the shared token happens to have."""
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import quote

from app.core.config import settings
from app.core.security import manifest_kind
from app.services.http import FetchError, Http
from app.services.openapi_diff_engine import is_spec_path

API = "https://api.github.com"
RAW = "https://raw.githubusercontent.com"
CODELOAD = "https://codeload.github.com"
SKIP_DIRS = {"node_modules", "venv", ".venv", "target", "dist", "build", "vendor", ".git", "__pycache__", "site-packages"}

_SHORT_TTL = 300        # things that move: default branch, branch heads, releases
_PINNED_TTL = 30 * 86400  # content addressed by commit SHA never changes


@dataclass
class RepoFiles:
    owner: str
    repo: str
    ref: str = ""
    commit: str = ""
    subdir: str = ""
    files: Dict[str, str] = field(default_factory=dict)
    #: OpenAPI / Swagger files as {path: text}, kept apart from the manifests.
    specs: Dict[str, str] = field(default_factory=dict)
    #: {path: reason} for specification files that were found but could not be read.
    spec_errors: Dict[str, str] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)
    error: Optional[str] = None


def describe(error: FetchError, what: str, private: bool = False) -> str:
    """Why `what` could not be read. For a private repository a refusal is never worded as an empty result."""
    if private and error.kind == "not_found":
        return f"{what} could not be read with the access granted to DriftLock: GitHub answered not found. Access may have been removed"
    return {
        "unauthorized": f"GitHub refused access to {what}: the access granted to DriftLock is missing, expired or was revoked",
        "not_found": f"{what} was not found, or the repository is private",
        "rate_limit": "GitHub rate limit reached. Set GITHUB_TOKEN on the backend or retry later",
        "timeout": f"Timed out while reading {what}",
        "network": f"Network error while reading {what}",
        "too_large": f"{what} is larger than the size limit",
    }.get(error.kind, f"GitHub returned an error for {what} (HTTP {error.status})")


def _skipped(path: str) -> bool:
    return any(part in SKIP_DIRS for part in path.split("/")[:-1])


async def resolve_ref(http: Http, owner: str, repo: str, ref_path: str) -> Optional[tuple]:
    """Split `feature/x/sub/dir` into (ref, commit sha, sub-folder).

    A branch name may itself contain slashes, so the longest candidate is
    tried first and shortened until GitHub recognizes it as a ref."""
    parts = ref_path.split("/")
    for size in range(len(parts), 0, -1):
        ref = "/".join(parts[:size])
        try:
            sha = await http.get_text(
                f"{API}/repos/{owner}/{repo}/commits/{quote(ref, safe='/')}",
                headers={"Accept": "application/vnd.github.sha"},
                ttl=_SHORT_TTL,
                ignore_404_failure=True,
            )
        except FetchError as error:
            if error.kind in ("not_found", "http"):
                # A candidate that is not a ref is an expected answer, not an upstream failure.
                if error.kind != "not_found":
                    http.failures["api.github.com"] = max(0, http.failures.get("api.github.com", 1) - 1)
                continue
            raise
        return ref, sha.strip(), "/".join(parts[size:])
    return None


async def fetch_repo(http: Http, owner: str, repo: str, ref_path: Optional[str], discover_specs: bool = True) -> RepoFiles:
    """Resolve the ref, list the tree, and download every supported manifest.

    The same tree listing is reused to find OpenAPI / Swagger files, so
    discovery costs one extra request per specification file and nothing else."""
    result = RepoFiles(owner=owner, repo=repo)
    what = f"{owner}/{repo}"
    private = http.credentialed(owner, repo)
    try:
        # Anonymous requests cannot see a private repository; the shared token might. Then its visibility is checked
        # first, so a private repository is never read on the strength of the backend's own token.
        if not ref_path or (http.uses_shared_token and not private):
            info = await http.get_json(f"{API}/repos/{owner}/{repo}", ttl=_SHORT_TTL)
            if isinstance(info, dict) and info.get("private") and not private:
                result.error = (f"{what} is private. Scanning it needs Sign in with GitHub and access granted to DriftLock's GitHub App, "
                                "so it was not read")
                return result
            ref_path = ref_path or str((info if isinstance(info, dict) else {}).get("default_branch") or "main")
        resolved = await resolve_ref(http, owner, repo, ref_path)
        if resolved is None:
            result.error = f'Branch, tag or commit "{ref_path}" could not be resolved in {what}'
            return result
        result.ref, result.commit, result.subdir = resolved

        tree = await http.get_json(f"{API}/repos/{owner}/{repo}/git/trees/{result.commit}?recursive=1", ttl=_PINNED_TTL)
    except FetchError as error:
        result.error = describe(error, what, private)
        return result

    if tree.get("truncated"):
        result.warnings.append(f"{what}: the file tree is too large for one request, so some manifests may be missed")
    prefix = f"{result.subdir}/" if result.subdir else ""
    paths = sorted(
        (
            entry["path"]
            for entry in tree.get("tree", [])
            if entry.get("type") == "blob"
            and manifest_kind(entry.get("path", ""))
            and entry["path"].startswith(prefix)
            and not _skipped(entry["path"])
        ),
        key=lambda path: (path.count("/"), path),
    )
    if len(paths) > settings.MAX_MANIFESTS_PER_REPO:
        result.warnings.append(f"{what}: {len(paths)} manifests found, only the first {settings.MAX_MANIFESTS_PER_REPO} were read")
        paths = paths[: settings.MAX_MANIFESTS_PER_REPO]

    for path in paths:
        try:
            result.files[path] = await fetch_file(http, owner, repo, result.commit, path, settings.MAX_MANIFEST_BYTES, _PINNED_TTL)
        except FetchError as error:
            result.warnings.append(f"{what}: {describe(error, path, private)}")

    if discover_specs:
        spec_paths = sorted(
            (
                entry["path"]
                for entry in tree.get("tree", [])
                if entry.get("type") == "blob"
                and isinstance(entry.get("path"), str)
                and entry["path"].startswith(prefix)
                and not _skipped(entry["path"])
                and is_spec_path(entry["path"][len(prefix):])
            ),
            key=lambda path: (path.count("/"), path),
        )
        if len(spec_paths) > settings.MAX_SPECS_PER_REPO:
            result.warnings.append(f"{what}: {len(spec_paths)} OpenAPI files found, only the first {settings.MAX_SPECS_PER_REPO} were read")
            spec_paths = spec_paths[: settings.MAX_SPECS_PER_REPO]
        for path in spec_paths:
            try:
                result.specs[path] = await fetch_file(http, owner, repo, result.commit, path, settings.MAX_SPEC_BYTES, _PINNED_TTL)
            except FetchError as error:
                result.spec_errors[path] = describe(error, path, private)
                result.warnings.append(f"{what}: {describe(error, path, private)}")
    return result


async def fetch_file(
    http: Http, owner: str, repo: str, ref: str, path: str, max_bytes: int, ttl: int, ignore_404_failure: bool = False
) -> str:
    """One file as text. Uses the contents API (raw media type); if that is rate
    limited, falls back to raw.githubusercontent.com, which some networks block."""
    try:
        return await http.get_text(
            f"{API}/repos/{owner}/{repo}/contents/{quote(path, safe='/')}?ref={quote(ref, safe='')}",
            headers={"Accept": "application/vnd.github.raw+json"},
            max_bytes=max_bytes,
            ttl=ttl,
            ignore_404_failure=ignore_404_failure,
        )
    except FetchError as error:
        # raw.githubusercontent.com is a fallback for public files only.
        if error.kind != "rate_limit" or http.credentialed(owner, repo):
            raise
        try:
            return await http.get_text(
                f"{RAW}/{owner}/{repo}/{ref}/{quote(path, safe='/')}",
                max_bytes=max_bytes,
                ttl=ttl,
                ignore_404_failure=ignore_404_failure,
            )
        except FetchError:
            raise error from None


async def fetch_releases(http: Http, owner: str, repo: str) -> List[dict]:
    data = await http.get_json(f"{API}/repos/{owner}/{repo}/releases?per_page=100", ttl=6 * 3600)
    return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []


async def fetch_changelog_file(http: Http, owner: str, repo: str) -> Optional[tuple]:
    """(text, url) of a root CHANGELOG file, or None."""
    for name in ("CHANGELOG.md", "CHANGES.md", "HISTORY.md", "CHANGELOG.rst", "CHANGES.rst"):
        try:
            text = await fetch_file(http, owner, repo, "HEAD", name, settings.MAX_CHANGELOG_BYTES, 6 * 3600, ignore_404_failure=True)
            return text, f"https://github.com/{owner}/{repo}/blob/HEAD/{name}"
        except FetchError as error:
            if error.kind in ("not_found", "too_large", "http"):
                continue
            raise
    return None


async def fetch_zipball(http: Http, owner: str, repo: str, commit: str) -> bytes:
    """Source archive for one commit, held in memory and size-capped. A private
    repository's archive is requested through the API with its token; GitHub
    answers with a short-lived download link, which is followed without the token."""
    if http.credentialed(owner, repo):
        return await http.get_bytes(f"{API}/repos/{owner}/{repo}/zipball/{commit}", max_bytes=settings.MAX_ZIP_BYTES)
    return await http.get_bytes(f"{CODELOAD}/{owner}/{repo}/zip/{commit}", max_bytes=settings.MAX_ZIP_BYTES)
