"""GitHub App sign-in, repository listing and private repository scans.

GitHub is faked here with the shapes of its documented REST API. The fake
checks what GitHub checks: the App's JWT signature and issuer, which
repositories an installation token was minted for, and that a private
repository is invisible without a credential that covers it. Nothing here
touches the network."""
import io
import json
import time
import zipfile
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app.api.v1.endpoints import auth
from app.core.config import settings
from app.main import app
from app.services import github_app, repo_access, scan_runner, sessions
from app.services.cache import Cache
from app.services.credentials import RepoCredential, RepoCredentials
from app.services.http import FetchError, Http
from app.services.scan_store import scan_store
from tests.fakes import handler as public_github

FRONTEND = "http://localhost:5174"
APP_ID = "12345"
_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = _KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
PUBLIC_KEY = _KEY.public_key()

REQUIREMENTS = "pydantic==1.10.13\nrequests==2.31.0\n"
PRIVATE_SPEC = "openapi: 3.0.3\ninfo: {title: Ledger API, version: 1.0.0}\npaths:\n  /ledger:\n    get:\n      responses:\n        '200': {description: ok}\n"


def private_repo(repo_id, installation, files):
    return {"id": repo_id, "private": True, "installation": installation, "default_branch": "main", "sha": f"{repo_id:040d}", "files": files}


