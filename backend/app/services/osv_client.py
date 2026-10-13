"""Known vulnerabilities from OSV.dev (POST /v1/query), one exact version at a time."""
from typing import List, Optional

from app.core.config import settings
from app.services.http import FetchError, Http

OSV_URL = "https://api.osv.dev/v1/query"
#: OSV's own ecosystem names. Maven packages are named "groupId:artifactId".
OSV_ECOSYSTEMS = {"npm": "npm", "python": "PyPI", "maven": "Maven"}


def _fixed_in(vuln: dict) -> Optional[str]:
    for affected in vuln.get("affected") or []:
        for rng in affected.get("ranges") or []:
            for event in rng.get("events") or []:
                if isinstance(event, dict) and event.get("fixed"):
                    return str(event["fixed"])
    return None


async def query(http: Http, ecosystem: str, name: str, version: str) -> Optional[List[dict]]:
    """Vulnerabilities affecting exactly `version`. None means the lookup failed,
    which is different from an empty list (looked up, nothing known)."""
    osv_ecosystem = OSV_ECOSYSTEMS.get(ecosystem)
    if not osv_ecosystem or not version:
        return None
    try:
        data = await http.post_json(
            OSV_URL,
            {"version": version, "package": {"name": name, "ecosystem": osv_ecosystem}},
            ttl=settings.CACHE_TTL_SECONDS,
        )
    except FetchError:
        return None
    if not isinstance(data, dict):
        return None
    return [
        {
            "id": str(vuln.get("id", "")),
            "summary": " ".join(str(vuln.get("summary") or "").split())[:300],
            "fixed_in": _fixed_in(vuln),
        }
        for vuln in data.get("vulns") or []
        if isinstance(vuln, dict) and vuln.get("id")
    ]
