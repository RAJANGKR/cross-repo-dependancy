"""OpenAPI contract analysis: discovery, relationship rules, the diff, consumer
references and the response shape the dashboard reads. All HTTP is mocked."""
import asyncio
import json
import os
import re
from pathlib import Path

import httpx
import pytest

from app.core.config import settings
from app.services import github_fetcher, scan_runner
from app.services import openapi_diff_engine as engine
from app.services.openapi_diff_engine import RepoInput, Spec, analyze_specs, diff_specs, find_references, parse_spec
from tests.fakes import INVENTORY, ORDERS_V1, ORDERS_V2, fake_http
from tests.test_scans import github, row, scan

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "frontend" / "src" / "api" / "fixtures" / "contract-analysis.json"
SCAN_TYPES = ROOT / "frontend" / "src" / "api" / "scanTypes.ts"


@pytest.fixture(autouse=True)
def no_keys(monkeypatch):
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(settings, "AUTH_REQUIRED", False)  # sign-in is covered separately below and in test_auth.py


def spec(doc, repo="r", file="openapi.json"):
    return Spec(repo, file, doc if isinstance(doc, dict) else parse_spec(doc, file))


def api(version, paths, title="Users API", **info):
    return {"openapi": "3.0.3", "info": {"title": title, "version": version, **info}, "paths": paths}


def op(**fields):
    return {"responses": {"200": {"description": "ok"}}, **fields}


def json_body(schema, required=True):
    return {"required": required, "content": {"application/json": {"schema": schema}}}


def json_response(schema):
    return {"200": {"description": "ok", "content": {"application/json": {"schema": schema}}}}


def entries(record, status=None, provider=None, consumer=None):
    return [
        e for e in record.result["contract_analysis"]
        if (status is None or e["status"] == status) and (provider is None or e["provider_repo"] == provider) and (consumer is None or e["consumer_repo"] == consumer)
    ]


def changes(findings):
    return {(f["change_type"], f["method"], f["path"]) for f in findings}


# ---- Parsing and discovery ---------------------------------------------------

def test_parses_openapi_3_and_swagger_2_in_json_and_yaml():
    assert parse_spec(ORDERS_V1, "openapi.yaml")["info"]["title"] == "Orders API"
    assert parse_spec(ORDERS_V2, "docs/openapi.json")["info"]["version"] == "2.0.0"
    assert spec(parse_spec(INVENTORY, "swagger.json")).dialect == "Swagger 2.0"
    assert spec(parse_spec("swagger: '2.0'\ninfo: {title: T, version: 1}\npaths: {}\n", "swagger.yml")).version_text == "1"


@pytest.mark.parametrize("content, filename", [
    ("", "openapi.yaml"),
    ("{not json", "openapi.json"),
    ("openapi: 3.0.0\npaths: [unclosed\n", "openapi.yaml"),
    ("- just\n- a list\n", "openapi.yaml"),
    ("info: {title: no version field}\n", "openapi.yaml"),
    ('{"openapi": "3.0.0", "paths": ["wrong"]}', "openapi.json"),
    ("!!python/object/apply:os.system ['echo unsafe']\n", "openapi.yaml"),  # safe_load refuses to construct objects
])
def test_malformed_specifications_raise_one_error_type(content, filename):
    with pytest.raises(engine.MalformedSpec):
        parse_spec(content, filename)


def test_discovery_is_limited_to_the_root_and_selected_folders():
    assert all(engine.is_spec_path(p) for p in ("openapi.yaml", "Swagger.JSON", "docs/openapi.yml", "api/v2/swagger.yaml", "src/main/resources/openapi.json", "spec/openapi.json"))
    assert not any(engine.is_spec_path(p) for p in ("package.json", "deep/elsewhere/openapi.json", "docs/api.yaml", "src/a/b/c/d/openapi.json"))

    fetched = asyncio.run(github_fetcher.fetch_repo(fake_http(), "acme", "orders-v2", None))
    assert list(fetched.specs) == ["docs/openapi.json"]            # not node_modules/, not deep/elsewhere/
    assert list(fetched.files) == ["package.json"]                 # manifests are untouched by discovery
    skipped = asyncio.run(github_fetcher.fetch_repo(fake_http(), "acme", "orders-v2", None, discover_specs=False))
    assert skipped.specs == {}


def test_discovery_downloads_specification_files_only():
    seen = []
    record = scan(github("service-a", "inventory"), overrides=lambda request: seen.append(str(request.url)) or None)
    assert record.status == "COMPLETED"
    assert sum("contents/swagger.json" in url for url in seen) == 1
    # One specification and no verified comparison: no source archive is fetched for contracts.
    assert not any("codeload.github.com/acme/inventory" in url for url in seen)


# ---- The diff ------------------------------------------------------------------

def test_removed_path_and_removed_operation():
    before = spec(api("1.0.0", {"/users": {"get": op(), "post": op()}, "/users/{id}": {"get": op(), "delete": op()}}))
    after = spec(api("2.0.0", {"/users/{userId}": {"get": op()}}))
    found = diff_specs(before, after)
    assert changes(found) == {("REMOVED_PATH", "", "/users"), ("REMOVED_OPERATION", "DELETE", "/users/{id}")}  # a renamed path parameter is not a removal
    removed = next(f for f in found if f["change_type"] == "REMOVED_PATH")
    assert removed["previous_value"] == "operations: GET, POST" and removed["new_value"] == "path not present"
    assert removed["json_pointer"] == "/paths/~1users" and removed["severity"] == "HIGH"
    assert removed["classification"] == "POTENTIALLY_BREAKING" and "not a confirmed runtime failure" in removed["impact"]


