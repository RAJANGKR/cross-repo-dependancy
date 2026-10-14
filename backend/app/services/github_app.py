"""DriftLock's GitHub App: who may read which repositories.

Two kinds of credential are involved, and both stay on the backend:

- the signed-in user's access token, from the OAuth exchange. It lists the
  installations and repositories the user can use with the App, and proves
  that the user can see a repository before it is scanned;
- installation access tokens, minted with the App's private key for one
  installation and narrowed to the repositories of one scan. They read those
  repositories during that scan and expire after an hour at most.

Every endpoint used here is part of GitHub's REST API for GitHub Apps:
GET /user/installations, GET /user/installations/{id}/repositories,
GET /repos/{owner}/{repo}, GET /repos/{owner}/{repo}/installation and
POST /app/installations/{id}/access_tokens."""
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import jwt

from app.core.config import settings
from app.services.http import FetchError, Http

API = "https://api.github.com"
TOKEN_URL = "https://github.com/login/oauth/access_token"
#: What a scan needs: the file tree, files and archives (contents) and repository facts (metadata).
SCAN_PERMISSIONS = {"contents": "read", "metadata": "read"}
_API_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}

_app_jwt: Tuple[str, float] = ("", 0.0)


class AccessProblem(Exception):
    """A request about repository access that cannot go on, with the HTTP answer to give."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def configured() -> bool:
    """Everything the App flow needs is set: sign-in credentials, App id, URL name and private key."""
    return bool(settings.GITHUB_OAUTH_CLIENT_ID and settings.GITHUB_OAUTH_CLIENT_SECRET and settings.GITHUB_APP_ID
                and settings.GITHUB_APP_SLUG and (settings.GITHUB_APP_PRIVATE_KEY or settings.GITHUB_APP_PRIVATE_KEY_PATH))


def install_url(state: str = "") -> str:
    """GitHub's page where the user installs the App and chooses its repositories."""
    url = f"https://github.com/apps/{settings.GITHUB_APP_SLUG}/installations/new"
    return f"{url}?state={state}" if state else url


def manage_url(installation: dict) -> str:
    """GitHub's settings page for one installation, where repositories are added or removed."""
    account = installation.get("account") or {}
    if account.get("type") == "Organization" and account.get("login"):
        return f"https://github.com/organizations/{account['login']}/settings/installations/{installation.get('id')}"
    return f"https://github.com/settings/installations/{installation.get('id')}"


def _private_key() -> str:
    if settings.GITHUB_APP_PRIVATE_KEY:
        return settings.GITHUB_APP_PRIVATE_KEY.replace("\\n", "\n")
    return Path(settings.GITHUB_APP_PRIVATE_KEY_PATH).expanduser().read_text(encoding="utf-8")


def app_jwt() -> str:
    """The App's own short-lived token (RS256, ten minutes at most), reused until shortly before it expires."""
    global _app_jwt
    token, expires_at = _app_jwt
    now = time.time()
    if token and now < expires_at - 60:
        return token
    issued = int(now) - 60  # GitHub allows for a little clock drift
    try:
        token = jwt.encode({"iat": issued, "exp": issued + 540, "iss": str(settings.GITHUB_APP_ID)}, _private_key(), algorithm="RS256")
    except (OSError, ValueError, TypeError) as error:
        # The key's content is never part of the message.
        raise AccessProblem(503, "GITHUB_APP_NOT_CONFIGURED", f"The GitHub App's private key could not be used ({type(error).__name__}).") from None
    _app_jwt = (token, float(issued + 540))
    return token


def _user_headers(token: str) -> Dict[str, str]:
    return {**_API_HEADERS, "Authorization": f"Bearer {token}"}


def _expiry(seconds: Any) -> Optional[float]:
    return time.time() + float(seconds) if isinstance(seconds, (int, float)) and seconds > 0 else None


def grant_fields(reply: dict) -> Dict[str, Any]:
    """The parts of GitHub's token reply worth keeping. Tokens of an App expire; an OAuth App's do not."""
    return {"access_token": str(reply["access_token"]), "expires_at": _expiry(reply.get("expires_in")),
            "refresh_token": str(reply.get("refresh_token") or ""), "refresh_expires_at": _expiry(reply.get("refresh_token_expires_in"))}