class FakeGitHub:
    """GitHub's App, OAuth and repository endpoints, for two users and three installations."""

    def __init__(self):
        self.users = {
            "user-token-alice": {"id": 1, "login": "alice", "name": "Alice", "avatar_url": "https://avatars.githubusercontent.com/u/1", "installations": [101, 202]},
            "user-token-bob": {"id": 2, "login": "bob", "name": "Bob", "avatar_url": "https://avatars.githubusercontent.com/u/2", "installations": [303]},
            "user-token-carol": {"id": 3, "login": "carol", "name": "Carol", "avatar_url": "https://avatars.githubusercontent.com/u/3", "installations": []},
        }
        self.codes = {"code-alice": "user-token-alice", "code-bob": "user-token-bob", "code-carol": "user-token-carol"}
        self.installations = {
            101: {"account": {"login": "alice", "type": "User"}, "repository_selection": "selected", "permissions": {"contents": "read", "metadata": "read"}},
            202: {"account": {"login": "acme-org", "type": "Organization"}, "repository_selection": "all", "permissions": {"metadata": "read"}},
            303: {"account": {"login": "bob", "type": "User"}, "repository_selection": "selected", "permissions": {"contents": "read", "metadata": "read"}},
        }
        self.repos = {
            "alice/ledger": private_repo(9001, 101, {"requirements.txt": REQUIREMENTS, "openapi.yaml": PRIVATE_SPEC, "app.py": "from pydantic import validator\n"}),
            "alice/notes": private_repo(9002, 101, {"requirements.txt": "requests==2.31.0\n"}),
            "bob/vault": private_repo(9100, 303, {"requirements.txt": "pydantic==2.5.0\n"}),
        }
        self.tokens = {}          # installation token -> (installation id, repository ids)
        self.revoked = set()
        self.refreshable = {"refresh-alice": "user-token-alice-2"}
        self.expires_in = 28800
        self.requests = []        # (method, url, authorization)
        self.fail = {}            # substring of a URL -> status to answer

    # -- helpers ---------------------------------------------------------------------------
    def bulk(self, installation, count):
        """Give an installation `count` more private repositories, for pagination."""
        for index in range(count):
            self.repos[f"acme-org/svc-{index:03d}"] = private_repo(20000 + index, installation, {"requirements.txt": ""})

    def _who(self, request):
        header = request.headers.get("authorization", "")
        token = header.removeprefix("Bearer ").strip()
        if token.startswith("user-token-"):
            return ("user", token)
        if token.startswith("ghs_"):
            return ("installation", token)
        if token.count(".") == 2:
            return ("app", token)
        return ("none", token)

    def _app_ok(self, token):
        try:
            claims = jwt.decode(token, PUBLIC_KEY, algorithms=["RS256"])
        except jwt.PyJWTError:
            return False
        return claims.get("iss") == APP_ID and claims["exp"] - claims["iat"] <= 600

    def _user_sees(self, token, name):
        repo = self.repos.get(name)
        return repo is not None and repo["installation"] in self.users[token]["installations"]

    def _page(self, request, items, key):
        query = parse_qs(request.url.query.decode())
        per_page, page = int(query.get("per_page", ["30"])[0]), int(query.get("page", ["1"])[0])
        return httpx.Response(200, json={"total_count": len(items), key: items[(page - 1) * per_page: page * per_page]})

    def _repo_json(self, name):
        repo = self.repos[name]
        owner, short = name.split("/")
        return {"id": repo["id"], "name": short, "full_name": name, "owner": {"login": owner}, "private": True, "language": "Python",
                "default_branch": "main", "pushed_at": "2026-10-01T10:00:00Z", "html_url": f"https://github.com/{name}"}

    # -- the fake -------------------------------------------------------------------------
    def __call__(self, request):
        kind, token = self._who(request)
        self.requests.append((request.method, str(request.url), request.headers.get("authorization", "")))
        url, host, path = str(request.url), request.url.host, request.url.path
        for needle, status in self.fail.items():
            if needle in url:
                return httpx.Response(status)

        if host == "github.com" and path == "/login/oauth/access_token":
            body = json.loads(request.content)
            if body.get("grant_type") == "refresh_token":
                new = self.refreshable.pop(body.get("refresh_token"), None)
                if not new:
                    return httpx.Response(200, json={"error": "bad_refresh_token"})
                self.users[new] = self.users["user-token-alice"]
                return httpx.Response(200, json={"access_token": new, "expires_in": self.expires_in, "refresh_token": "refresh-alice-2", "refresh_token_expires_in": 15897600})
            user_token = self.codes.get(body.get("code"))
            if not user_token or body.get("client_secret") != "client-secret":
                return httpx.Response(200, json={"error": "bad_verification_code"})
            return httpx.Response(200, json={"access_token": user_token, "expires_in": self.expires_in, "refresh_token": f"refresh-{self.users[user_token]['login']}",
                                             "refresh_token_expires_in": 15897600, "token_type": "bearer"})

        if host == "api.github.com" and path == "/user":
            user = self.users.get(token) if kind == "user" else None
            return httpx.Response(200, json={k: v for k, v in user.items() if k != "installations"}) if user else httpx.Response(401)

        if host == "api.github.com" and path == "/user/installations":
            if kind != "user" or token not in self.users:
                return httpx.Response(401)
            items = [{"id": i, **self.installations[i]} for i in self.users[token]["installations"]]
            return self._page(request, items, "installations")

        if host == "api.github.com" and path.startswith("/user/installations/") and path.endswith("/repositories"):
            installation = int(path.split("/")[3])
            if kind != "user" or token not in self.users:
                return httpx.Response(401)
            if installation not in self.users[token]["installations"]:
                return httpx.Response(404)
            items = [self._repo_json(name) for name, repo in sorted(self.repos.items()) if repo["installation"] == installation]
            return self._page(request, items, "repositories")

        if host == "api.github.com" and path.startswith("/app/installations/") and path.endswith("/access_tokens"):
            installation = int(path.split("/")[3])
            if kind != "app" or not self._app_ok(token):
                return httpx.Response(401)
            body = json.loads(request.content)
            covered = {repo["id"] for repo in self.repos.values() if repo["installation"] == installation}
            if not set(body["repository_ids"]) <= covered or body.get("permissions") != {"contents": "read", "metadata": "read"}:
                return httpx.Response(422)
            issued = f"ghs_{installation}_{len(self.tokens)}"
            self.tokens[issued] = (installation, set(body["repository_ids"]))
            expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 3600))
            return httpx.Response(201, json={"token": issued, "expires_at": expires, "permissions": body["permissions"]})

        parts = path.strip("/").split("/")
        if host == "api.github.com" and parts[:1] == ["repos"] and "/".join(parts[1:3]) in self.repos:
            name, rest = "/".join(parts[1:3]), parts[3:]
            repo = self.repos[name]
            if rest == ["installation"]:
                if kind != "app" or not self._app_ok(token):
                    return httpx.Response(401)
                return httpx.Response(200, json={"id": repo["installation"]})
            if kind == "installation" and token in self.revoked:
                return httpx.Response(401)
            allowed = (kind == "user" and token in self.users and self._user_sees(token, name)) or \
                      (kind == "installation" and repo["id"] in self.tokens.get(token, (0, set()))[1]) or (token == "shared-pat")
            if not allowed:
                return httpx.Response(404)  # what GitHub answers for a private repository it will not show
            if not rest:
                return httpx.Response(200, json=self._repo_json(name))
            if rest[0] == "commits":
                return httpx.Response(200, text=repo["sha"])
            if rest[:2] == ["git", "trees"]:
                return httpx.Response(200, json={"tree": [{"path": p, "type": "blob", "size": len(t)} for p, t in repo["files"].items()], "truncated": False})
            if rest[0] == "contents":
                content = repo["files"].get("/".join(rest[1:]))
                return httpx.Response(200, text=content) if content is not None else httpx.Response(404)
            if rest[0] == "zipball":
                return httpx.Response(302, headers={"location": f"https://codeload.github.com/{name}/legacy.zip/{rest[1]}?token=TEMPORARY{repo['id']}"})
        if host == "codeload.github.com" and "/".join(parts[:2]) in self.repos:
            repo = self.repos["/".join(parts[:2])]
            if parse_qs(request.url.query.decode()).get("token") != [f"TEMPORARY{repo['id']}"] or request.headers.get("authorization"):
                return httpx.Response(404)
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                for file_path, text in repo["files"].items():
                    archive.writestr(f"top/{file_path}", text)
            return httpx.Response(200, content=buffer.getvalue())
        return public_github(request)


