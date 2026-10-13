"""Scan runner and scan API tests. All upstream calls go to tests/fakes.py."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.schemas.scan import ScanCreateRequest
from app.services import github_fetcher, scan_runner
from app.services.scan_store import ScanStore
from tests.fakes import fake_http

client = TestClient(app)
GH = "https://github.com/acme/"


def github(*names):
    return [{"type": "github", "url": GH + name} for name in names]


def scan(targets, options=None, overrides=None):
    request = ScanCreateRequest(repository_targets=targets, options=options or {})
    store = ScanStore()
    record = store.create()
    asyncio.run(scan_runner.run_scan(record.scan_id, scan_runner.validate_request(request), request.options, store, fake_http(overrides)))
    return store.get(record.scan_id)


def row(record, drift_id):
    return next(r for r in record.result["drift_matrix"] if r["id"] == drift_id)


@pytest.fixture(autouse=True)
def no_live_network(monkeypatch):
    """The API path builds its own Http; point it at the fake and disable the cache."""
    monkeypatch.setattr(scan_runner, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    # Tests must behave the same whether or not a developer has keys in backend/.env.
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")


def test_full_scan_of_three_repositories():
    record = scan(github("service-a", "service-b", "service-c"))
    assert record.status == "COMPLETED" and record.error is None and record.duration_seconds is not None
    result = record.result

    pydantic = row(record, "python:pydantic")
    assert pydantic["drift_disparity"] == "MAJOR_DRIFT" and pydantic["compatibility_risk"] == "CONFIRMED_BREAKING"
    assert pydantic["declarations_by_repo"]["service-a"] == {
        "declared_range": "==1.10.13", "resolved_version": None, "dep_type": "runtime", "source_file": "requirements.txt"}
    assert pydantic["missing_in_repos"] == ["service-c"]
    assert pydantic["evidence"]["verified_breaking"] is True and "BREAKING" in pydantic["evidence"]["cited_excerpt"]
    assert pydantic["evidence"]["notes"] == "" and pydantic["explanation"]["source"] == "template"
    assert pydantic["score"] == 90 and pydantic["risk_level"] == "Critical"

    axios = row(record, "npm:axios")
    assert (axios["drift_disparity"], axios["compatibility_risk"]) == ("MAJOR_DRIFT", "SUSPECTED_BREAKING")
    assert axios["declarations_by_repo"]["service-a"]["resolved_version"] == "0.27.2"   # from package-lock.json
    assert axios["declarations_by_repo"]["service-c"]["resolved_version"] is None        # no lockfile: not invented
    assert axios["evidence"] is None and "lockfile" in axios["signals_missing"]
    assert "no breaking marker was found" in axios["explanation"]["text"]

    lodash = row(record, "npm:lodash")
    assert (lodash["drift_disparity"], lodash["compatibility_risk"]) == ("MINOR_DRIFT", "NONE")  # does not cry wolf
    assert lodash["score"] == 0 and lodash["recommended_version"] == "4.17.21"
    assert lodash["vulnerabilities"] == [{"id": "GHSA-TEST-0001", "summary": "Test advisory", "fixed_in": "4.17.21", "affects_repo": "service-a"}]

    requests = row(record, "python:requests")
    assert requests["drift_disparity"] == "INFO" and "score" not in requests and requests["recommended_version"] is None

    hits = [i for i in result["code_impact"] if i["impact"].startswith("Tier 2")]
    assert {(i["repository"], i["file"], i["line"]) for i in hits} == {
        ("service-a", "models/user.py", 7), ("service-a", "models/user.py", 11), ("service-a", "models/user.py", 12)}
    assert any(i["dependency_name"] == "axios" and i["impact"].startswith("Tier 1") for i in result["code_impact"])

    assert result["summary"]["severity_counts"] == {"MAJOR_DRIFT": 2, "MINOR_DRIFT": 1, "INFO": 1, "IN_SYNC": 0}
    assert result["summary"]["drift_count"] == 3 and result["summary"]["total_unique_dependencies"] == 4
    assert result["graph_summary"]["highest_drift_nodes"][:2] == ["axios", "pydantic"]
    assert [r["name"] for r in result["scanned_repositories"]] == ["service-a", "service-b", "service-c"]
    assert result["scanned_repositories"][0]["manifest_count"] == 3  # node_modules/ is ignored
    assert any("unsupported spec" in item for item in result["skipped_items"])
    assert any("workspace:*" in item for item in result["skipped_items"])
    assert {s["name"]: s["status"] for s in result["data_sources"]}["Gemini"] == "not_configured"


def test_one_missing_repository_gives_a_partial_result():
    record = scan(github("service-a", "service-b", "does-not-exist"))
    assert record.status == "COMPLETED"
    assert any("does-not-exist" in w and "not found, or the repository is private" in w for w in record.result["warnings"])
    assert record.result["scanned_repositories"][2] == {"name": "does-not-exist", "url": GH + "does-not-exist", "manifest_count": 0, "total_dependencies": 0}
    assert row(record, "python:pydantic")["drift_disparity"] == "MAJOR_DRIFT"


def test_repository_without_manifests_is_reported_not_dropped():
    record = scan(github("service-a", "service-b", "empty"))
    assert any("empty: no supported manifest found" in w for w in record.result["warnings"])
    assert row(record, "python:pydantic")["missing_in_repos"] == ["empty"]


def test_scan_fails_only_when_nothing_could_be_analyzed():
    record = scan(github("nope-1", "nope-2"))
    assert record.status == "FAILED" and record.result is None
    assert record.error["error_code"] == "NO_REPOSITORIES_ANALYZED"


def test_rate_limit_is_reported_clearly():
    limited = lambda request: httpx.Response(403, headers={"x-ratelimit-remaining": "0"}) if request.url.host == "api.github.com" else None
    record = scan(github("service-a", "service-b"), overrides=limited)
    assert record.status == "FAILED" and record.error["error_code"] == "RATE_LIMIT_EXCEEDED"
    assert "rate limit" in record.error["message"].lower()


def test_upstream_failures_degrade_instead_of_failing():
    def broken(request):
        if request.url.host in ("registry.npmjs.org", "pypi.org", "api.osv.dev", "codeload.github.com"):
            return httpx.Response(500)
        return None

    record = scan(github("service-a", "service-b", "service-c"), overrides=broken)
    assert record.status == "COMPLETED"
    pydantic = row(record, "python:pydantic")          # exact pins still compare without a registry
    # Two exact pins on different majors cannot overlap, so this stays "suspected"; nothing confirms it.
    assert pydantic["drift_disparity"] == "MAJOR_DRIFT" and pydantic["compatibility_risk"] == "SUSPECTED_BREAKING"
    assert {"registry", "vulnerabilities", "changelog", "code_scan"} <= set(pydantic["signals_missing"])
    assert pydantic["confidence"] < 0.6
    axios = row(record, "npm:axios")                   # one side is a range that cannot be resolved
    assert (axios["drift_disparity"], axios["compatibility_risk"], axios["recommended_version"]) == ("INFO", "UNKNOWN_IMPACT", None)
    assert "score" not in axios
    assert any("Registry lookup failed" in w for w in record.result["warnings"])
    assert any("code scan skipped" in w for w in record.result["warnings"])


def test_branch_names_with_slashes_and_subfolders():
    http = fake_http()
    assert asyncio.run(github_fetcher.resolve_ref(http, "acme", "service-c", "feature/axios-upgrade")) == ("feature/axios-upgrade", "d" * 40, "")
    assert asyncio.run(github_fetcher.resolve_ref(http, "acme", "service-c", "feature/axios-upgrade/web")) == ("feature/axios-upgrade", "d" * 40, "web")
    assert asyncio.run(github_fetcher.resolve_ref(http, "acme", "service-c", "nope/x")) is None
    scoped = asyncio.run(github_fetcher.fetch_repo(http, "acme", "service-c", "feature/axios-upgrade/web"))
    assert list(scoped.files) == ["web/package.json"]

    record = scan([{"type": "github", "url": GH + "service-a"}, {"type": "github", "url": GH + "service-c/tree/missing-branch"}])
    assert any('"missing-branch" could not be resolved' in w for w in record.result["warnings"])


def test_same_repository_on_two_branches_gets_distinct_names():
    record = scan([{"type": "github", "url": GH + "service-c"}, {"type": "github", "url": GH + "service-c", "ref": "feature/axios-upgrade"}])
    assert [r["name"] for r in record.result["scanned_repositories"]] == ["acme/service-c@default", "acme/service-c@feature/axios-upgrade"]


def test_pasted_manifests_are_compared_without_a_code_scan():
    record = scan([
        {"type": "pasted", "name": "billing", "files": [{"filename": "package.json", "content": json.dumps({"dependencies": {"axios": "^0.27.2"}})}]},
        {"type": "github", "url": GH + "service-c"},
    ])
    axios = row(record, "npm:axios")
    assert axios["drift_disparity"] == "MAJOR_DRIFT" and "code_scan" in axios["signals_missing"]
    assert any("billing: pasted input" in w for w in record.result["warnings"])
    assert record.result["scanned_repositories"][0] == {"name": "billing", "url": None, "manifest_count": 1, "total_dependencies": 1}


def test_options_turn_slow_stages_off():
    record = scan(github("service-a", "service-b"), options={"check_changelogs": False, "check_vulnerabilities": False, "scan_code": False})
    pydantic = row(record, "python:pydantic")
    assert pydantic["evidence"] is None and record.result["code_impact"] is None
    assert pydantic["compatibility_risk"] == "SUSPECTED_BREAKING"


# ---- API --------------------------------------------------------------------

def test_health_shape():
    for path in ("/health", "/api/v1/health"):
        data = client.get(path).json()
        assert data["status"] == "healthy" and isinstance(data["timestamp"], str)
        assert set(data["services"]) == {"github_api", "gemini_api", "cache"}
        assert "pom.xml" in data["supported_manifests"]
        assert "KEY" not in json.dumps(data).upper().replace("GEMINI_API", "")


def test_create_poll_and_contract_keys():
    response = client.post("/api/v1/scans", json={"repository_targets": github("service-a", "service-b", "service-c")})
    assert response.status_code == 202
    accepted = response.json()
    assert accepted["status"] == "QUEUED" and accepted["poll_url"] == f"/api/v1/scans/{accepted['scan_id']}"

    record = client.get(accepted["poll_url"]).json()
    # Exactly the keys frontend/src/api/parseScan.ts reads.
    assert set(record) == {"scan_id", "status", "created_at", "updated_at", "completed_at", "duration_seconds", "progress", "result", "error"}
    assert record["status"] == "COMPLETED" and record["progress"]["percentage"] == 100
    result = record["result"]
    assert {"scanned_repositories", "summary", "drift_matrix", "graph_summary", "warnings", "skipped_items", "contract_analysis", "code_impact"} <= set(result)
    assert set(result["summary"]) == {"total_unique_dependencies", "shared_dependencies_count", "drift_count", "in_sync_count", "severity_counts", "compatibility_risk_counts"}
    assert set(result["graph_summary"]) == {"total_nodes", "total_edges", "density", "highest_drift_nodes"}
    drift = result["drift_matrix"][0]
    assert {"id", "dependency_name", "ecosystem", "drift_disparity", "compatibility_risk", "declarations_by_repo",
            "present_in_repos", "missing_in_repos", "recommended_version", "evidence"} <= set(drift)
    assert drift["id"] == f"{drift['ecosystem']}:{drift['dependency_name']}"
    assert all(isinstance(item, str) for item in result["skipped_items"] + result["warnings"])
    assert set(result["code_impact"][0]) == {"repository", "file", "line", "snippet", "related_change", "dependency_name", "impact", "confidence", "limitations"}
    assert result["contract_analysis"] is None


def test_wait_returns_the_finished_record():
    response = client.post("/api/v1/scans?wait=true", json={"repository_targets": github("service-a", "service-b")})
    assert response.status_code == 200 and response.json()["status"] == "COMPLETED"


@pytest.mark.parametrize("targets, fragment", [
    (github("service-a"), "between 2 and 10"),
    (github(*[f"r{i}" for i in range(11)]), "between 2 and 10"),
    ([{"type": "github", "url": "https://gitlab.com/a/b"}, {"type": "github", "url": GH + "service-a"}], "Target 1"),
    ([{"type": "github", "url": GH + "service-a/blob/main/x"}, {"type": "github", "url": GH + "service-b"}], "/tree/"),
    (github("service-a", "service-a"), "more than once"),
    ([{"type": "pasted", "name": "x", "files": [{"filename": "setup.py", "content": "x"}]}, *github("service-a")], "not a supported manifest"),
    ([{"type": "pasted", "name": "x", "files": [{"filename": "package.json", "content": "x" * 204801}]}, *github("service-a")], "200 KB"),
    ([{"type": "pasted", "name": "", "files": [{"filename": "package.json", "content": "{}"}]}, *github("service-a")], "needs a name"),
    ([{"type": "pasted", "name": "x", "files": []}, *github("service-a")], "at least one manifest"),
])
def test_invalid_targets_are_rejected_with_the_contract_error_shape(targets, fragment):
    response = client.post("/api/v1/scans", json={"repository_targets": targets})
    assert response.status_code == 400
    body = response.json()
    assert body["error_code"] == "INVALID_TARGETS" and fragment in body["message"]


def test_malformed_body_and_unknown_scan():
    bad = client.post("/api/v1/scans", json={"repository_targets": "nope"})
    assert bad.status_code == 400 and bad.json()["error_code"] == "INVALID_REQUEST"
    missing = client.get("/api/v1/scans/scn_missing123")
    assert missing.status_code == 404 and missing.json()["error_code"] == "SCAN_NOT_FOUND"


def test_error_messages_never_echo_pasted_content():
    secret = "SECRET-TOKEN-123"
    response = client.post("/api/v1/scans", json={"repository_targets": [
        {"type": "pasted", "name": "x", "files": [{"filename": "notes.txt", "content": secret}]}, *github("service-a")]})
    assert response.status_code == 400 and secret not in response.text


def test_demo_endpoint_serves_a_saved_run_or_says_none_exists():
    response = client.get("/api/v1/demo")
    assert response.status_code in (200, 404)
    if response.status_code == 404:
        assert response.json()["error_code"] == "DEMO_NOT_AVAILABLE"
    else:
        assert response.json()["status"] == "COMPLETED"
