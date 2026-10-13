"""Signed, stateless session tokens (HMAC-SHA256 over a JSON payload).

The token carries the signed-in user's public GitHub profile and an expiry.
Nothing is stored server-side, and the GitHub access token is never put in it.
"""
import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Optional

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
