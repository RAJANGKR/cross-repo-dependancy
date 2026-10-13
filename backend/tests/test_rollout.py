"""Rollout planner: recommendation rules, the endpoint, and the refs that are
actually read. GitHub is faked per commit; nothing touches the network."""
import copy
import json
import os
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app
from app.schemas.rollout import RECOMMENDATIONS, STATE_STATUSES
from app.services import rollout_planner
from app.services.rollout_planner import COMPATIBLE, INCOMPATIBLE, UNKNOWN, recommend, state_status, verdict_for
from tests.fakes import fake_http, zip_of

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "fixtures" / "rollout-results.json"
PROVIDER, CONSUMER = "https://github.com/acme/billing", "https://github.com/acme/shop"
JSON_BODY = lambda schema: {"required": True, "content": {"application/json": {"schema": schema}}}
OK = {"200": {"description": "ok"}}

INVOICE = {"type": "object", "required": ["amount"], "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}}}
PATHS = {
    "/invoices": {"post": {"requestBody": JSON_BODY(INVOICE), "responses": {"201": {"description": "created"}}}},
    "/invoices/{id}/void": {"post": {"responses": OK}},
    "/customers/{id}": {"get": {"responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {
        "type": "object", "properties": {"customer": {"type": "object", "properties": {"legacy_id": {"type": "integer"}, "name": {"type": "string"}}}}}}}}}}},
}


def spec(version, change=lambda paths: None):
    paths = copy.deepcopy(PATHS)
    change(paths)
    return json.dumps({"openapi": "3.0.3", "info": {"title": "Billing API", "version": version}, "paths": paths})


def require_currency(paths):
    paths["/invoices"]["post"]["requestBody"]["content"]["application/json"]["schema"]["required"] = ["amount", "currency"]


def rename_void(paths):
    paths["/invoices/{id}/cancel"] = paths.pop("/invoices/{id}/void")


