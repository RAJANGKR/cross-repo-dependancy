"""The signed-in user's repositories, through DriftLock's GitHub App.

GET /api/v1/github/repositories lists the App's installations that the user
can use and every repository in them the user can access, read page by page
from GitHub. It is kept for a minute per session; `refresh=true` asks GitHub
again. Tokens never leave the backend: the answer holds names, visibility and
settings links only."""
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.api.v1.endpoints.auth import current_session
from app.services import github_app, repo_access, sessions
from app.services.github_app import AccessProblem
from app.services.http import FetchError

router = APIRouter()
LISTING_SECONDS = 60


def _problem(problem: AccessProblem) -> JSONResponse:
    return JSONResponse(status_code=problem.status, content={"error_code": problem.code, "message": problem.message, "details": {}})


@router.get("/github/repositories", tags=["GitHub"])
async def repositories(request: Request, refresh: bool = False):
    if not github_app.configured():
        return _problem(AccessProblem(503, "GITHUB_APP_NOT_CONFIGURED", "Repository access through DriftLock's GitHub App is not set up on this backend."))
    session_id, record, state = current_session(request)
    if record is None or not session_id:
        if state == "expired":
            return _problem(AccessProblem(401, "SESSION_EXPIRED", "Your session has ended. Sign in with GitHub again."))
        return _problem(AccessProblem(401, "SIGN_IN_REQUIRED", "Sign in with GitHub to see your repositories."))
    if not refresh and record.listing and time.time() - record.listed_at < LISTING_SECONDS:
        return {**record.listing, "cached": True}

    http = repo_access.client()
    try:
        token = await repo_access.user_token(session_id, record, http)
        listing = await github_app.accessible(http, token)
    except AccessProblem as problem:
        return _problem(problem)
    except FetchError as error:
        return _problem(github_app.problem_for(error, "listing your repositories"))
    finally:
        await http.aclose()
    listing = {**listing, "install_url": "/api/v1/auth/github/install"}
    sessions.store.update(session_id, listing=listing, listed_at=time.time())
    return {**listing, "cached": False}