@pytest.fixture
def github(monkeypatch):
    fake = FakeGitHub()

    def make(**kwargs):
        return Http(transport=httpx.MockTransport(fake), cache=None, retries=0, backoff=0,
                    github_token=kwargs.get("github_token", ""), credentials=kwargs.get("credentials"))

    for setting, value in {"GITHUB_OAUTH_CLIENT_ID": "client-id", "GITHUB_OAUTH_CLIENT_SECRET": "client-secret", "GITHUB_APP_ID": APP_ID,
                           "GITHUB_APP_SLUG": "driftlock-test", "GITHUB_APP_PRIVATE_KEY": PRIVATE_PEM.replace("\n", "\\n"), "GITHUB_APP_PRIVATE_KEY_PATH": "",
                           "GITHUB_REPOSITORY_PAGES": 20, "SESSION_SECRET": "test-secret", "AUTH_REQUIRED": False, "GITHUB_TOKEN": "", "GEMINI_API_KEY": "",
                           "CORS_ORIGINS": f"http://localhost:5173,{FRONTEND}"}.items():
        monkeypatch.setattr(settings, setting, value)
    monkeypatch.setattr(github_app, "_app_jwt", ("", 0.0))
    monkeypatch.setattr(sessions, "store", sessions.SessionStore())
    for module in (auth, repo_access, scan_runner):
        monkeypatch.setattr(module, "Http", make)
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    return fake


def browser():
    return TestClient(app, follow_redirects=False)


def sign_in(client, code="code-alice"):
    start = client.get("/api/v1/auth/github/login", params={"return_to": FRONTEND})
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    return client.get("/api/v1/auth/github/callback", params={"code": code, "state": state})


def scan(client, *urls):
    response = client.post("/api/v1/scans?wait=true", json={"repository_targets": [{"type": "github", "url": f"https://github.com/{u}"} for u in urls]})
    return response


# ---- Sign-in, state and sessions ---------------------------------------------------------------