def test_newly_required_parameters_and_request_fields():
    old_body = {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}, "email": {"type": "string"}, "address": {"type": "object", "properties": {"zip": {"type": "string"}}}}}
    new_body = {"type": "object", "required": ["name", "email", "id"], "properties": {
        "name": {"type": "string"}, "email": {"type": "string"}, "id": {"type": "string", "readOnly": True},
        "address": {"type": "object", "required": ["zip"], "properties": {"zip": {"type": "string"}}}}}
    before = spec(api("1.0.0", {"/users": {
        "get": op(parameters=[{"name": "page", "in": "query"}]),
        "post": op(requestBody=json_body(old_body)),
        "put": op(requestBody=json_body(old_body, required=False)),
    }}))
    after = spec(api("1.1.0", {"/users": {
        "get": op(parameters=[{"name": "page", "in": "query", "required": True}, {"name": "X-Tenant", "in": "header", "required": True}, {"name": "sort", "in": "query"}]),
        "post": op(requestBody=json_body(new_body)),
        "put": op(requestBody=json_body(old_body, required=True)),
    }}))
    found = {(f["method"], f["previous_value"], f["new_value"]) for f in diff_specs(before, after)}
    assert found == {
        ("GET", "query parameter page: optional", "query parameter page: required"),
        ("GET", "header parameter X-Tenant: absent", "header parameter X-Tenant: required"),
        ("POST", "request field email: optional", "request field email: required"),       # `id` is readOnly: not sent by clients
        ("POST", "request field address.zip: optional", "request field address.zip: required"),
        ("PUT", "request body: optional", "request body: required"),
    }
    assert all(f["change_type"] == "NEW_REQUIRED_REQUEST_FIELD" for f in diff_specs(before, after))


def test_changed_response_field_types_including_nested_and_array_items():
    def users(id_type, count_type, tag_type):
        return api("1.0.0", {"/users": {"get": op(responses=json_response({"type": "object", "properties": {
            "count": {"type": count_type}, "data": {"type": "array", "items": {"$ref": "#/components/schemas/User"}}}}))}}) | {
            "components": {"schemas": {"User": {"type": "object", "properties": {"id": {"type": id_type}, "tags": {"type": "array", "items": {"type": tag_type}}, "self": {"$ref": "#/components/schemas/User"}}}}}}

    before, after = spec(users("integer", "number", "string")), spec(users("string", "integer", "integer"))
    after.doc["info"]["version"] = "2.0.0"
    found = diff_specs(before, after)
    assert {(f["previous_value"], f["new_value"]) for f in found} == {
        ("200 response field data[].id: integer", "200 response field data[].id: string"),
        ("200 response field data[].tags[]: string", "200 response field data[].tags[]: integer"),
    }  # number to integer only narrows the response, and the recursive `self` reference terminates
    pointer = next(f["json_pointer"] for f in found if "id" in f["new_value"])
    assert pointer == "/components/schemas/User/properties/id/type"