def legacy_id_string(paths):
    paths["/customers/{id}"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["properties"]["customer"]["properties"]["legacy_id"]["type"] = "string"


JS = "import axios from 'axios'\n\nconst API = process.env.API_URL\n\n"
POST_AMOUNT = JS + "export const createInvoice = (amount) => axios.post(`${API}/invoices`, { amount }).then((res) => res.status)\n"
POST_CURRENCY = JS + "export const createInvoice = (amount, currency) => axios.post(`${API}/invoices`, { amount, currency }).then((res) => res.status)\n"
CALLS_VOID = JS + "export const cancel = (id) => axios.post(`${API}/invoices/${id}/void`).then((res) => res.status)\n"
CALLS_CANCEL = JS + "export const cancel = (id) => axios.post(`${API}/invoices/${id}/cancel`).then((res) => res.status)\n"
CALLS_REFUNDS = POST_AMOUNT + "export const refund = (id) => axios.post(`${API}/refunds`, { invoice: id }).then((res) => res.status)\n"
READS_LEGACY = JS + "export async function legacy(id) {\n  const res = await axios.get(`${API}/customers/${id}`)\n  console.log(res.data.customer.legacy_id)\n}\n"


def github(provider, consumer):
    """A fake GitHub that serves different files per ref: {ref: files} for each repository."""
    repos = {"acme/billing": provider, "acme/shop": consumer}
    shas = {(name, ref): f"{index:x}{ref_index:x}".ljust(40, "a") for index, (name, refs) in enumerate(repos.items(), start=1) for ref_index, ref in enumerate(refs, start=1)}
    by_sha = {sha: repos[name][ref] for (name, ref), sha in shas.items()}
    seen = []

    def handle(request):
        url = str(request.url)
        seen.append(url)
        parts = request.url.path.strip("/").split("/")
        if request.url.host == "codeload.github.com":
            files = by_sha.get(parts[-1])
            return httpx.Response(200, content=zip_of(files)) if isinstance(files, dict) else httpx.Response(files or 404)
        if request.url.host != "api.github.com" or parts[0] != "repos":
            return httpx.Response(404)
        name, rest = "/".join(parts[1:3]), parts[3:]
        if name not in repos:
            return httpx.Response(404)
        if not rest:
            return httpx.Response(200, json={"default_branch": "main"})
        if rest[:1] == ["commits"]:
            sha = shas.get((name, "/".join(rest[1:])))
            return httpx.Response(200, text=sha) if sha else httpx.Response(422)
        files = by_sha.get(rest[-1] if rest[:2] == ["git", "trees"] else request.url.params.get("ref", ""))
        if not isinstance(files, dict):
            return httpx.Response(404)
        if rest[:2] == ["git", "trees"]:
            return httpx.Response(200, json={"tree": [{"path": path, "type": "blob"} for path in files], "truncated": False})
        if rest[:1] == ["contents"]:
            content = files.get("/".join(rest[1:]))
            return httpx.Response(200, text=content) if content is not None else httpx.Response(404)
        return httpx.Response(404)

    return handle, seen, shas


def plan(monkeypatch, provider, consumer, refs=("v1", "v2", "main", "next"), body=None):
    handle, seen, shas = github(provider, consumer)
    monkeypatch.setattr(rollout_planner, "Http", lambda **_kwargs: fake_http(handle))
    monkeypatch.setattr(rollout_planner, "shared_cache", lambda: None)
    monkeypatch.setattr(settings, "AUTH_REQUIRED", False)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    request = body or {"provider": {"url": PROVIDER, "current_ref": refs[0], "proposed_ref": refs[1]}, "consumer": {"url": CONSUMER, "current_ref": refs[2], "proposed_ref": refs[3]}}
    response = TestClient(app).post("/api/v1/rollout", json=request)
    return response, seen, shas


def statuses(result):
    return result["recommendation"], result["provider_first"]["status"], result["consumer_first"]["status"], result["final"]["status"]


SCENARIOS = {
    # name: (provider files per ref, consumer files per ref)
    "either": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": spec("1.0.1")}},
               {"main": {"src/api.js": POST_AMOUNT}, "next": {"src/api.js": POST_AMOUNT}}),
    "consumer_first": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": spec("2.0.0", require_currency)}},
                       {"main": {"src/api.js": POST_AMOUNT}, "next": {"src/api.js": POST_CURRENCY}}),
    "provider_first": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": spec("1.1.0", lambda p: p.update({"/refunds": {"post": {"responses": OK}}}))}},
                       {"main": {"src/api.js": POST_AMOUNT}, "next": {"src/api.js": CALLS_REFUNDS}}),
    "neither": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": spec("2.0.0", rename_void)}},
                {"main": {"src/api.js": CALLS_VOID}, "next": {"src/api.js": CALLS_CANCEL}}),
    "unresolved": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": spec("2.0.0", legacy_id_string)}},
                   {"main": {"src/api.js": READS_LEGACY}, "next": {"src/api.js": READS_LEGACY}}),
    "fetch_failure": ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"README.md": "the specification was removed"}},
                      {"main": {"src/api.js": POST_AMOUNT}, "next": {"src/api.js": POST_CURRENCY}}),
}


# ---- Recommendation rules -----------------------------------------------------------------

@pytest.mark.parametrize("provider_first, consumer_first, expected", [
    (COMPATIBLE, COMPATIBLE, "EITHER"),
    (COMPATIBLE, INCOMPATIBLE, "PROVIDER_FIRST"),
    (INCOMPATIBLE, COMPATIBLE, "CONSUMER_FIRST"),
    (INCOMPATIBLE, INCOMPATIBLE, "NEITHER"),
    # An order is recommended only on its own evidence; the other order being unknown does not matter.
    (COMPATIBLE, UNKNOWN, "PROVIDER_FIRST"),
    (UNKNOWN, COMPATIBLE, "CONSUMER_FIRST"),
    # Unknown is never read as safe, and one demonstrated break does not make the other order good.
    (UNKNOWN, UNKNOWN, "UNRESOLVED"),
    (INCOMPATIBLE, UNKNOWN, "UNRESOLVED"),
    (UNKNOWN, INCOMPATIBLE, "UNRESOLVED"),
])
def test_recommendation_follows_the_two_intermediate_states(provider_first, consumer_first, expected):
    assert recommend(provider_first, consumer_first) == expected and expected in RECOMMENDATIONS


