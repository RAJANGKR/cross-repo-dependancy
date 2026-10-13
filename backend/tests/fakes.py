"""A fake GitHub, npm, PyPI, Maven Central and OSV for tests. Nothing here
touches the network: every request is answered by `httpx.MockTransport`."""
import io
import json
import zipfile
from typing import Callable, Dict, Optional

import httpx

from app.services.http import Http

USER_PY = '''from pydantic import BaseModel, validator


class User(BaseModel):
    email: str

    @validator("email")
    def normalize(cls, value):
        return value.strip().lower()

    class Config:
        orm_mode = True
'''

REPOS: Dict[str, dict] = {
    "acme/service-a": {
        "default_branch": "main",
        "refs": {"main": "a" * 40},
        "files": {
            "requirements.txt": "# api\npydantic==1.10.13\nrequests>=2.25  # http\n-e git+https://github.com/acme/internal.git#egg=internal\n",
            "package.json": json.dumps({"dependencies": {"axios": "^0.27.2", "lodash": "^4.17.20", "left": "workspace:*"}}),
            "package-lock.json": json.dumps({"lockfileVersion": 3, "packages": {
                "": {}, "node_modules/axios": {"version": "0.27.2"}, "node_modules/lodash": {"version": "4.17.20"},
                "node_modules/axios/node_modules/follow-redirects": {"version": "1.15.0"}}}),
            "models/user.py": USER_PY,
            "src/http.js": "import axios from 'axios'\nconst _ = require('lodash/debounce')\n",
            "node_modules/x/package.json": json.dumps({"dependencies": {"axios": "9.9.9"}}),
        },
    },
    "acme/service-b": {
        "default_branch": "main",
        "refs": {"main": "b" * 40},
        "files": {"requirements.txt": "pydantic==2.5.0\n", "app.py": "from pydantic import BaseModel, field_validator\n"},
    },
    "acme/service-c": {
        "default_branch": "main",
        "refs": {"main": "c" * 40, "feature/axios-upgrade": "d" * 40},
        "files": {
            "package.json": json.dumps({"dependencies": {"axios": "^1.6.2", "lodash": "^4.17.21"}}),
            "web/package.json": json.dumps({"dependencies": {"axios": "^1.6.2"}}),
        },
    },
    "acme/empty": {"default_branch": "main", "refs": {"main": "e" * 40}, "files": {"README.md": "nothing here"}},
}