def test_sign_in_keeps_the_github_token_on_the_backend(github):
    client = browser()
    assert client.get("/api/v1/auth/me").json()["repository_access"] == {"configured": True}
    response = sign_in(client)
    assert response.status_code == 302 and response.headers["location"] == f"{FRONTEND}/"
    cookie = response.headers["set-cookie"]
    assert "httponly" in cookie.lower() and "samesite=lax" in cookie.lower()
    assert "user-token-alice" not in cookie and "refresh-alice" not in cookie
    payload = sessions.verify(client.cookies.get(auth.SESSION_COOKIE))
    assert set(payload) == {"user", "sid", "exp"}                                        # an id and the public profile, nothing else
    record = sessions.store.get(payload["sid"])
    assert record.grant.access_token == "user-token-alice" and record.grant.refresh_token == "refresh-alice" and record.grant.expires_at > time.time()
    assert "user-token" not in repr(record) and "user-token" not in repr(record.grant)
    me = client.get("/api/v1/auth/me")
    assert me.json()["user"]["login"] == "alice" and "token" not in me.text


def test_the_oauth_state_is_random_bound_to_the_browser_and_used_once(github):
    client = browser()
    first = parse_qs(urlparse(client.get("/api/v1/auth/github/login").headers["location"]).query)["state"][0]
    second = parse_qs(urlparse(client.get("/api/v1/auth/github/login").headers["location"]).query)["state"][0]
    assert first != second and len(second) >= 32
    wrong = client.get("/api/v1/auth/github/callback", params={"code": "code-alice", "state": first})   # replaced by the second
    assert wrong.status_code == 400 and wrong.json()["error_code"] == "INVALID_OAUTH_STATE"
    other_browser = browser()
    assert other_browser.get("/api/v1/auth/github/callback", params={"code": "code-alice", "state": second}).status_code == 400
    assert client.get("/api/v1/auth/github/callback", params={"code": "code-alice", "state": second}).status_code == 302
    replay = client.get("/api/v1/auth/github/callback", params={"code": "code-alice", "state": second})
    assert replay.status_code == 400                                                  # the state cookie is gone after use


def test_a_cancelled_or_failed_authorization_creates_no_session(github):
    client = browser()
    start = client.get("/api/v1/auth/github/login", params={"return_to": FRONTEND})
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    cancelled = client.get("/api/v1/auth/github/callback", params={"error": "access_denied", "state": state})
    assert cancelled.headers["location"] == f"{FRONTEND}/?auth_error=cancelled"
    assert sign_in(browser(), code="not-a-code").headers["location"] == f"{FRONTEND}/?auth_error=exchange_failed"
    assert sessions.store._records == {} and client.get("/api/v1/auth/me").json()["user"] is None


def test_logout_and_lost_sessions_end_access(github):
    client = browser()
    sign_in(client)
    sid = sessions.verify(client.cookies.get(auth.SESSION_COOKIE))["sid"]
    assert client.post("/api/v1/auth/logout").json() == {"signed_out": True}
    assert sessions.store.get(sid) is None                                            # the token is gone with the session

    sign_in(client)
    sessions.store.delete(sessions.verify(client.cookies.get(auth.SESSION_COOKIE))["sid"])   # expiry or a backend restart
    assert client.get("/api/v1/auth/me").json()["user"] is None
    listing = client.get("/api/v1/github/repositories")
    assert listing.status_code == 401 and listing.json()["error_code"] == "SESSION_EXPIRED"
    assert browser().get("/api/v1/github/repositories").json()["error_code"] == "SIGN_IN_REQUIRED"


def test_an_expired_user_token_is_renewed_once_and_a_dead_one_ends_the_session(github):
    client = browser()
    sign_in(client)
    sid = sessions.verify(client.cookies.get(auth.SESSION_COOKIE))["sid"]
    sessions.store.get(sid).grant.expires_at = time.time() - 10
    assert client.get("/api/v1/github/repositories").status_code == 200
    assert sessions.store.get(sid).grant.access_token == "user-token-alice-2"         # renewed with the refresh token

    sessions.store.get(sid).grant.expires_at = time.time() - 10                      # and now the refresh token is spent
    expired = client.get("/api/v1/github/repositories", params={"refresh": "true"})
    assert expired.status_code == 401 and expired.json()["error_code"] == "SESSION_EXPIRED"
    assert sessions.store.get(sid) is None and client.get("/api/v1/auth/me").json()["user"] is None