def test_only_demonstrated_evidence_decides_a_change():
    assert [verdict_for(usage) for usage in ("CALLS_OPERATION", "OMITS_REQUIRED_FIELD")] == [INCOMPATIBLE, INCOMPATIBLE]
    assert verdict_for("SENDS_REQUIRED_FIELD") == COMPATIBLE
    # Reading a changed field, a conditional value, an unfollowed call, an operation match and no usage are all unknown.
    for usage in ("READS_CHANGED_FIELD", "MAY_SEND_REQUIRED_FIELD", "NOT_DETERMINED", "FIELD_NOT_READ", "NO_USAGE_FOUND", "SOMETHING_NEW"):
        assert verdict_for(usage) == UNKNOWN
    assert state_status([COMPATIBLE, COMPATIBLE], blocked=False) == COMPATIBLE
    assert state_status([COMPATIBLE, UNKNOWN], blocked=False) == UNKNOWN
    assert state_status([UNKNOWN, INCOMPATIBLE], blocked=False) == INCOMPATIBLE
    assert state_status([], blocked=True) == UNKNOWN and state_status([COMPATIBLE], blocked=True) == UNKNOWN
    assert {COMPATIBLE, INCOMPATIBLE, UNKNOWN} == set(STATE_STATUSES)


# ---- End to end through the endpoint ---------------------------------------------------------

def test_both_orders_compatible_when_the_contract_did_not_change(monkeypatch):
    response, _, _ = plan(monkeypatch, *SCENARIOS["either"])
    assert response.status_code == 200
    result = response.json()
    assert statuses(result) == ("EITHER", COMPATIBLE, COMPATIBLE, COMPATIBLE)
    assert result["contract_changes"] == [] and result["unresolved"] == []
    assert "identical apart from their info block" in result["provider_first"]["reason"]
    assert set(result) == {"recommendation", "summary", "refs", "provider_first", "consumer_first", "final", "contract_changes", "unresolved", "limitations"}


def test_newly_required_field_means_consumer_first(monkeypatch):
    result = plan(monkeypatch, *SCENARIOS["consumer_first"])[0].json()
    assert statuses(result) == ("CONSUMER_FIRST", INCOMPATIBLE, COMPATIBLE, COMPATIBLE)
    (change,) = result["contract_changes"]
    assert (change["direction"], change["change_type"], change["method"], change["path"], change["field"]) == ("P0_TO_P1", "NEW_REQUIRED_REQUEST_FIELD", "POST", "/invoices", "currency")
    (broken,) = result["provider_first"]["evidence"]       # C0 does not send the value P1 requires
    assert (broken["verdict"], broken["usage"], broken["file"], broken["line"]) == (INCOMPATIBLE, "OMITS_REQUIRED_FIELD", "src/api.js", 5)
    assert "it sends amount" in broken["explanation"]
    (ready,) = result["final"]["evidence"]                 # C1 does
    assert (ready["verdict"], ready["usage"]) == (COMPATIBLE, "SENDS_REQUIRED_FIELD")
    assert result["consumer_first"]["evidence"] == [] and "nothing detected can break a consumer written for P1" in result["consumer_first"]["reason"]
    assert result["summary"].startswith("Deploy the consumer first.")