async def refreshed_grant(http: Http, refresh_token: str) -> Optional[dict]:
    """A new user token for a refresh token, or None when GitHub no longer accepts it."""
    try:
        reply = await http.post_json(TOKEN_URL, {"client_id": settings.GITHUB_OAUTH_CLIENT_ID, "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                                                 "grant_type": "refresh_token", "refresh_token": refresh_token}, headers={"Accept": "application/json"})
    except FetchError:
        return None
    return grant_fields(reply) if isinstance(reply, dict) and reply.get("access_token") else None


def problem_for(error: FetchError, what: str) -> AccessProblem:
    """How a failed GitHub request about access is reported. Nothing here is turned into an empty answer."""
    if error.kind == "unauthorized":
        return AccessProblem(401, "SESSION_EXPIRED", "Your GitHub sign-in has expired or was revoked. Sign in again.")
    if error.kind == "rate_limit":
        return AccessProblem(429, "GITHUB_RATE_LIMITED", f"GitHub's rate limit was reached while {what}. Try again in a few minutes.")
    if error.kind in ("timeout", "network"):
        return AccessProblem(502, "GITHUB_UNAVAILABLE", f"GitHub could not be reached while {what}. Try again.")
    return AccessProblem(502, "GITHUB_UNAVAILABLE", f"GitHub answered with an error (HTTP {error.status}) while {what}.")


async def _pages(http: Http, url: str, token: str, key: str) -> Tuple[List[dict], int, bool]:
    """(items, total, complete) for a GitHub list that reports `total_count`, read page by page."""
    items: List[dict] = []
    total = 0
    for page in range(1, max(1, settings.GITHUB_REPOSITORY_PAGES) + 1):
        data = await http.get_json(f"{url}{'&' if '?' in url else '?'}per_page=100&page={page}", headers=_user_headers(token))
        batch = [item for item in (data.get(key) if isinstance(data, dict) else None) or [] if isinstance(item, dict)]
        total = int(data.get("total_count") or 0) if isinstance(data, dict) else 0
        items.extend(batch)
        if not batch or len(items) >= total:
            return items, total, True
    return items, total, len(items) >= total


def _installation(item: dict) -> dict:
    account = item.get("account") if isinstance(item.get("account"), dict) else {}
    permissions = item.get("permissions") if isinstance(item.get("permissions"), dict) else {}
    missing = [name for name in SCAN_PERMISSIONS if permissions.get(name) not in ("read", "write")]
    return {
        "id": int(item.get("id") or 0),
        "account": {"login": str(account.get("login") or ""), "type": str(account.get("type") or ""), "avatar_url": str(account.get("avatar_url") or "")},
        "repository_selection": str(item.get("repository_selection") or ""),
        "suspended": bool(item.get("suspended_at")),
        "missing_permissions": missing,
        "manage_url": manage_url(item),
    }


def _repository(item: dict, installation_id: int) -> dict:
    owner = item.get("owner") if isinstance(item.get("owner"), dict) else {}
    return {
        "id": int(item.get("id") or 0), "name": str(item.get("name") or ""), "owner": str(owner.get("login") or ""),
        "full_name": str(item.get("full_name") or ""), "private": bool(item.get("private")), "language": item.get("language") or None,
        "default_branch": str(item.get("default_branch") or ""), "updated_at": item.get("pushed_at") or item.get("updated_at") or None,
        "html_url": str(item.get("html_url") or ""), "archived": bool(item.get("archived")), "installation_id": installation_id,
    }


async def accessible(http: Http, user_token: str) -> dict:
    """The installations the user can use with the App, and every repository in them that the user can access.

    GitHub's per-user listing is the intersection of what the installation
    covers and what the user may see, so nothing here goes beyond either."""
    installations, total, complete = await _pages(http, f"{API}/user/installations", user_token, "installations")
    shaped = [_installation(item) for item in installations]
    repositories: Dict[int, dict] = {}
    for installation in shaped:
        if installation["suspended"]:
            continue
        items, count, done = await _pages(http, f"{API}/user/installations/{installation['id']}/repositories", user_token, "repositories")
        complete = complete and done
        installation["repository_count"] = count
        for item in items:
            repository = _repository(item, installation["id"])
            repositories.setdefault(repository["id"], repository)
    return {"installations": shaped, "repositories": sorted(repositories.values(), key=lambda repo: repo["full_name"].lower()),
            "complete": complete and len(shaped) >= total, "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")}


async def visible_to_user(http: Http, user_token: str, owner: str, repo: str) -> Optional[dict]:
    """GET /repos/{owner}/{repo} as the user: their access through the App, or None when they have none."""
    try:
        data = await http.get_json(f"{API}/repos/{owner}/{repo}", headers=_user_headers(user_token))
    except FetchError as error:
        if error.kind == "not_found":
            return None
        raise
    return data if isinstance(data, dict) else None


async def installation_for(http: Http, owner: str, repo: str) -> Optional[int]:
    """The id of the App's installation that covers `owner/repo`, or None when the App is not installed on it."""
    try:
        data = await http.get_json(f"{API}/repos/{owner}/{repo}/installation", headers={**_API_HEADERS, "Authorization": f"Bearer {app_jwt()}"})
    except FetchError as error:
        if error.kind == "not_found":
            return None
        raise
    return int(data["id"]) if isinstance(data, dict) and data.get("id") else None


async def installation_token(http: Http, installation_id: int, repository_ids: List[int]) -> Tuple[str, float]:
    """(token, expiry) for one installation, narrowed to `repository_ids` and to read-only scan permissions."""
    data = await http.post_json(f"{API}/app/installations/{installation_id}/access_tokens",
                                {"repository_ids": sorted(set(repository_ids)), "permissions": SCAN_PERMISSIONS},
                                headers={**_API_HEADERS, "Authorization": f"Bearer {app_jwt()}"})
    if not isinstance(data, dict) or not data.get("token"):
        raise FetchError("invalid", message="GitHub did not return an installation token")
    expires = data.get("expires_at")
    try:
        expires_at = datetime.fromisoformat(str(expires).replace("Z", "+00:00")).timestamp()
    except ValueError:
        expires_at = time.time() + 600  # unknown: assume the shortest useful lifetime
    return str(data["token"]), expires_at