def test_the_app_jwt_is_signed_with_the_private_key_and_short_lived(github):
    token = github_app.app_jwt()
    claims = jwt.decode(token, PUBLIC_KEY, algorithms=["RS256"])
    assert claims["iss"] == APP_ID and 0 < claims["exp"] - time.time() <= 600 and claims["iat"] <= time.time()
    assert github_app.app_jwt() == token                                              # reused while it is valid


def test_nothing_about_repository_access_works_without_a_configured_app(github, monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_APP_ID", "")
    client = browser()
    sign_in(client)                                                                   # plain sign-in still works
    assert client.get("/api/v1/auth/me").json()["repository_access"] == {"configured": False}
    assert set(sessions.verify(client.cookies.get(auth.SESSION_COOKIE))) == {"user", "exp"}   # and keeps no token
    listing = client.get("/api/v1/github/repositories")
    assert listing.status_code == 503 and listing.json()["error_code"] == "GITHUB_APP_NOT_CONFIGURED"
    assert client.get("/api/v1/auth/github/install").headers["location"] == "http://localhost:5173/repositories?github_setup=not_configured"


# ---- Installations and the repository list ------------------------------------------------------

def test_the_list_holds_the_users_installations_and_only_their_repositories(github):
    client = browser()
    sign_in(client)
    data = client.get("/api/v1/github/repositories").json()
    assert [r["full_name"] for r in data["repositories"]] == ["alice/ledger", "alice/notes"]   # not bob/vault
    ledger = data["repositories"][0]
    assert ledger == {"id": 9001, "name": "ledger", "owner": "alice", "full_name": "alice/ledger", "private": True, "language": "Python",
                      "default_branch": "main", "updated_at": "2026-10-01T10:00:00Z", "html_url": "https://github.com/alice/ledger",
                      "archived": False, "installation_id": 101}
    personal, org = data["installations"]
    assert personal["account"]["login"] == "alice" and personal["repository_selection"] == "selected" and personal["missing_permissions"] == []
    assert personal["manage_url"] == "https://github.com/settings/installations/101"
    # The organization's installation lacks the contents permission: listed, and said so.
    assert org["missing_permissions"] == ["contents"] and org["manage_url"] == "https://github.com/organizations/acme-org/settings/installations/202"
    assert data["complete"] is True and data["install_url"] == "/api/v1/auth/github/install"
    assert "token" not in json.dumps(data).replace("access_tokens", "")


def test_a_user_without_an_installation_gets_an_empty_list_and_the_way_to_install(github):
    client = browser()
    sign_in(client, code="code-carol")
    data = client.get("/api/v1/github/repositories").json()
    assert data["installations"] == [] and data["repositories"] == [] and data["install_url"] == "/api/v1/auth/github/install"
    install = client.get("/api/v1/auth/github/install", params={"return_to": FRONTEND})
    location = urlparse(install.headers["location"])
    assert f"{location.scheme}://{location.netloc}{location.path}" == "https://github.com/apps/driftlock-test/installations/new"
    state = parse_qs(location.query)["state"][0]
    # GitHub sends the user back to the Setup URL; the state decides where to return to.
    back = client.get("/api/v1/auth/github/setup", params={"installation_id": "404", "setup_action": "install", "state": state})
    assert back.headers["location"] == f"{FRONTEND}/repositories?github_setup=install"
    approval = browser().get("/api/v1/auth/github/setup", params={"setup_action": "request"})       # an org owner must approve
    assert approval.headers["location"] == "http://localhost:5173/repositories?github_setup=request"
    assert browser().get("/api/v1/auth/github/install").headers["location"] == "http://localhost:5173/repositories?github_setup=sign_in_required"


def test_every_page_is_read_and_a_cap_is_reported_not_hidden(github, monkeypatch):
    github.bulk(202, 250)
    client = browser()
    sign_in(client)
    data = client.get("/api/v1/github/repositories").json()
    assert len(data["repositories"]) == 252 and data["complete"] is True
    pages = [url for method, url, _ in github.requests if "/user/installations/202/repositories" in url]
    assert [parse_qs(urlparse(url).query)["page"] for url in pages] == [["1"], ["2"], ["3"]]

    monkeypatch.setattr(settings, "GITHUB_REPOSITORY_PAGES", 2)
    capped = client.get("/api/v1/github/repositories", params={"refresh": "true"}).json()
    assert len(capped["repositories"]) == 202 and capped["complete"] is False         # 2 + 200 of 250: shown as incomplete


def test_the_list_is_kept_briefly_and_refresh_or_setup_reads_it_again(github):
    client = browser()
    sign_in(client)
    client.get("/api/v1/github/repositories")
    count = len(github.requests)
    assert client.get("/api/v1/github/repositories").json()["cached"] is True and len(github.requests) == count
    github.repos["alice/new"] = private_repo(9003, 101, {})
    refreshed = client.get("/api/v1/github/repositories", params={"refresh": "true"}).json()
    assert refreshed["cached"] is False and "alice/new" in [r["full_name"] for r in refreshed["repositories"]]
    github.repos["alice/newer"] = private_repo(9004, 101, {})
    client.get("/api/v1/auth/github/setup", params={"setup_action": "update"})
    assert "alice/newer" in [r["full_name"] for r in client.get("/api/v1/github/repositories").json()["repositories"]]


def test_a_rate_limit_or_an_outage_is_an_error_not_an_empty_list(github):
    client = browser()
    sign_in(client)
    github.fail["/user/installations"] = 429
    limited = client.get("/api/v1/github/repositories", params={"refresh": "true"})
    assert limited.status_code == 429 and limited.json()["error_code"] == "GITHUB_RATE_LIMITED"
    github.fail["/user/installations"] = 503
    down = client.get("/api/v1/github/repositories", params={"refresh": "true"})
    assert down.status_code == 502 and down.json()["error_code"] == "GITHUB_UNAVAILABLE"


# ---- Scans ------------------------------------------------------------------------------------

def test_a_private_repository_is_scanned_with_a_narrowed_installation_token(github):
    client = browser()
    sign_in(client)
    response = scan(client, "alice/ledger", "acme/service-b")
    assert response.status_code == 200
    record = response.json()
    assert record["status"] == "COMPLETED"
    details = {d["name"]: d for d in record["result"]["repository_details"]}
    assert details["ledger"]["error"] is None and details["ledger"]["manifests"] == ["requirements.txt"] and details["ledger"]["code_scanned"] is True
    pydantic = next(row for row in record["result"]["drift_matrix"] if row["dependency_name"] == "pydantic")
    assert pydantic["declarations_by_repo"]["ledger"]["declared_range"] == "==1.10.13"
    assert "ledger" in [e["provider_repo"] for e in record["result"]["contract_analysis"]]     # its specification was read too

    (issued,) = github.tokens.items()                                                # one token, for this repository only
    assert issued[1] == (101, {9001})
    private_reads = [(url, header) for _, url, header in github.requests if "/alice/ledger" in url and "api.github.com/repos" in url and not url.endswith("/installation")]
    wrong = [(url, header[:20]) for url, header in private_reads if "/repos/alice/ledger/" in url and header != f"Bearer {issued[0]}"]
    assert private_reads and not wrong, wrong
    assert any("/repos/alice/ledger/zipball/" in url for url, _ in private_reads)
    # The public repository is read the ordinary way, never with this user's or this scan's credentials. The user's
    # token only asked GitHub, once, whether they can see it.
    assert all(not header for _, url, header in github.requests if "/repos/acme/service-b/" in url or "codeload.github.com/acme/service-b" in url)
    assert [header for _, url, header in github.requests if url.endswith("/repos/acme/service-b")] == ["Bearer user-token-alice", ""]  # the check, then the ordinary read


def test_results_of_a_private_scan_are_readable_by_its_owner_only(github):
    alice = browser()
    sign_in(alice)
    scan_id = scan(alice, "alice/ledger", "acme/service-b").json()["scan_id"]
    assert scan_store.owner(scan_id) == "1"
    assert alice.get(f"/api/v1/scans/{scan_id}").status_code == 200
    bob = browser()
    sign_in(bob, code="code-bob")
    for other in (bob, browser()):
        hidden = other.get(f"/api/v1/scans/{scan_id}")
        assert hidden.status_code == 404 and hidden.json()["error_code"] == "SCAN_NOT_FOUND"
    public_id = scan(browser(), "acme/service-a", "acme/service-b").json()["scan_id"]
    assert scan_store.owner(public_id) is None and browser().get(f"/api/v1/scans/{public_id}").status_code == 200


def test_a_private_repository_the_user_cannot_access_is_rejected_before_anything_is_read(github):
    alice = browser()
    sign_in(alice)
    before = len(github.tokens)
    refused = scan(alice, "bob/vault", "acme/service-b")
    assert refused.status_code == 403 and refused.json()["error_code"] == "REPOSITORY_NOT_AUTHORIZED"
    assert "bob/vault was not found, or your GitHub sign-in has no access to it" in refused.json()["message"]
    assert len(github.tokens) == before and not any("/repos/bob/vault/contents" in url for _, url, _ in github.requests)
    # Nothing in the request can claim access: there is no field for it, and a forged one is ignored.
    forged = alice.post("/api/v1/scans?wait=true", json={"repository_targets": [
        {"type": "github", "url": "https://github.com/bob/vault", "installation_id": 303, "repository_id": 9100, "private": True},
        {"type": "github", "url": "https://github.com/acme/service-b"}]})
    assert forged.status_code == 403


def test_two_users_never_share_credentials(github):
    alice, bob = browser(), browser()
    sign_in(alice)
    sign_in(bob, code="code-bob")
    assert scan(alice, "alice/ledger", "acme/service-b").json()["status"] == "COMPLETED"
    assert scan(bob, "bob/vault", "acme/service-b").json()["status"] == "COMPLETED"
    assert scan(bob, "alice/ledger", "acme/service-b").status_code == 403
    tokens = {token: grant for token, grant in github.tokens.items()}
    assert sorted(grant for grant in [(i, tuple(r)) for i, r in tokens.values()]) == [(101, (9001,)), (303, (9100,))]
    alice_token = next(t for t, (i, _) in tokens.items() if i == 101)
    assert not any(header == f"Bearer {alice_token}" and "/bob/" in url for _, url, header in github.requests)
    # A second scan by the same user mints a new token: nothing is carried from one scan to the next.
    scan(alice, "alice/ledger", "acme/service-b")
    assert len([1 for i, _ in github.tokens.values() if i == 101]) == 2


def test_signed_out_and_shared_token_scans_never_read_a_private_repository(github, monkeypatch):
    anonymous = scan(browser(), "alice/ledger", "acme/service-b").json()
    ledger = {d["name"]: d for d in anonymous["result"]["repository_details"]}["ledger"]
    assert ledger["error"] == "alice/ledger was not found, or the repository is private" and ledger["manifests"] == []
    # A backend token that could see the repository is not used to read it on a user's behalf.
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "shared-pat")
    shared = scan(browser(), "alice/ledger", "acme/service-b").json()
    ledger = {d["name"]: d for d in shared["result"]["repository_details"]}["ledger"]
    assert ledger["error"].startswith("alice/ledger is private. Scanning it needs Sign in with GitHub")
    assert not any("/repos/alice/ledger/contents" in url or "/repos/alice/ledger/git" in url for _, url, _ in github.requests)