def test_additive_and_unresolvable_changes_are_not_reported():
    before = spec(api("1.0.0", {"/users": {"get": op(responses=json_response({"type": "object", "properties": {"id": {"type": "string"}}})), "post": op(requestBody=json_body({"$ref": "other.yaml#/Body"}))}}))
    after = spec(api("1.1.0", {
        "/users": {
            "get": op(parameters=[{"name": "q", "in": "query"}], responses=json_response({"type": "object", "properties": {"id": {"type": "string"}, "extra": {"type": "integer"}}})),
            "post": op(requestBody=json_body({"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}}})),  # previous schema is external: unknown, so no claim
            "patch": op(),
        },
        "/teams": {"get": op()},
    }))
    assert diff_specs(before, after) == []


def test_swagger_2_bodies_and_responses_are_compared():
    def swagger(version, required, id_type):
        return {"swagger": "2.0", "info": {"title": "Legacy", "version": version}, "paths": {"/pets": {"post": {
            "parameters": [{"name": "body", "in": "body", "required": True, "schema": {"$ref": "#/definitions/Pet"}}],
            "responses": {"201": {"description": "ok", "schema": {"$ref": "#/definitions/Pet"}}}}}},
            "definitions": {"Pet": {"type": "object", "required": required, "properties": {"id": {"type": id_type}, "name": {"type": "string"}}}}}

    found = diff_specs(spec(swagger("1.0", ["name"], "integer")), spec(swagger("2.0", ["name", "id"], "string")))
    assert changes(found) == {("NEW_REQUIRED_REQUEST_FIELD", "POST", "/pets"), ("CHANGED_RESPONSE_FIELD_TYPE", "POST", "/pets")}


# ---- Relationships -------------------------------------------------------------

def test_identity_needs_an_explicit_id_or_a_non_generic_title():
    assert engine.normalize_title("Users Service v2") == engine.normalize_title("users-service") == "usersservice"
    a, b = spec(api("1.0.0", {}, title="FastAPI"), "a"), spec(api("2.0.0", {}, title="FastAPI"), "b")   # framework default title
    groups, unusable = engine.same_api_groups([a, b])
    assert groups == [] and len(unusable) == 2 and "generic default" in unusable[0][1]

    c, d = spec(api("1.0.0", {}, title="Billing", **{"x-api-id": "billing-core"}), "c"), spec(api("2.0.0", {}, title="Totally renamed", **{"x-api-id": "Billing-Core"}), "d")
    assert [(basis, len(members)) for basis, members in engine.same_api_groups([c, d])[0]] == [("matching x-api-id", 2)]

    e, f = spec(api("1.0.0", {}, title="Billing", **{"x-api-id": "billing-eu"}), "e"), spec(api("2.0.0", {}, title="Billing"), "f")
    assert [len(members) for _, members in engine.same_api_groups([c, e])[0]] == [1, 1]   # same title, different ids: different APIs
    assert engine.same_api_groups([c, e, f])[1][0][0] is f                                  # and an id-less copy cannot be attributed


@pytest.mark.parametrize("raw, ordered", [("1.2.0", True), ("v2", True), ("2024-06-01", True), (1.0, True), ("latest", False), ("", False), (None, False), ("main-branch", False)])
def test_versions_must_be_orderable(raw, ordered):
    assert (engine.parse_api_version(raw) is not None) is ordered


def test_baseline_follows_the_version_not_submission_order():
    newer = RepoInput("first", {"openapi.json": json.dumps(api("2.0.0", {}))})
    older = RepoInput("second", {"openapi.json": json.dumps(api("1.0.0", {"/users": {"get": op()}}))})
    result, comparisons = analyze_specs([newer, older])
    assert [(c.baseline.repo, c.candidate.repo) for c in comparisons] == [("second", "first")]
    analyzed = [e for e in result if e["status"] == "ANALYZED"]
    assert [(e["provider_repo"], e["baseline"]["version"], e["candidate"]["version"]) for e in analyzed] == [("first", "1.0.0", "2.0.0")]
    assert changes(analyzed[0]["findings"]) == {("REMOVED_PATH", "", "/users")}


def test_three_versions_are_compared_in_adjacent_steps():
    repos = [RepoInput(name, {"openapi.json": json.dumps(api(version, paths))}) for name, version, paths in (
        ("c", "3.0.0", {}), ("a", "1.0.0", {"/a": {"get": op()}, "/b": {"get": op()}}), ("b", "2.0.0", {"/b": {"get": op()}}))]
    _, comparisons = analyze_specs(repos)
    assert [(c.baseline.version_text, c.candidate.version_text, [f["path"] for f in c.findings]) for c in comparisons] == [("1.0.0", "2.0.0", ["/a"]), ("2.0.0", "3.0.0", ["/b"])]


@pytest.mark.parametrize("versions, fragment", [
    (("1.0.0", "1.0.0"), "declares the same version"),
    (("1.0.0", None), "info.version is missing"),
    (("nightly", "stable"), "is not an orderable version"),
])
def test_ambiguous_or_missing_versions_are_unverified_never_guessed(versions, fragment):
    def doc(version):
        value = api("0", {"/users": {"get": op()}} if version == versions[0] else {})
        value["info"].pop("version") if version is None else value["info"].update(version=version)
        return json.dumps(value)

    result, comparisons = analyze_specs([RepoInput("a", {"openapi.json": doc(versions[0])}), RepoInput("b", {"openapi.json": doc(versions[1])})])
    assert comparisons == []
    assert [e["status"] for e in result] == ["RELATIONSHIP_UNVERIFIED", "RELATIONSHIP_UNVERIFIED"]
    assert all(e["findings"] == [] for e in result) and any(fragment in e["message"] for e in result)


# ---- Consumer references ---------------------------------------------------------

def refs(path, source, bases=("",), name="client.js"):
    return [(r["line"], r["match"]) for r in find_references([path], list(bases), {name: source}).get(path, [])]


def test_reference_matching_is_conservative():
    assert refs("/users/{id}", "axios.get(`${API}/users/${id}`)\nrequests.get(f\"{base}/users/{user_id}\")\nfetch('/users/42?full=1')\n") == [(1, "exact"), (2, "exact"), (3, "exact")]
    assert refs("/users/{id}", 'url = base + "/users/" + str(uid)\n') == [(1, "concatenated")]
    assert refs("/users", "fetch('https://api.example.com/users')\n") == [(1, "exact")]
    # Not references: a longer path, a different prefix, a comment, a server route, an unquoted word.
    assert refs("/users", "fetch('/users/42')\nfetch('/internal/admin/users')\nfetch('/superusers')\n// fetch('/users')\napp.get('/users', handler)\n@router.get(\"/users\")\nlet users = 1\n") == []
    # A declared base path is an accepted prefix; an undeclared one is not.
    assert refs("/users", "fetch('http://localhost:8000/api/v1/users')\n", bases=("/api/v1", "")) == [(1, "exact")]
    assert refs("/users", "fetch('http://localhost:8000/api/v1/users')\n") == []
    # Paths every service has are never attributed to a provider.
    assert refs("/health", "fetch(`${API}/health`)\n") == []
    # The most specific template wins.
    both = find_references(["/users/{id}", "/users/me"], [""], {"a.js": "fetch('/users/me')\n"})
    assert list(both) == ["/users/me"]
    assert engine.base_paths({"servers": [{"url": "https://x.io/api/v1/"}, {"url": "/v2"}, {"url": "{scheme}://h/{tenant}"}]}, {"basePath": "/legacy"}) == ["/api/v1", "/legacy", "/v2", ""]


# ---- Whole scans -----------------------------------------------------------------

def test_two_verified_versions_with_breaking_changes():
    record = scan(github("orders-v2", "orders-v1"))  # newer version submitted first on purpose
    assert record.status == "COMPLETED"
    (entry,) = record.result["contract_analysis"]
    assert (entry["provider_repo"], entry["consumer_repo"], entry["status"], entry["spec_file"]) == ("orders-v2", "", "ANALYZED", "docs/openapi.json")
    assert entry["baseline"] == {"repository": "orders-v1", "spec_file": "openapi.yaml", "version": "1.0.0", "title": "Orders API"}
    assert entry["relationship"] == {"same_api_basis": "matching normalized info.title"}
    assert "does not prove a runtime failure" in entry["message"]
    assert {(f["change_type"], f["method"], f["path"], f["previous_value"], f["new_value"]) for f in entry["findings"]} == {
        ("NEW_REQUIRED_REQUEST_FIELD", "GET", "/orders", "query parameter status: optional", "query parameter status: required"),
        ("NEW_REQUIRED_REQUEST_FIELD", "POST", "/orders", "request field currency: optional", "request field currency: required"),
        ("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders", "200 response body[].id: integer", "200 response body[].id: string"),
        ("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders/{orderId}", "200 response field id: integer", "200 response field id: string"),
        ("REMOVED_OPERATION", "DELETE", "/orders/{id}", "operation present", "operation not present"),
        ("REMOVED_PATH", "", "/orders/{id}/refunds", "operations: POST", "path not present"),
    }
    removed = next(f for f in entry["findings"] if f["change_type"] == "REMOVED_PATH")
    assert (removed["spec_file"], removed["spec_repository"], removed["json_pointer"]) == ("openapi.yaml", "orders-v1", "/paths/~1orders~1{id}~1refunds")
    assert not any("CONFIRMED" in json.dumps(f).upper().replace("NOT A CONFIRMED", "") for f in entry["findings"])


def test_unrelated_services_sharing_routes_are_never_compared():
    record = scan(github("orders-v1", "inventory", "service-a"))
    result = record.result["contract_analysis"]
    assert [(e["provider_repo"], e["status"]) for e in result] == [("orders-v1", "NOT_COMPARED"), ("inventory", "NOT_COMPARED"), ("service-a", "SPEC_UNAVAILABLE")]
    assert all(e["findings"] == [] and e["consumer_repo"] == "" for e in result)
    assert "No other version of this API was found" in result[0]["message"]


def test_missing_and_malformed_specifications_do_not_fail_the_scan():
    record = scan(github("service-a", "service-b", "broken-spec"))
    assert record.status == "COMPLETED" and row(record, "python:pydantic")["drift_disparity"] == "MAJOR_DRIFT"
    by_repo = {e["provider_repo"]: e for e in record.result["contract_analysis"]}
    assert by_repo["service-a"]["status"] == by_repo["service-b"]["status"] == "SPEC_UNAVAILABLE"
    assert "No OpenAPI or Swagger file" in by_repo["service-a"]["message"]
    assert by_repo["broken-spec"]["status"] == "MALFORMED_SPEC" and by_repo["broken-spec"]["spec_file"] == "api/openapi.yaml"
    assert "not valid YAML" in by_repo["broken-spec"]["message"]


def test_same_api_with_an_unorderable_version_is_unverified():
    record = scan(github("pay-a", "pay-b"))
    assert [(e["provider_repo"], e["status"], e["findings"]) for e in record.result["contract_analysis"]] == [
        ("pay-a", "RELATIONSHIP_UNVERIFIED", []), ("pay-b", "RELATIONSHIP_UNVERIFIED", [])]
    assert '"latest" is not an orderable version' in record.result["contract_analysis"][0]["message"]


def test_consumer_that_references_a_changed_endpoint():
    record = scan(github("orders-v1", "orders-v2", "storefront"))
    (entry,) = entries(record, consumer="storefront")
    assert (entry["provider_repo"], entry["status"]) == ("orders-v2", "ANALYZED")
    by_change = {(f["change_type"], f["method"], f["path"]): f for f in entry["findings"]}
    # axios.get on /orders/{id}: the GET type change applies, the removed DELETE does not.
    assert set(by_change) == {("REMOVED_PATH", "", "/orders/{id}/refunds"), ("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders/{orderId}")}
    refund = by_change[("REMOVED_PATH", "", "/orders/{id}/refunds")]
    assert refund["classification"] == "CONSUMER_REFERENCE_FOUND"
    assert refund["consumer_references"] == [{"repository": "storefront", "file": "src/api.js", "line": 5, "match": "exact",
                                              "snippet": "export const refund = (id) => fetch(`${BASE}/orders/${id}/refunds`, {"}]  # the commented-out call on line 3 is ignored
    assert "storefront references this endpoint at src/api.js:5" in refund["impact"] and "not proof" in refund["impact"]
    # The spec-level entry still lists every change, without consumer claims.
    (spec_level,) = entries(record, provider="orders-v2", consumer="")
    assert len(spec_level["findings"]) == 6 and all(f["classification"] == "POTENTIALLY_BREAKING" for f in spec_level["findings"])


def test_consumers_that_do_not_reference_a_changed_endpoint():
    record = scan(github("orders-v1", "orders-v2", "reports", "gateway", "inventory"))
    (reports,) = entries(record, consumer="reports")          # calls /items only, which did not change
    assert reports["status"] == "ANALYZED" and reports["findings"] == []
    assert "references 1 endpoint(s)" in reports["message"] and "None of the changes" in reports["message"]
    (gateway,) = entries(record, consumer="gateway")          # declares its own /orders routes: not a call
    assert gateway["status"] == "RELATIONSHIP_UNVERIFIED" and gateway["findings"] == []
    assert "unverified; it is not ruled out" in gateway["message"]
    (inventory,) = entries(record, consumer="inventory")      # shares route names, references nothing
    assert inventory["status"] == "RELATIONSHIP_UNVERIFIED"
    # Repositories that hold a version of the API are not treated as its consumers.
    assert not entries(record, consumer="orders-v1") and not entries(record, consumer="orders-v2")


def test_partial_repository_failures_keep_the_rest_of_the_analysis():
    def flaky(request):
        url = str(request.url)
        if "codeload.github.com/acme/storefront" in url or "inventory/contents/swagger.json" in url:
            return httpx.Response(500)
        return None

    record = scan(github("orders-v1", "orders-v2", "storefront", "inventory", "does-not-exist"), overrides=flaky)
    assert record.status == "COMPLETED"
    assert len(entries(record, status="ANALYZED", provider="orders-v2", consumer="")[0]["findings"]) == 6
    (unread,) = entries(record, provider="inventory", consumer="")
    assert unread["status"] == "SPEC_UNAVAILABLE" and "found but could not be read" in unread["message"] and unread["spec_file"] == "swagger.json"
    (missing,) = entries(record, provider="does-not-exist")
    assert missing["status"] == "SPEC_UNAVAILABLE" and "could not be read" in missing["message"]
    assert entries(record, consumer="storefront")[0]["status"] == "RELATIONSHIP_UNVERIFIED"
    assert "source archive could not be downloaded" in entries(record, consumer="storefront")[0]["message"]
    assert "the repository could not be read" in entries(record, consumer="does-not-exist")[0]["message"]
    assert any("storefront: code scan skipped" in w for w in record.result["warnings"])


def test_options_and_pasted_input():
    off = scan(github("orders-v1", "orders-v2"), options={"check_contracts": False})
    assert off.status == "COMPLETED" and off.result["contract_analysis"] is None   # not analyzed is null, never an empty "all clear"

    no_code = scan(github("orders-v1", "orders-v2", "storefront"), options={"scan_code": False})
    assert "the code scan is turned off" in entries(no_code, consumer="storefront")[0]["message"]

    pasted = {"type": "pasted", "name": "billing", "files": [{"filename": "package.json", "content": "{}"}]}
    mixed = scan([pasted, *github("orders-v1", "orders-v2")])
    assert "manifests only" in entries(mixed, provider="billing")[0]["message"]
    assert "pasted input has no source code" in entries(mixed, consumer="billing")[0]["message"]


def test_dependency_analysis_is_unchanged_next_to_contract_analysis():
    alone = scan(github("service-a", "service-b", "service-c"))
    mixed = scan(github("service-a", "service-b", "service-c", "orders-v1", "orders-v2", "storefront"))
    for drift_id in ("python:pydantic", "npm:axios", "npm:lodash"):
        before, after = row(alone, drift_id), row(mixed, drift_id)
        for key in ("drift_disparity", "compatibility_risk", "score", "risk_level", "breakdown", "recommended_version", "evidence", "vulnerabilities", "explanation"):
            assert before.get(key) == after.get(key), (drift_id, key)
    assert row(mixed, "python:pydantic")["score"] == 90 and row(mixed, "python:pydantic")["compatibility_risk"] == "CONFIRMED_BREAKING"
    dependency_hits = lambda record: [i for i in record.result["code_impact"] if i["repository"].startswith("service-")]
    assert dependency_hits(alone) == dependency_hits(mixed)
    assert all(e["status"] == "SPEC_UNAVAILABLE" for e in alone.result["contract_analysis"])


# ---- Compatibility with the dashboard --------------------------------------------

def interface_fields(name):
    body = re.search(rf"export interface {name} \{{(.*?)\n\}}", SCAN_TYPES.read_text(encoding="utf-8"), re.S).group(1)
    return dict(re.findall(r"^\s{2}(\w+)\??:\s*([^\n]+)$", body, re.M))


def test_response_matches_the_frontend_contract_types():
    """Field names and types are read from frontend/src/api/scanTypes.ts itself."""
    entry_fields, finding_fields = interface_fields("ContractAnalysisEntry"), interface_fields("ContractFinding")
    assert set(entry_fields) == {"provider_repo", "consumer_repo", "status", "spec_file", "message", "findings"}
    record = scan(github("orders-v1", "orders-v2", "storefront", "reports", "catalog", "mobile-bff", "inventory", "broken-spec", "service-a"))
    result = record.result["contract_analysis"]
    known = set(re.search(r"CONTRACT_STATES = \[(.*?)\]", SCAN_TYPES.read_text(encoding="utf-8")).group(1).replace("'", "").replace(" ", "").split(","))
    assert {e["status"] for e in result} == {"ANALYZED", "NOT_COMPARED", "MALFORMED_SPEC", "SPEC_UNAVAILABLE", "RELATIONSHIP_UNVERIFIED"} <= known
    for entry in result:
        assert set(entry_fields) <= set(entry)
        assert all(isinstance(entry[name], str) for name, kind in entry_fields.items() if kind == "string")
        assert isinstance(entry["findings"], list) and entry["provider_repo"] and entry["message"]
        for finding in entry["findings"]:
            assert set(finding_fields) <= set(finding)
            assert all(isinstance(finding[name], str) and finding[name] for name in finding_fields if name != "method")
            assert finding["severity"] in ("HIGH", "MEDIUM") and finding["json_pointer"].startswith("/")
    json.dumps(result)  # plain JSON all the way down

    # The same output is the fixture the frontend tests parse and render.
    if os.environ.get("UPDATE_FIXTURES"):
        FIXTURE.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == result, "run UPDATE_FIXTURES=1 pytest tests/test_contracts.py to refresh the frontend fixture"


def test_api_returns_contract_analysis_through_the_async_lifecycle(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setattr(scan_runner, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    client = TestClient(app)
    accepted = client.post("/api/v1/scans", json={"repository_targets": github("orders-v1", "orders-v2", "storefront")})
    assert accepted.status_code == 202
    record = client.get(accepted.json()["poll_url"]).json()
    assert record["status"] == "COMPLETED"
    assert [(e["provider_repo"], e["consumer_repo"], e["status"], len(e["findings"])) for e in record["result"]["contract_analysis"]] == [
        ("orders-v2", "", "ANALYZED", 6), ("storefront", "", "SPEC_UNAVAILABLE", 0), ("orders-v2", "storefront", "ANALYZED", 2)]


# ---- Regression: nested paths (defect A) -------------------------------------------

ORDER_PATHS = ["/orders", "/orders/{id}", "/orders/{id}/items"]


def attributed(source, paths=ORDER_PATHS, name="client.js", **signals):
    """{spec path: [(line, match kind, methods)]} for one source file."""
    found = find_references(paths, [""], {name: source}, **signals)
    return {path: [(r["line"], r["match"], r["methods"]) for r in refs] for path, refs in found.items()}


@pytest.mark.parametrize("source, expected", [
    # Exact and nested routes are told apart in both directions.
    ("x = '/orders'\n", "/orders"),
    ("x = '/orders/'\n", "/orders"),                                        # trailing slash
    ("x = '/orders?status=open'\n", "/orders"),
    ("x = '/orders/123'\n", "/orders/{id}"),
    ("x = '/orders/123/'\n", "/orders/{id}"),
    ("x = '/orders/123/items'\n", "/orders/{id}/items"),                    # not /orders, not /orders/{id}
    ("x = '/orders/123/items/9'\n", None),                                  # a deeper route the API does not define
    # Template placeholders.
    ("x = `${BASE}/orders`\n", "/orders"),
    ("x = `${BASE}/orders/${id}`\n", "/orders/{id}"),
    ("x = `${BASE}/orders/${id}/items`\n", "/orders/{id}/items"),
    ('x = f"{base}/orders/{order_id}/items"\n', "/orders/{id}/items"),
    ('x = "%s/orders/%s" % (base, oid)\n', "/orders/{id}"),
    ("x = `https://shop.example.com/orders/${id}`\n", "/orders/{id}"),
    # A path nested under other segments is a different route.
    ("x = `/internal/${tenant}/orders`\n", None),
    ("x = `${BASE}/admin/orders/${id}`\n", None),
    ("x = `/v9/${region}/orders/${id}/items`\n", None),
    ("x = '/internal/admin/orders'\n", None),
])
def test_exact_and_nested_routes_are_attributed_to_the_right_template(source, expected):
    assert set(attributed(source)) == ({expected} if expected else set())


@pytest.mark.parametrize("source, expected", [
    ('u = base + "/orders"\n', "/orders"),
    ('u = base + "/orders" + query\n', "/orders"),
    ('u = base + "/orders/" + oid\n', "/orders/{id}"),
    ('u = base + "/orders/" + str(oid)\n', "/orders/{id}"),
    ('u = base + "/orders/" + oid + "/items"\n', "/orders/{id}/items"),      # previously reported as /orders
    ("u = base + '/orders/' + order.id + '/items/'\n", "/orders/{id}/items"),
    ('u = base + "/orders" + "/" + oid\n', "/orders/{id}"),                  # adjacent literals are one path
    ('u = base + "/orders/" + a + b\n', "/orders/{id}"),
    ('u = base + "/orders" +\n    "/items"\n', None),                         # split over lines: not attributed at all
])
def test_concatenated_paths_are_read_as_one_path(source, expected):
    found = attributed(source)
    assert set(found) == ({expected} if expected else set())
    if expected and '" + ' in source.replace("'", '"').split("/orders", 1)[1][:6]:
        assert found[expected][0][1] == "concatenated"


def test_line_numbers_survive_concatenation_rewriting():
    source = 'a = base + "/orders/" + x + "/items"\n\nb = base + "/orders/" + y\nc = "/orders"\n'
    assert attributed(source) == {"/orders/{id}/items": [(1, "concatenated", [])], "/orders/{id}": [(3, "concatenated", [])], "/orders": [(4, "exact", [])]}


# ---- Regression: HTTP method isolation (defect B) ----------------------------------

AB = ["/a/items", "/a/other"]


@pytest.mark.parametrize("source, name, expected", [
    # Two calls on one line keep their own methods.
    ("const a = axios.get(`${B}/a/items`); const b = axios.post(`${B}/a/other`)\n", "c.js", {"/a/items": ["GET"], "/a/other": ["POST"]}),
    ("await Promise.all([fetch(`${B}/a/items`), fetch(`${B}/a/other`, { method: 'PATCH' })])\n", "c.js", {"/a/items": ["GET"], "/a/other": ["PATCH"]}),
    ('requests.post(cfg.get("base") + "/a/items"); requests.delete(base + "/a/other")\n', "c.py", {"/a/items": ["POST"], "/a/other": ["DELETE"]}),
    # Adjacent lines: an options object belongs to its own call only.
    ("fetch(`${B}/a/items`)\nfetch(`${B}/a/other`, { method: 'DELETE' })\n", "c.js", {"/a/items": ["GET"], "/a/other": ["DELETE"]}),
    ("fetch(`${B}/a/other`, { method: 'DELETE' })\nfetch(`${B}/a/items`)\n", "c.js", {"/a/items": ["GET"], "/a/other": ["DELETE"]}),
    ("fetch(`${B}/a/items`, {\n  headers,\n  method: 'PUT',\n})\naxios.delete(`${B}/a/other`)\n", "c.js", {"/a/items": ["PUT"], "/a/other": ["DELETE"]}),
    # Words in comments, logs and unrelated statements are not methods.
    ("// DELETE is handled elsewhere\nconsole.log('POST done'); const url = `${B}/a/items`\nlogger.info('PUT /a/other')\n", "c.js", {"/a/items": []}),
    ('log.info("DELETE requested")\nurl = f"{B}/a/items"\nsession.delete(other)\n', "c.py", {"/a/items": []}),
    ("const opts = { method: 'POST' }\nconst url = `${B}/a/items`\nfetch(url, opts)\n", "c.js", {"/a/items": []}),          # not resolvable: unknown, not guessed
    ("fetch(`${B}/a/items`, opts)\n", "c.js", {"/a/items": []}),
    # Other call shapes.
    ('requests.request("PUT", f"{B}/a/items")\n', "c.py", {"/a/items": ["PUT"]}),
    ("axios.get(withQuery(`${B}/a/items`))\n", "c.js", {"/a/items": ["GET"]}),
    ('restTemplate.postForObject(base + "/a/items", body, Item.class);\n', "C.java", {"/a/items": ["POST"]}),
    ('client.exchange(base + "/a/items", HttpMethod.DELETE, entity, Void.class);\n', "C.java", {"/a/items": ["DELETE"]}),
    ("fetch('/a/items (see docs)')\nfetch(`${B}/a/other`)\n", "c.js", {"/a/other": ["GET"]}),                            # parentheses inside strings are not calls
])
def test_the_http_method_comes_only_from_the_call_that_uses_the_path(source, name, expected):
    assert {path: refs[0][2] for path, refs in attributed(source, AB, name).items()} == expected


def orders_comparison():
    _, (comparison,) = analyze_specs([RepoInput("orders-v1", {"openapi.yaml": ORDERS_V1}), RepoInput("orders-v2", {"docs/openapi.json": ORDERS_V2})])
    return comparison


def test_a_neighbouring_call_does_not_move_a_finding_to_the_wrong_reference():
    source = (
        "const ORDERS_URL = process.env.ORDERS_URL\n"
        "export const getOrder = (id) => fetch(`${ORDERS_URL}/orders/${id}`)\n"                           # a GET
        "export const purge = () => fetch(`${ORDERS_URL}/items`, { method: 'DELETE' })\n"                 # unrelated DELETE right below
    )
    entry = engine.consumer_entry(orders_comparison(), "web", {"api.js": source})
    # Before the fix the DELETE below was read as this call's method: the removed
    # DELETE /orders/{id} was attributed to line 2 and the GET type change was lost.
    assert changes(entry["findings"]) == {("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders/{orderId}")}
    assert [r["line"] for r in entry["findings"][0]["consumer_references"]] == [2]


# ---- Regression: provider-consumer evidence (defect C) -------------------------------

def test_shared_generic_paths_alone_never_make_a_consumer():
    comparison = orders_comparison()
    for source in (
        "fetch(`${API}/orders`)\nfetch(`${API}/items`)\n",                          # an unnamed base URL
        "fetch('/orders')\naxios.post('/orders', body)\n",                           # no base URL at all
        "fetch('https://shop.other.example/orders')\n",                              # a different host
        "const USERS_URL = env.USERS_URL\nfetch(`${USERS_URL}/orders/${id}`)\n",     # a base URL naming another service
    ):
        entry = engine.consumer_entry(comparison, "other", {"a.js": source})
        assert (entry["status"], entry["findings"]) == ("RELATIONSHIP_UNVERIFIED", []), source
        assert "a shared path does not establish a provider-consumer relationship" in entry["message"]
        assert "consumer_evidence" not in entry["relationship"]
        assert entry["possible_references"] and all(set(ref) == {"path", "repository", "file", "line", "snippet", "match"} for ref in entry["possible_references"])


@pytest.mark.parametrize("source, name, signal", [
    ("fetch('https://orders.acme.example/v2/orders?status=open')\n", "a.js", "server host orders.acme.example"),
    ("const BASE = 'https://orders.acme.example/v2'\nfetch(`${BASE}/orders?status=open`)\n", "a.js", "server host orders.acme.example"),
    ("fetch(`${process.env.ORDERS_API_URL}/orders`)\n", "a.js", "identifier naming the API (order)"),
    ("const ordersApi = axios.create({ baseURL: cfg.url })\nordersApi.get('/orders')\n", "a.js", "identifier naming the API (order)"),
    ('class Client:\n    def __init__(self):\n        self.base_url = settings.ORDER_SERVICE\n\n    def list(self):\n        return requests.get(f"{self.base_url}/orders")\n', "a.py", "identifier naming the API (order)"),
])
def test_a_host_or_a_naming_signal_verifies_the_relationship(source, name, signal):
    entry = engine.consumer_entry(orders_comparison(), "web", {name: source})
    assert entry["status"] == "ANALYZED" and signal in entry["relationship"]["consumer_evidence"]
    assert ("NEW_REQUIRED_REQUEST_FIELD", "GET", "/orders") in changes(entry["findings"])
    assert signal in entry["message"]


def test_only_attributed_references_carry_findings_in_a_mixed_repository():
    files = {
        "orders.js": "const ORDERS = process.env.ORDERS_URL\nexport const one = (id) => axios.get(`${ORDERS}/orders/${id}`)\n",
        "shop.js": "const SHOP = process.env.SHOP_URL\nexport const refund = (id) => axios.post(`${SHOP}/orders/${id}/refunds`)\n",
    }
    entry = engine.consumer_entry(orders_comparison(), "web", files)
    assert entry["status"] == "ANALYZED"
    assert changes(entry["findings"]) == {("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders/{orderId}")}   # the shop call's removed path is not claimed
    assert [(ref["path"], ref["file"]) for ref in entry["possible_references"]] == [("/orders/{id}/refunds", "shop.js")]


def test_identity_signals_ignore_generic_words_and_local_hosts():
    assert engine.identity_words("Orders API v2", "orders-v2", "Internal REST Service") == ["order"]
    assert engine.identity_words("Swagger Petstore - OpenAPI 3.0", "swagger-api/swagger-petstore@v3-1.0.27") == ["petstore"]
    assert engine.provider_hosts({"servers": [{"url": "https://Orders.Acme.example/v2"}, {"url": "http://localhost:8080"}, {"url": "/relative"}, {"url": "https://{tenant}.x.io"}]}, {"host": "api.legacy.example"}) == ["api.legacy.example", "orders.acme.example"]


def test_scan_reports_ambiguous_and_verified_consumers_differently():
    record = scan(github("orders-v1", "orders-v2", "catalog", "mobile-bff", "storefront"))
    (catalog,) = entries(record, consumer="catalog")
    assert (catalog["status"], catalog["findings"]) == ("RELATIONSHIP_UNVERIFIED", [])
    assert sorted(ref["path"] for ref in catalog["possible_references"]) == ["/items", "/orders"]

    (bff,) = entries(record, consumer="mobile-bff")
    assert bff["status"] == "ANALYZED" and "server host orders.acme.example" in bff["relationship"]["consumer_evidence"]
    assert changes(bff["findings"]) == {("REMOVED_OPERATION", "DELETE", "/orders/{id}")}           # requests.delete, path joined with "+"
    assert bff["findings"][0]["consumer_references"][0] | {"snippet": ""} == {"repository": "mobile-bff", "file": "bff.py", "line": 5, "match": "concatenated", "snippet": ""}
    assert "the path is built by concatenation" in bff["findings"][0]["impact"]

    (storefront,) = entries(record, consumer="storefront")
    assert storefront["relationship"]["consumer_evidence"] == ["identifier naming the API (order)"]


# ---- Sign-in next to contract analysis -----------------------------------------------

def test_contract_scans_respect_mandatory_sign_in(monkeypatch):
    from urllib.parse import parse_qs, urlparse
    from fastapi.testclient import TestClient
    from app.api.v1.endpoints import auth
    from app.main import app

    for name, value in (("GITHUB_OAUTH_CLIENT_ID", "client-id"), ("GITHUB_OAUTH_CLIENT_SECRET", "client-secret"), ("SESSION_SECRET", "test-secret"), ("AUTH_REQUIRED", True)):
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(auth, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "Http", lambda **_kwargs: fake_http())
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    client = TestClient(app, follow_redirects=False)
    body = {"repository_targets": github("orders-v1", "orders-v2", "storefront")}

    refused = client.post("/api/v1/scans", json=body)
    assert refused.status_code == 401 and refused.json()["error_code"] == "SIGN_IN_REQUIRED"

    login = client.get("/api/v1/auth/github/login", params={"return_to": settings.cors_origins_list[0]})
    state = parse_qs(urlparse(login.headers["location"]).query)["state"][0]
    assert client.get("/api/v1/auth/github/callback", params={"code": "good-code", "state": state}).status_code == 302
    assert client.get("/api/v1/auth/me").json()["user"]["login"] == "octocat"

    accepted = client.post("/api/v1/scans", json=body)
    assert accepted.status_code == 202
    record = client.get(accepted.json()["poll_url"]).json()
    assert record["status"] == "COMPLETED"
    assert [(e["consumer_repo"], e["status"], len(e["findings"])) for e in record["result"]["contract_analysis"]] == [("", "ANALYZED", 6), ("", "SPEC_UNAVAILABLE", 0), ("storefront", "ANALYZED", 2)]
    # The signed-in user's OAuth token is for identity only; it is never used to read repositories.
    client.cookies.clear()
    assert client.get(accepted.json()["poll_url"]).status_code == 401
