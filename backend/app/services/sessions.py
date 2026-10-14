"""Sessions: a signed cookie for the browser, and a server-side record.

The cookie is a signed token (HMAC-SHA256 over a JSON payload) that carries the
signed-in user's public GitHub profile, a random session id and an expiry. The
GitHub access token is never put in it: it stays in the server-side record
that the session id points to.
"""
import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Dict, Optional

from app.core.config import settings

# Used when SESSION_SECRET is not set: sessions then end when the server restarts.
_EPHEMERAL_SECRET = secrets.token_urlsafe(32)


def _secret() -> bytes:
    return (settings.SESSION_SECRET or _EPHEMERAL_SECRET).encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def sign(payload: dict, max_age_seconds: int) -> str:
    body = _b64(json.dumps({**payload, "exp": int(time.time()) + max_age_seconds}, separators=(",", ":")).encode("utf-8"))
    signature = _b64(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}"


def verify(token: Optional[str]) -> Optional[dict]:
    """The payload if the signature is valid and the token has not expired, else None."""
    if not token or token.count(".") != 1:
        return None
    body, signature = token.split(".")
    expected = _b64(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_unb64(body))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("exp", 0) < time.time():
        return None
    return payload


# ---- Server-side session records ----------------------------------------------------------
#
# With a GitHub App, a signed-in user's GitHub token is needed again later: to list
# the repositories they can grant, and to check their access before a scan. It is
# kept here, on the backend, under a random session id. The browser's cookie holds
# only that id and the public profile, signed; it never holds a token.


@dataclass(repr=False)
class GitHubGrant:
    """The user's access token from GitHub's OAuth exchange, and how to renew it."""

    access_token: str
    #: Epoch seconds; None when the token does not expire.
    expires_at: Optional[float] = None
    refresh_token: str = ""
    refresh_expires_at: Optional[float] = None

    def expired(self, margin_seconds: float = 60) -> bool:
        return self.expires_at is not None and time.time() >= self.expires_at - margin_seconds

    def __repr__(self) -> str:  # never the tokens
        return f"GitHubGrant(expires_at={self.expires_at})"


@dataclass(repr=False)
class SessionRecord:
    user: dict
    grant: Optional[GitHubGrant]
    expires_at: float
    #: The repository listing of this session, kept briefly so the picker does not ask GitHub on every render.
    listing: Optional[dict] = None
    listed_at: float = 0.0

    def __repr__(self) -> str:
        return f"SessionRecord(user={self.user.get('login')!r})"


class SessionStore:
    """Session records in memory. They end on logout, on expiry, or when the backend restarts."""

    def __init__(self) -> None:
        self._records: Dict[str, SessionRecord] = {}
        self._lock = threading.Lock()

    def create(self, user: dict, grant: Optional[GitHubGrant], max_age_seconds: int) -> str:
        session_id = secrets.token_urlsafe(32)
        with self._lock:
            self._evict()
            self._records[session_id] = SessionRecord(user=user, grant=grant, expires_at=time.time() + max_age_seconds)
        return session_id

    def get(self, session_id: Optional[str]) -> Optional[SessionRecord]:
        if not session_id:
            return None
        with self._lock:
            self._evict()
            return self._records.get(session_id)

    def update(self, session_id: str, **fields) -> None:
        with self._lock:
            record = self._records.get(session_id)
            if record is not None:
                for name, value in fields.items():
                    setattr(record, name, value)

    def delete(self, session_id: Optional[str]) -> None:
        with self._lock:
            self._records.pop(session_id or "", None)

    def _evict(self) -> None:
        now = time.time()
        for session_id in [key for key, record in self._records.items() if record.expires_at < now]:
            del self._records[session_id]


store = SessionStore()
