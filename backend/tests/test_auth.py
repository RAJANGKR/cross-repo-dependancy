"""GitHub sign-in tests. GitHub itself is faked; nothing here touches the network."""
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.api.v1.endpoints import auth
from app.core.config import settings
from app.main import app
from app.services import scan_runner, sessions
from tests.fakes import fake_http

FRONTEND = "http://localhost:5174"
TARGETS = {
    "repository_targets": [
        {"type": "github", "url": "https://github.com/acme/service-a"},
        {"type": "github", "url": "https://github.com/acme/service-b"},
    ]
}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_ID", "client-id")
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "client-secret")
    monkeypatch.setattr(settings, "SESSION_SECRET", "test-secret")
    monkeypatch.setattr(settings, "AUTH_REQUIRED", False)
    monkeypatch.setattr(settings, "CORS_ORIGINS", f"http://localhost:5173,{FRONTEND}")
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(auth, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    return TestClient(app, follow_redirects=False)


def start(client, return_to=FRONTEND):
    response = client.get("/api/v1/auth/github/login", params={"return_to": return_to})
    assert response.status_code == 302
    return response, parse_qs(urlparse(response.headers["location"]).query)


def sign_in(client):
    _, query = start(client)
    return client.get("/api/v1/auth/github/callback", params={"code": "good-code", "state": query["state"][0]})


def test_me_reports_setup_and_no_user_before_sign_in(client, monkeypatch):
    assert client.get("/api/v1/auth/me").json() == {"configured": True, "required": False, "user": None}
    monkeypatch.setattr(settings, "GITHUB_OAUTH_CLIENT_SECRET", "")
    assert client.get("/api/v1/auth/me").json()["configured"] is False
    assert client.get("/api/v1/auth/github/login").json()["error_code"] == "SIGN_IN_NOT_CONFIGURED"


def test_login_redirects_to_github_with_state_and_minimal_scope(client):
    response, query = start(client)
    assert response.headers["location"].startswith("https://github.com/login/oauth/authorize?")
    assert query["client_id"] == ["client-id"] and query["scope"] == ["read:user"]
    assert query["redirect_uri"][0].endswith("/api/v1/auth/github/callback")
    assert "client-secret" not in response.headers["location"]
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_full_sign_in_sets_a_session_and_returns_to_the_app(client):
    response = sign_in(client)
    assert response.status_code == 302 and response.headers["location"] == f"{FRONTEND}/"
    assert "httponly" in response.headers["set-cookie"].lower()
    me = client.get("/api/v1/auth/me").json()
    assert me["user"] == {
        "id": 42,
        "login": "octocat",
        "name": "The Octocat",
        "avatar_url": "https://avatars.githubusercontent.com/u/42",
    }
    # The GitHub access token never reaches the browser.
    assert "gho_test_token" not in response.headers["set-cookie"] and "gho_test_token" not in str(me)


def test_sign_out_clears_the_session(client):
    sign_in(client)
    assert client.post("/api/v1/auth/logout").json() == {"signed_out": True}
    assert client.get("/api/v1/auth/me").json()["user"] is None


def test_callback_rejects_a_missing_or_wrong_state(client):
    start(client)
    wrong = client.get("/api/v1/auth/github/callback", params={"code": "good-code", "state": "not-the-state"})
    assert wrong.status_code == 400 and wrong.json()["error_code"] == "INVALID_OAUTH_STATE"
    fresh = TestClient(app, follow_redirects=False)  # a browser that never started the flow
    assert fresh.get("/api/v1/auth/github/callback", params={"code": "good-code", "state": "x"}).status_code == 400
    assert client.get("/api/v1/auth/me").json()["user"] is None


def test_a_bad_code_or_a_cancelled_sign_in_returns_without_a_session(client):
    _, query = start(client)
    bad = client.get("/api/v1/auth/github/callback", params={"code": "bad-code", "state": query["state"][0]})
    assert bad.headers["location"] == f"{FRONTEND}/?auth_error=exchange_failed"
    _, query = start(client)
    cancelled = client.get("/api/v1/auth/github/callback", params={"error": "access_denied", "state": query["state"][0]})
    assert cancelled.headers["location"] == f"{FRONTEND}/?auth_error=cancelled"
    assert client.get("/api/v1/auth/me").json()["user"] is None


def test_return_to_must_be_a_configured_frontend_origin(client):
    _, query = start(client, return_to="https://evil.example")
    response = client.get("/api/v1/auth/github/callback", params={"code": "good-code", "state": query["state"][0]})
    assert response.headers["location"] == "http://localhost:5173/"  # falls back to the first allowed origin


def test_a_tampered_or_expired_session_is_ignored(client):
    token = sessions.sign({"user": {"login": "octocat"}}, 60)
    body, signature = token.split(".")
    assert sessions.verify(token)["user"] == {"login": "octocat"}
    assert sessions.verify(body + "x." + signature) is None
    assert sessions.verify(body + "." + "A" * len(signature)) is None
    assert sessions.verify(sessions.sign({"user": {"login": "octocat"}}, -1)) is None
    assert sessions.verify("garbage") is None and sessions.verify(None) is None
    client.cookies.set(auth.SESSION_COOKIE, body + "." + "A" * len(signature))
    assert client.get("/api/v1/auth/me").json()["user"] is None


def test_sign_in_is_optional_by_default(client):
    from app.core.config import Settings

    assert Settings.model_fields["AUTH_REQUIRED"].default is False
    accepted = client.post("/api/v1/scans", json=TARGETS)  # signed out, and still allowed
    assert accepted.status_code == 202
    assert client.get(accepted.json()["poll_url"]).json()["status"] == "COMPLETED"


def test_scans_are_refused_until_signed_in_when_sign_in_is_made_mandatory(client, monkeypatch):
    monkeypatch.setattr(settings, "AUTH_REQUIRED", True)
    blocked = client.post("/api/v1/scans", json=TARGETS)
    assert blocked.status_code == 401 and blocked.json()["error_code"] == "SIGN_IN_REQUIRED"
    assert client.get("/api/v1/scans/scn_anything").status_code == 401  # results are not readable either

    sign_in(client)
    accepted = client.post("/api/v1/scans", json=TARGETS)
    assert accepted.status_code == 202
    assert client.get(accepted.json()["poll_url"]).json()["status"] == "COMPLETED"

    client.post("/api/v1/auth/logout")
    assert client.get(accepted.json()["poll_url"]).status_code == 401  # signing out locks them again