def test_new_endpoint_means_provider_first(monkeypatch):
    result = plan(monkeypatch, *SCENARIOS["provider_first"])[0].json()
    assert statuses(result) == ("PROVIDER_FIRST", COMPATIBLE, INCOMPATIBLE, COMPATIBLE)
    (change,) = result["contract_changes"]                 # seen only in the P1 -> P0 direction
    assert (change["direction"], change["change_type"], change["path"]) == ("P1_TO_P0", "REMOVED_PATH", "/refunds")
    (broken,) = result["consumer_first"]["evidence"]       # C1 calls an operation P0 does not have
    assert (broken["verdict"], broken["usage"], broken["line"]) == (INCOMPATIBLE, "CALLS_OPERATION", 6)


def test_renamed_endpoint_means_neither(monkeypatch):
    result = plan(monkeypatch, *SCENARIOS["neither"])[0].json()
    assert statuses(result)[:3] == ("NEITHER", INCOMPATIBLE, INCOMPATIBLE)
    assert {(c["direction"], c["path"]) for c in result["contract_changes"]} == {("P0_TO_P1", "/invoices/{id}/void"), ("P1_TO_P0", "/invoices/{id}/cancel")}
    assert "Neither order can be rolled out as is" in result["summary"]
    # The end state is not claimed either way: C1 no longer calls the removed path, and "no usage found" is not proof.
    assert result["final"]["status"] == UNKNOWN and result["final"]["evidence"][0]["usage"] == "NO_USAGE_FOUND"


def test_insufficient_evidence_is_unresolved_not_compatible(monkeypatch):
    result = plan(monkeypatch, *SCENARIOS["unresolved"])[0].json()
    assert statuses(result) == ("UNRESOLVED", UNKNOWN, UNKNOWN, UNKNOWN)
    (read,) = result["provider_first"]["evidence"]         # the field is read; whether the code copes is not known
    assert (read["verdict"], read["usage"], read["field"], read["line"]) == (UNKNOWN, "READS_CHANGED_FIELD", "customer.legacy_id", 7)
    assert "This is not a statement that the rollout is unsafe" in result["summary"]
    assert any("customer.legacy_id" in item["reason"] for item in result["unresolved"])


@pytest.mark.parametrize("consumer_next, expected", [
    (JS + "export const noop = () => 1\n", "no call to this API could be matched"),                               # nothing to analyze
    (JS + "export const make = (client, amount) => client.post(`${API}/invoices`, { amount })\n", "are not visible here"),   # an unknown client
    (JS + "export const make = (amount, c) => { const p = { amount }; if (c) p.currency = c; return axios.post(`${API}/invoices`, p) }\n", "only on some paths"),
])
def test_a_missing_or_unfollowed_reference_never_becomes_compatible(monkeypatch, consumer_next, expected):
    provider, _ = SCENARIOS["consumer_first"]
    result = plan(monkeypatch, provider, {"main": {"src/api.js": consumer_next}, "next": {"src/api.js": consumer_next}})[0].json()
    assert result["provider_first"]["status"] == UNKNOWN and result["final"]["status"] == UNKNOWN
    assert expected in json.dumps(result["provider_first"])
    # Consumer first is still supported on the contract alone: nothing in P1 is missing from P0.
    assert result["recommendation"] == "CONSUMER_FIRST" and "could not be established" in result["summary"]


def test_a_value_the_old_provider_does_not_define_is_not_assumed_to_be_ignored(monkeypatch):
    without_currency = lambda paths: paths["/invoices"]["post"]["requestBody"]["content"]["application/json"]["schema"]["properties"].pop("currency")
    provider = {"v1": {"openapi.json": spec("1.0.0", without_currency)}, "v2": {"openapi.json": spec("2.0.0", require_currency)}}
    result = plan(monkeypatch, provider, SCENARIOS["consumer_first"][1])[0].json()
    assert statuses(result) == ("UNRESOLVED", INCOMPATIBLE, UNKNOWN, COMPATIBLE)
    assert "which P0's specification does not define" in result["consumer_first"]["evidence"][0]["explanation"]
    assert result["summary"].startswith("Provider first has a demonstrated incompatibility")


