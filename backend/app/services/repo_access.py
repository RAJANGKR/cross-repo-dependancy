"""Which repositories a scan may read, decided on the backend from the session.

Nothing the browser sends about access is trusted: not a repository id, not an
installation id, not a claim that a repository is private or allowed. For each
GitHub repository of a scan, the signed-in user's own token asks GitHub whether
they can see it. A private one must also be covered by an installation of the
App; one installation token per installation is then minted for exactly the
private repositories of this scan. Public repositories keep the ordinary path."""
import time
from typing import Dict, List, Optional, Tuple

from app.core.config import settings
from app.services import github_app, sessions
from app.services.credentials import RepoCredential, RepoCredentials
from app.services.github_app import AccessProblem
from app.services.http import FetchError, Http

NO_ACCESS = ("{name} was not found, or your GitHub sign-in has no access to it through DriftLock. "
             "If it is private, add it to DriftLock's repository access on GitHub (Manage repository access).")


def client() -> Http:
    """A client for requests made with a user's or the App's credentials: no shared token, no cache."""
    return Http(github_token="", cache=None, timeout=settings.HTTP_TIMEOUT_SECONDS, retries=1)


async def user_token(session_id: str, record: sessions.SessionRecord, http: Http) -> str:
    """The user's GitHub token, renewed first when it has expired. A session that cannot be renewed ends."""
    grant = record.grant
    if grant is None:
        raise AccessProblem(401, "SESSION_EXPIRED", "Sign in with GitHub again to use your repositories.")
    if not grant.expired():
        return grant.access_token
    refresh_usable = grant.refresh_token and not (grant.refresh_expires_at and time.time() >= grant.refresh_expires_at)
    fields = await github_app.refreshed_grant(http, grant.refresh_token) if refresh_usable else None
    if fields is None:
        sessions.store.delete(session_id)
        raise AccessProblem(401, "SESSION_EXPIRED", "Your GitHub sign-in has expired. Sign in again.")
    renewed = sessions.GitHubGrant(**fields)
    sessions.store.update(session_id, grant=renewed)
    return renewed.access_token


def _app_problem(error: FetchError, what: str) -> AccessProblem:
    """A failed request made with the App's own credentials."""
    if error.kind == "unauthorized":
        return AccessProblem(503, "GITHUB_APP_MISCONFIGURED", "GitHub did not accept DriftLock's GitHub App credentials. Check GITHUB_APP_ID and the private key.")
    return github_app.problem_for(error, what)


async def scan_credentials(session_id: Optional[str], record: Optional[sessions.SessionRecord], repositories: List[Tuple[str, str]]) -> Optional[RepoCredentials]:
    """Credentials for the private repositories among `repositories` ((owner, repo) pairs), or None
    when there is no signed-in session with a GitHub App grant. Raises AccessProblem when a
    repository may not be read or access cannot be checked."""
    if record is None or record.grant is None or not session_id or not github_app.configured():
        return None
    http = client()
    try:
        token = await user_token(session_id, record, http)
        by_installation: Dict[int, List[Tuple[str, str, int]]] = {}
        for owner, repo in dict.fromkeys(repositories):
            name, what = f"{owner}/{repo}", f"checking your access to {owner}/{repo}"
            try:
                info = await github_app.visible_to_user(http, token, owner, repo)
            except FetchError as error:
                raise github_app.problem_for(error, what) from None
            if info is None:
                raise AccessProblem(403, "REPOSITORY_NOT_AUTHORIZED", NO_ACCESS.format(name=name))
            if not info.get("private"):
                continue  # public: read the ordinary way, with no credential of this user
            try:
                installation = await github_app.installation_for(http, owner, repo)
            except FetchError as error:
                raise _app_problem(error, what) from None
            if installation is None or not info.get("id"):
                raise AccessProblem(403, "REPOSITORY_NOT_AUTHORIZED", NO_ACCESS.format(name=name))
            by_installation.setdefault(installation, []).append((owner, repo, int(info["id"])))

        credentials = RepoCredentials()
        for installation, repos in by_installation.items():
            try:
                issued, expires_at = await github_app.installation_token(http, installation, [repository_id for _, _, repository_id in repos])
            except FetchError as error:
                if error.kind in ("not_found", "http") and error.status in (403, 404, 422):
                    raise AccessProblem(403, "REPOSITORY_NOT_AUTHORIZED", "GitHub refused repository access for this scan: the App's installation or its "
                                        "permissions changed. Review Manage repository access, then try again.") from None
                raise _app_problem(error, "requesting repository access for this scan") from None
            for owner, repo, repository_id in repos:
                credentials.add(owner, repo, RepoCredential(issued, expires_at, installation, repository_id))
        return credentials
    finally:
        await http.aclose()
