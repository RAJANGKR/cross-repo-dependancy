"""Sign in with GitHub (OAuth web flow). It is the only sign-in method.

Flow: /auth/github/login redirects to GitHub with a signed `state`; GitHub
returns to /auth/github/callback with a one-time code; the backend exchanges
it, reads the user's public profile, and sets a signed HTTP-only session
cookie. The GitHub access token is used once for that profile call and then
discarded: it is never stored, logged, or sent to the browser.
"""
import secrets
from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.core.config import settings
from app.services import sessions
from app.services.http import FetchError, Http

router = APIRouter()

SESSION_COOKIE = "driftlock_session"
STATE_COOKIE = "driftlock_oauth_state"
SESSION_SECONDS = 7 * 24 * 3600
STATE_SECONDS = 600
AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"


def configured() -> bool:
    return bool(settings.GITHUB_OAUTH_CLIENT_ID and settings.GITHUB_OAUTH_CLIENT_SECRET)


def current_user(request: Request) -> Optional[dict]:
    """The signed-in user from the session cookie, or None."""
    payload = sessions.verify(request.cookies.get(SESSION_COOKIE))
    user = payload.get("user") if payload else None
    return user if isinstance(user, dict) and user.get("login") else None


def _cookie_options() -> dict:
    return {"httponly": True, "samesite": "lax", "secure": settings.APP_ENV == "production", "path": "/"}


def _safe_return_to(value: Optional[str]) -> str:
    """Only a configured frontend origin may be redirected to (no open redirect)."""
    origins = settings.cors_origins_list
    candidate = (value or "").rstrip("/")
    return candidate if candidate in origins else (origins[0] if origins and origins[0] != "*" else "http://localhost:5173")


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error_code": code, "message": message, "details": {}})


@router.get("/auth/me", tags=["Auth"])
async def me(request: Request):
    """Whether GitHub sign-in is set up on this backend, and who is signed in."""
    return {"configured": configured(), "required": settings.AUTH_REQUIRED, "user": current_user(request)}


@router.get("/auth/github/login", tags=["Auth"])
async def github_login(request: Request, return_to: Optional[str] = None):
    if not configured():
        return _error(503, "SIGN_IN_NOT_CONFIGURED", "GitHub sign-in is not configured on this backend.")
    state = secrets.token_urlsafe(24)
    query = urlencode({
        "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
        "redirect_uri": str(request.url_for("github_callback")),
        "scope": "read:user",
        "state": state,
    })
    response = RedirectResponse(f"{AUTHORIZE_URL}?{query}", status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        sessions.sign({"state": state, "return_to": _safe_return_to(return_to)}, STATE_SECONDS),
        max_age=STATE_SECONDS,
        **_cookie_options(),
    )
    return response


@router.get("/auth/github/callback", tags=["Auth"], name="github_callback")
async def github_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    saved = sessions.verify(request.cookies.get(STATE_COOKIE))
    # The state must match the one this browser was given, or the request did not start here.
    if not saved or not state or not secrets.compare_digest(str(saved.get("state", "")), state):
        return _error(400, "INVALID_OAUTH_STATE", "This sign-in link is not valid or has expired. Start again from the app.")
    return_to = _safe_return_to(saved.get("return_to"))

    def back(problem: Optional[str] = None) -> RedirectResponse:
        response = RedirectResponse(f"{return_to}/{'?auth_error=' + problem if problem else ''}", status_code=302)
        response.delete_cookie(STATE_COOKIE, path="/")
        return response

    if error or not code:
        return back("cancelled")
    if not configured():
        return back("not_configured")

    http = Http(github_token="", timeout=settings.HTTP_TIMEOUT_SECONDS, retries=1)
    try:
        token_reply = await http.post_json(
            TOKEN_URL,
            {
                "client_id": settings.GITHUB_OAUTH_CLIENT_ID,
                "client_secret": settings.GITHUB_OAUTH_CLIENT_SECRET,
                "code": code,
                "redirect_uri": str(request.url_for("github_callback")),
            },
            headers={"Accept": "application/json"},
        )
        access_token = token_reply.get("access_token") if isinstance(token_reply, dict) else None
        if not access_token:
            return back("exchange_failed")
        profile = await http.get_json(USER_URL, headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"})
    except FetchError:
        return back("github_unreachable")
    finally:
        await http.aclose()

    if not isinstance(profile, dict) or not profile.get("login"):
        return back("exchange_failed")
    user = {
        "id": profile.get("id"),
        "login": str(profile["login"])[:100],
        "name": str(profile.get("name") or profile["login"])[:200],
        "avatar_url": str(profile.get("avatar_url") or "")[:500],
    }
    response = back()
    response.set_cookie(SESSION_COOKIE, sessions.sign({"user": user}, SESSION_SECONDS), max_age=SESSION_SECONDS, **_cookie_options())
    return response


@router.post("/auth/logout", tags=["Auth"])
async def logout():
    response = JSONResponse({"signed_out": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response