NPM = {
    "axios": {"versions": ["0.21.4", "0.27.2", "1.0.0", "1.6.2", "1.6.8", "2.0.0-beta.1"], "repo": "git+https://github.com/axios/axios.git"},
    "lodash": {"versions": ["4.17.20", "4.17.21"], "repo": "git+https://github.com/lodash/lodash.git"},
}
PYPI = {"pydantic": {"versions": ["1.10.13", "2.0.0", "2.5.0"], "urls": {"Source": "https://github.com/pydantic/pydantic"}}}
RELEASES = {
    "pydantic/pydantic": [
        {"tag_name": "v2.0.0", "html_url": "https://github.com/pydantic/pydantic/releases/tag/v2.0.0",
         "body": "## What's new\n- Rewritten core in Rust\n- BREAKING: `@validator` is replaced by `@field_validator`\n"},
        {"tag_name": "v2.6.0", "html_url": "https://github.com/pydantic/pydantic/releases/tag/v2.6.0", "body": "- removed everything (outside the compared range)"},
    ],
    "axios/axios": [{"tag_name": "v1.0.0", "html_url": "https://github.com/axios/axios/releases/tag/v1.0.0", "body": "- Bug fixes and improvements\n"}],
    "lodash/lodash": [],
}
OSV = {("npm", "lodash", "4.17.20"): [{"id": "GHSA-TEST-0001", "summary": "Test advisory", "affected": [{"ranges": [{"events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]}]}]}


def zip_of(files: Dict[str, str], top: str = "repo-sha") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, text in files.items():
            archive.writestr(f"{top}/{path}", text)
    return buffer.getvalue()


def handler(request: httpx.Request, overrides: Optional[Callable[[httpx.Request], Optional[httpx.Response]]] = None) -> httpx.Response:
    if overrides:
        custom = overrides(request)
        if custom is not None:
            return custom
    host, path = request.url.host, request.url.path
    limit = {"x-ratelimit-remaining": "57"}

    if host == "github.com" and path == "/login/oauth/access_token":
        body = json.loads(request.content)
        good = body.get("code") == "good-code"
        return httpx.Response(200, json={"access_token": "gho_test_token"} if good else {"error": "bad_verification_code"})
    if host == "api.github.com" and path == "/user":
        if request.headers.get("authorization") != "Bearer gho_test_token":
            return httpx.Response(401)
        return httpx.Response(200, json={"id": 42, "login": "octocat", "name": "The Octocat", "avatar_url": "https://avatars.githubusercontent.com/u/42"})
    if host == "api.github.com":
        parts = path.strip("/").split("/")
        key = "/".join(parts[1:3])
        repo = REPOS.get(key)
        rest = parts[3:]
        if rest[:1] == ["releases"]:
            return httpx.Response(200, json=RELEASES[key], headers=limit) if key in RELEASES else httpx.Response(404, headers=limit)
        if repo is None:
            return httpx.Response(404, json={"message": "Not Found"}, headers=limit)
        if not rest:
            return httpx.Response(200, json={"default_branch": repo["default_branch"]}, headers=limit)
        if rest[0] == "commits":
            sha = repo["refs"].get("/".join(rest[1:]))
            return httpx.Response(200, text=sha, headers=limit) if sha else httpx.Response(422, headers=limit)
        if rest[0] == "contents":
            content = repo["files"].get("/".join(rest[1:]))
            return httpx.Response(200, text=content, headers=limit) if content is not None else httpx.Response(404, headers=limit)
        if rest[:2] == ["git", "trees"]:
            tree = [{"path": p, "type": "blob", "size": len(c)} for p, c in repo["files"].items()]
            return httpx.Response(200, json={"tree": tree, "truncated": False}, headers=limit)
    if host == "raw.githubusercontent.com":
        owner, name, _sha, *file_parts = path.strip("/").split("/")
        content = REPOS.get(f"{owner}/{name}", {}).get("files", {}).get("/".join(file_parts))
        return httpx.Response(200, text=content) if content is not None else httpx.Response(404)
    if host == "codeload.github.com":
        owner, name = path.strip("/").split("/")[:2]
        return httpx.Response(200, content=zip_of(REPOS[f"{owner}/{name}"]["files"]))
    if host == "registry.npmjs.org":
        package = NPM.get(path.strip("/"))
        if not package:
            return httpx.Response(404)
        return httpx.Response(200, json={"versions": {v: {} for v in package["versions"]}, "repository": {"url": package["repo"]}})
    if host == "pypi.org":
        package = PYPI.get(path.strip("/").split("/")[1])
        if not package:
            return httpx.Response(404)
        return httpx.Response(200, json={"info": {"project_urls": package["urls"]}, "releases": {v: [{"yanked": False}] for v in package["versions"]}})
    if host == "repo1.maven.org":
        return httpx.Response(200, text="<metadata><versioning><versions><version>2.9.10</version><version>2.15.2</version></versions></versioning></metadata>")
    if host == "api.osv.dev":
        body = json.loads(request.content)
        vulns = OSV.get((body["package"]["ecosystem"], body["package"]["name"], body["version"]), [])
        return httpx.Response(200, json={"vulns": vulns} if vulns else {})
    if host == "generativelanguage.googleapis.com":
        return httpx.Response(200, json={
            "candidates": [{
                "content": {
                    "parts": [{"text": "Pydantic validator changed to field_validator. Update validation methods."}]
                }
            }]
        })
    return httpx.Response(404)


def fake_http(overrides=None) -> Http:
    return Http(transport=httpx.MockTransport(lambda request: handler(request, overrides)), cache=None, retries=1, backoff=0)
