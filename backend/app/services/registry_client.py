"""Public package registries: npm, PyPI and Maven Central."""
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
from urllib.parse import quote

from app.core.config import settings
from app.services.http import FetchError, Http

_GITHUB = re.compile(r"github\.com[:/]+([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$")
_PREFERRED_URL_KEYS = ("source", "repository", "code", "github", "changelog", "homepage", "home")


@dataclass
class PackageInfo:
    found: bool = False
    versions: List[str] = field(default_factory=list)
    #: (owner, repo) of the upstream GitHub repository, when the registry names one.
    upstream: Optional[Tuple[str, str]] = None
    #: Set when the lookup failed for a reason other than "not found".
    error: Optional[str] = None


def github_repo(url: object) -> Optional[Tuple[str, str]]:
    match = _GITHUB.search(url.strip()) if isinstance(url, str) else None
    return (match.group(1), match.group(2)) if match else None


async def _npm(http: Http, name: str) -> PackageInfo:
    data = await http.get_json(f"https://registry.npmjs.org/{quote(name, safe='@')}", max_bytes=40_000_000, ttl=settings.CACHE_TTL_SECONDS)
    versions = [v for v, meta in (data.get("versions") or {}).items() if not (isinstance(meta, dict) and meta.get("deprecated"))]
    repository = data.get("repository")
    url = repository.get("url") if isinstance(repository, dict) else repository
    return PackageInfo(found=True, versions=versions or list(data.get("versions") or {}), upstream=github_repo(url))


async def _pypi(http: Http, name: str) -> PackageInfo:
    data = await http.get_json(f"https://pypi.org/pypi/{quote(name)}/json", ttl=settings.CACHE_TTL_SECONDS)
    releases = data.get("releases") or {}
    versions = [v for v, files in releases.items() if files and not all(f.get("yanked") for f in files if isinstance(f, dict))]
    info = data.get("info") or {}
    urls = {str(k).lower(): v for k, v in (info.get("project_urls") or {}).items()}
    ordered = [v for key in _PREFERRED_URL_KEYS for k, v in urls.items() if key in k] + list(urls.values()) + [info.get("home_page")]
    upstream = next((repo for repo in (github_repo(u) for u in ordered) if repo), None)
    return PackageInfo(found=True, versions=versions, upstream=upstream)


async def _maven(http: Http, name: str) -> PackageInfo:
    group, _, artifact = name.partition(":")
    if not group or not artifact:
        return PackageInfo(error="not a groupId:artifactId coordinate")
    text = await http.get_text(
        f"https://repo1.maven.org/maven2/{group.replace('.', '/')}/{quote(artifact)}/maven-metadata.xml",
        ttl=settings.CACHE_TTL_SECONDS,
    )
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return PackageInfo(error="registry response could not be read")
    return PackageInfo(found=True, versions=[v.text.strip() for v in root.iter("version") if v.text])


_CLIENTS = {"npm": _npm, "python": _pypi, "maven": _maven}


async def package_info(http: Http, ecosystem: str, name: str) -> PackageInfo:
    """Version list and upstream repository for one package. Never raises."""
    client = _CLIENTS.get(ecosystem)
    if client is None:
        return PackageInfo(error="unsupported ecosystem")
    try:
        return await client(http, name)
    except FetchError as error:
        return PackageInfo() if error.kind == "not_found" else PackageInfo(error=f"registry lookup failed ({error.kind})")
    except (AttributeError, TypeError, ValueError):
        return PackageInfo(error="registry response could not be read")