def test_revoked_access_during_a_scan_is_reported_and_never_read_as_an_empty_repository(github):
    client = browser()
    sign_in(client)
    github.fail["/repos/alice/ledger/git/trees"] = 401
    record = scan(client, "alice/ledger", "acme/service-b").json()
    ledger = {d["name"]: d for d in record["result"]["repository_details"]}["ledger"]
    assert ledger["error"] == "GitHub refused access to alice/ledger: the access granted to DriftLock is missing, expired or was revoked"
    assert ledger["manifests"] == []


def test_private_archive_and_specification_failures_are_surfaced_honestly(github):
    client = browser()
    sign_in(client)
    github.fail["/repos/alice/ledger/zipball/"] = 401
    github.fail["/repos/alice/ledger/contents/openapi.yaml"] = 404
    record = scan(client, "alice/ledger", "acme/service-b").json()
    warnings = record["result"]["warnings"]
    assert "ledger: code scan skipped (GitHub refused access to the source archive: the access granted to DriftLock is missing, expired or was revoked)." in warnings
    assert any("openapi.yaml could not be read with the access granted to DriftLock: GitHub answered not found" in w for w in warnings)
    ledger = {d["name"]: d for d in record["result"]["repository_details"]}["ledger"]
    assert ledger["code_scanned"] is False and ledger["manifests"] == ["requirements.txt"]
    spec = next(e for e in record["result"]["contract_analysis"] if e["provider_repo"] == "ledger")
    assert spec["status"] == "SPEC_UNAVAILABLE" and "could not be read" in spec["message"]