# ---- Failures are reported as unknown, never guessed --------------------------------------------

def test_missing_specification_at_a_ref(monkeypatch):
    response, _, _ = plan(monkeypatch, *SCENARIOS["fetch_failure"])
    result = response.json()
    assert response.status_code == 200 and statuses(result) == ("UNRESOLVED", UNKNOWN, UNKNOWN, UNKNOWN)
    assert result["contract_changes"] == []
    assert {"scope": "P1", "reason": "No OpenAPI or Swagger file was found at the repository root or under docs/, api/, spec/, specs/, src/."} in result["unresolved"]
    assert [ref["problem"] != "" for ref in result["refs"]] == [False, True, False, False]


@pytest.mark.parametrize("provider, consumer, refs, scope, fragment", [
    ({"v1": {"openapi.json": spec("1.0.0")}, "v2": {"openapi.json": "{not json"}}, SCENARIOS["either"][1], ("v1", "v2", "main", "next"), "P1", "could not be parsed"),
    (SCENARIOS["either"][0], SCENARIOS["either"][1], ("v1", "no-such-tag", "main", "next"), "P1", "could not be resolved"),
    (SCENARIOS["consumer_first"][0], {"main": 500, "next": {"src/api.js": POST_CURRENCY}}, ("v1", "v2", "main", "next"), "C0", "could not be read"),
    (SCENARIOS["consumer_first"][0], SCENARIOS["consumer_first"][1], ("v1", "v2", "missing-branch", "next"), "C0", "could not be resolved"),
    (SCENARIOS["consumer_first"][0], {"main": {"README.md": "docs only"}, "next": {"src/api.js": POST_CURRENCY}}, ("v1", "v2", "main", "next"), "C0", "No Python, JavaScript, TypeScript or Java source file"),
])
def test_fetch_and_parse_failures_give_an_honest_unknown(monkeypatch, provider, consumer, refs, scope, fragment):
    response, _, _ = plan(monkeypatch, provider, consumer, refs)
    result = response.json()
    assert response.status_code == 200
    assert any(item["scope"] == scope and fragment in item["reason"] for item in result["unresolved"]), result["unresolved"]
    assert result["provider_first"]["status"] == UNKNOWN            # the state that needs the unreadable ref
    assert result["recommendation"] in ("UNRESOLVED", "CONSUMER_FIRST") and result["recommendation"] != "EITHER"
    assert COMPATIBLE not in (result["provider_first"]["status"],)


@pytest.mark.parametrize("scenario", ["either", "consumer_first"])
def test_a_consumer_repository_that_does_not_exist_is_never_part_of_a_compatible_state(monkeypatch, scenario):
    """Found in the browser: a mistyped consumer repository still produced "deploy the consumer first"."""
    provider, _ = SCENARIOS[scenario]
    body = {"provider": {"url": PROVIDER, "current_ref": "v1", "proposed_ref": "v2"}, "consumer": {"url": "https://github.com/acme/ghost", "current_ref": "main", "proposed_ref": "next"}}
    response, seen, _ = plan(monkeypatch, provider, SCENARIOS[scenario][1], body=body)
    result = response.json()
    assert response.status_code == 200 and statuses(result) == ("UNRESOLVED", UNKNOWN, UNKNOWN, UNKNOWN)
    # The message names the repository as the problem, not the branch.
    assert [(item["scope"], item["reason"]) for item in result["unresolved"]] == [
        ("C0", "The repository acme/ghost was not found, or the repository is private."),
        ("C1", "The repository acme/ghost was not found, or the repository is private.")]
    assert "the consumer ref C1 could not be resolved" in result["consumer_first"]["reason"]
    assert [ref["commit"] for ref in result["refs"]][2:] == ["", ""]
    assert sum(url.endswith("/repos/acme/ghost") for url in seen) == 1          # asked once, and only after the ref failed


def test_a_missing_ref_in_an_existing_repository_still_names_the_ref(monkeypatch):
    provider, consumer = SCENARIOS["either"]
    result = plan(monkeypatch, provider, consumer, refs=("v1", "v2", "main", "no-such-branch"))[0].json()
    assert {"scope": "C1", "reason": 'Branch, tag or commit "no-such-branch" could not be resolved in acme/shop.'} in result["unresolved"]
    # Provider first pairs P1 with C0, which was read: that state stands. Consumer first needs C1, which does not exist.
    assert statuses(result) == ("PROVIDER_FIRST", COMPATIBLE, UNKNOWN, UNKNOWN)
    assert "could not be established" in result["summary"]


def test_a_provider_repository_that_does_not_exist_is_named(monkeypatch):
    body = {"provider": {"url": "https://github.com/acme/ghost", "current_ref": "v1", "proposed_ref": "v2"}, "consumer": {"url": CONSUMER, "current_ref": "main", "proposed_ref": "next"}}
    result = plan(monkeypatch, *SCENARIOS["either"], body=body)[0].json()
    assert statuses(result) == ("UNRESOLVED", UNKNOWN, UNKNOWN, UNKNOWN)
    assert result["unresolved"][0] == {"scope": "P0", "reason": "The repository acme/ghost was not found, or the repository is private."}


def test_an_unreadable_consumer_does_not_matter_when_the_contract_is_unchanged(monkeypatch):
    result = plan(monkeypatch, SCENARIOS["either"][0], {"main": 500, "next": 500})[0].json()
    assert statuses(result)[:3] == ("EITHER", COMPATIBLE, COMPATIBLE)           # the specification comparison is the evidence
    assert [item["scope"] for item in result["unresolved"]] == ["C0", "C1"]     # and the unread refs are still reported


# ---- The refs in the request are the refs that are read -------------------------------------------

def test_exactly_the_requested_refs_are_fetched(monkeypatch):
    response, seen, shas = plan(monkeypatch, *SCENARIOS["consumer_first"])
    refs = {ref["label"]: ref for ref in response.json()["refs"]}
    assert {label: (ref["repository"], ref["ref"], ref["commit"]) for label, ref in refs.items()} == {
        "P0": ("acme/billing", "v1", shas[("acme/billing", "v1")]), "P1": ("acme/billing", "v2", shas[("acme/billing", "v2")]),
        "C0": ("acme/shop", "main", shas[("acme/shop", "main")]), "C1": ("acme/shop", "next", shas[("acme/shop", "next")])}
    assert (refs["P0"]["spec_file"], refs["P0"]["api_version"], refs["P1"]["api_version"]) == ("openapi.json", "1.0.0", "2.0.0")
    assert (refs["C0"]["files_read"], refs["C1"]["files_read"], refs["P0"]["files_read"]) == (1, 1, None)
    # Every content request names one of the four commits; the default branch is never looked up.
    assert not any(url.endswith(("/repos/acme/billing", "/repos/acme/shop")) for url in seen)
    for name, ref in (("acme/billing", "v1"), ("acme/billing", "v2")):
        assert any(f"/repos/{name}/contents/openapi.json?ref={shas[(name, ref)]}" in url for url in seen)
    for ref in ("main", "next"):
        assert any(url == f"https://codeload.github.com/acme/shop/zip/{shas[('acme/shop', ref)]}" for url in seen)
    assert not any("codeload.github.com/acme/billing" in url for url in seen)      # the provider's source is not needed