def test_access_checks_report_github_failures_instead_of_scanning(github):
    client = browser()
    sign_in(client)
    github.fail["/repos/alice/ledger/installation"] = 401                           # the App's own credentials are refused
    misconfigured = scan(client, "alice/ledger", "acme/service-b")
    assert misconfigured.status_code == 503 and misconfigured.json()["error_code"] == "GITHUB_APP_MISCONFIGURED"
    github.fail.clear()
    github.fail["/app/installations/101/access_tokens"] = 422                      # the installation changed meanwhile
    changed = scan(client, "alice/ledger", "acme/service-b")
    assert changed.status_code == 403 and "installation or its permissions changed" in changed.json()["message"]
    github.fail.clear()
    github.fail["/repos/alice/ledger"] = 503
    assert scan(client, "alice/ledger", "acme/service-b").json()["error_code"] == "GITHUB_UNAVAILABLE"


# ---- The credential plumbing ----------------------------------------------------------------------

def test_credentials_apply_to_their_own_repository_only_and_never_appear_in_text():
    credentials = RepoCredentials()
    credential = RepoCredential("ghs_secret", time.time() + 3600, 101, 9001)
    credentials.add("Alice", "Ledger", credential)
    assert credentials.for_url("https://api.github.com/repos/alice/ledger/contents/a.txt?ref=x") is credential
    assert credentials.for_url("https://raw.githubusercontent.com/alice/ledger/x/a.txt") is credential
    assert credentials.for_url("https://api.github.com/repos/alice/ledger-2/contents/a") is None
    assert credentials.for_url("https://api.github.com/repos/bob/ledger/contents/a") is None
    assert credentials.for_url("https://evil.example/repos/alice/ledger") is None
    assert "ghs_secret" not in repr(credential) + repr(credentials)