def test_the_same_consumer_ref_twice_is_downloaded_once(monkeypatch):
    response, seen, _ = plan(monkeypatch, *SCENARIOS["consumer_first"], refs=("v1", "v2", "main", "main"))
    assert sum("codeload.github.com" in url for url in seen) == 1
    result = response.json()
    assert statuses(result) == ("CONSUMER_FIRST", INCOMPATIBLE, COMPATIBLE, INCOMPATIBLE)     # C1 is C0 here, so the end state breaks too
    assert "end state (P1 with C1) has a demonstrated incompatibility" in result["summary"]


def test_identical_provider_refs_are_pointed_out(monkeypatch):
    result = plan(monkeypatch, *SCENARIOS["either"], refs=("v1", "v1", "main", "next"))[0].json()
    assert result["recommendation"] == "EITHER" and any("resolve to the same commit" in item["reason"] for item in result["unresolved"])


# ---- Request validation -----------------------------------------------------------------------------

@pytest.mark.parametrize("body, status, code, fragment", [
    ({"provider": {"url": "https://gitlab.com/a/b", "current_ref": "v1", "proposed_ref": "v2"}, "consumer": {"url": CONSUMER, "current_ref": "a", "proposed_ref": "b"}}, 400, "INVALID_TARGETS", "Provider URL"),
    ({"provider": {"url": PROVIDER, "current_ref": "v1", "proposed_ref": "v2"}, "consumer": {"url": CONSUMER + "/tree/main", "current_ref": "a", "proposed_ref": "b"}}, 400, "INVALID_TARGETS", "Consumer URL"),
    ({"provider": {"url": PROVIDER, "current_ref": "", "proposed_ref": "v2"}, "consumer": {"url": CONSUMER, "current_ref": "a", "proposed_ref": "b"}}, 400, "INVALID_REQUEST", "provider.current_ref"),
    ({"provider": {"url": PROVIDER, "current_ref": "v1", "proposed_ref": "v2"}}, 400, "INVALID_REQUEST", "consumer"),
])
def test_invalid_requests_are_rejected_in_the_contract_error_shape(monkeypatch, body, status, code, fragment):
    response, seen, _ = plan(monkeypatch, *SCENARIOS["either"], body=body)
    assert response.status_code == status and response.json()["error_code"] == code and fragment in response.json()["message"]
    assert seen == []                                               # nothing is fetched for a request that is rejected


def test_sign_in_is_enforced_when_the_backend_requires_it(monkeypatch):
    handle, seen, _ = github(*SCENARIOS["either"])
    monkeypatch.setattr(rollout_planner, "Http", lambda **_kwargs: fake_http(handle))
    monkeypatch.setattr(settings, "AUTH_REQUIRED", True)
    body = {"provider": {"url": PROVIDER, "current_ref": "v1", "proposed_ref": "v2"}, "consumer": {"url": CONSUMER, "current_ref": "main", "proposed_ref": "next"}}
    response = TestClient(app).post("/api/v1/rollout", json=body)
    assert response.status_code == 401 and response.json()["error_code"] == "SIGN_IN_REQUIRED" and seen == []


# ---- The dashboard is tested against this real output -------------------------------------------------

def test_frontend_fixture_is_the_current_backend_output(monkeypatch):
    """frontend/src/api/fixtures/rollout-results.json holds what this endpoint returns for the scenarios above."""
    produced = {name: plan(monkeypatch, provider, consumer)[0].json() for name, (provider, consumer) in SCENARIOS.items()}
    assert [produced[name]["recommendation"] for name in SCENARIOS] == ["EITHER", "CONSUMER_FIRST", "PROVIDER_FIRST", "NEITHER", "UNRESOLVED", "UNRESOLVED"]
    text = json.dumps(produced).lower()
    assert "confirmed" not in text and "guarantee" not in text
    if os.environ.get("UPDATE_FIXTURES"):
        FIXTURE.write_text(json.dumps(produced, indent=2) + "\n", encoding="utf-8")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == produced, "run UPDATE_FIXTURES=1 pytest tests/test_rollout.py to refresh the frontend fixture"