def test_a_private_response_is_never_cached_and_an_expired_credential_sends_nothing(tmp_path):
    seen = []

    def answer(request):
        seen.append((str(request.url), request.headers.get("authorization")))
        return httpx.Response(200, text="private text")

    cache = Cache(str(tmp_path / "cache.db"))
    credentials = RepoCredentials()
    credentials.add("alice", "ledger", RepoCredential("ghs_live", time.time() + 3600, 101, 9001))
    credentials.add("alice", "old", RepoCredential("ghs_dead", time.time() - 1, 101, 9002))
    http = Http(transport=httpx.MockTransport(answer), cache=cache, github_token="shared-pat", retries=0, credentials=credentials)
    import asyncio

    url = "https://api.github.com/repos/alice/ledger/contents/a.txt?ref=x"
    for _ in range(2):
        assert asyncio.run(http.get_text(url, ttl=3600)) == "private text"
    assert len(seen) == 2 and all(header == "Bearer ghs_live" for _, header in seen)   # its own token, not the shared one, and no cache
    assert cache.get(f"GET {url} ") is None
    with pytest.raises(FetchError) as error:
        asyncio.run(http.get_text("https://api.github.com/repos/alice/old/contents/a.txt", ttl=3600))
    assert error.value.kind == "unauthorized" and len(seen) == 2
    asyncio.run(http.get_text("https://api.github.com/repos/acme/public/contents/a.txt", ttl=3600))
    assert seen[-1][1] == "Bearer shared-pat"                                            # public repositories are unchanged
