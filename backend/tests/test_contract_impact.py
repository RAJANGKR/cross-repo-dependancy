"""Consumer-aware, field-level contract impact (C1): what consumer code reads
and sends, the evidence tier that follows, and the controlled evaluation in
tests/fixtures/contract_eval. Everything here is offline."""
import importlib.util
import json
from pathlib import Path

import pytest

from app.services import consumer_usage
from app.services import openapi_diff_engine as engine
from app.services.openapi_diff_engine import RepoInput, analyze_specs, consumer_entry
from tests.test_scans import github, scan

BACKEND = Path(__file__).resolve().parents[1]
FIXTURES = BACKEND / "tests" / "fixtures" / "contract_eval"
_spec = importlib.util.spec_from_file_location("evaluate_contract_impact", BACKEND / "scripts" / "evaluate_contract_impact.py")
evaluation = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(evaluation)

EXPECTED = evaluation.load_expected()
RESULT = evaluation.evaluate()
T1, T2, UNRESOLVED, NO_USAGE = "T1_OPERATION_MATCH", "T2_FIELD_MATCH", "UNRESOLVED", "NO_USAGE_FOUND"


def comparison():
    provider = EXPECTED["provider"]
    _, (found,) = analyze_specs([
        RepoInput("billing-v1", {"openapi.yaml": (FIXTURES / provider["baseline"]).read_text()}),
        RepoInput("billing-v2", {"openapi.yaml": (FIXTURES / provider["candidate"]).read_text()}),
    ])
    return found


COMPARISON = comparison()


def impact(change_id, files):
    """(tier, usage) the engine reports for one change of the Billing API fixture."""
    files = files if isinstance(files, dict) else {"client.py" if "def " in files or "import " in files else "client.js": files}
    entry = consumer_entry(COMPARISON, "web", files)
    assert entry["status"] == "ANALYZED", entry["message"]
    change = EXPECTED["changes"][change_id]
    (row,) = [r for r in entry["consumer_impact"] if (r["change_type"], r["method"], r["path"], r["field"]) == (change["change_type"], change["method"], change["path"], change["field"])]
    return row


PY = 'import os, json\nimport requests\nBILLING_URL = os.environ["BILLING_URL"]\n\n'
JS = "const BILLING_URL = process.env.BILLING_URL\n\n"
READS, NOT_READ, UNKNOWN = "READS_CHANGED_FIELD", "FIELD_NOT_READ", "NOT_DETERMINED"
OMITS, SENDS = "OMITS_REQUIRED_FIELD", "SENDS_REQUIRED_FIELD"


# ---- The diff reports the changed element in a structured form -------------------------

def test_findings_name_the_changed_field_and_start_at_tier_zero():
    fields = {(f["change_type"], f["method"], f["path"]): (f["field"], f["field_in"], f["evidence_tier"]) for f in COMPARISON.findings}
    assert fields == {
        ("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/customers/{id}"): ("customer.legacy_id", "response_body", "T0_DETECTED"),
        ("REMOVED_OPERATION", "DELETE", "/customers/{id}/sessions"): ("", "", "T0_DETECTED"),
        ("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/invoices"): ("[].amount", "response_body", "T0_DETECTED"),
        ("NEW_REQUIRED_REQUEST_FIELD", "GET", "/invoices"): ("status", "query", "T0_DETECTED"),
        ("CHANGED_RESPONSE_FIELD_TYPE", "POST", "/invoices"): ("amount", "response_body", "T0_DETECTED"),
        ("NEW_REQUIRED_REQUEST_FIELD", "POST", "/invoices"): ("currency", "request_body", "T0_DETECTED"),
    }


# ---- Python: response fields ---------------------------------------------------------------

@pytest.mark.parametrize("body, tier, usage", [
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    print(response.json()["customer"]["legacy_id"])\n', T2, READS),
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    print(response.json().get("customer", {}).get("legacy_id"))\n', T2, READS),
    ('    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n    customer = data["customer"]\n    print(customer["legacy_id"])\n', T2, READS),
    ('    with requests.get(f"{BILLING_URL}/customers/{cid}") as response:\n        print(response.json()["customer"]["legacy_id"])\n', T2, READS),
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    data = json.loads(response.text)\n    print(data["customer"]["legacy_id"])\n', T2, READS),
    ('    url = f"{BILLING_URL}/customers/{cid}"\n    response = requests.get(url)\n    print(response.json()["customer"]["legacy_id"])\n', T2, READS),   # URL in a variable
    ('    customer = (requests.get(f"{BILLING_URL}/customers/{cid}").json() or {}).get("customer")\n    print(customer["legacy_id"] if customer else None)\n', T2, READS),
    # The operation is called, the field is not read: an operation match, nothing more.
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    print(response.json()["status"], response.json()["customer"]["name"])\n', T1, NOT_READ),
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    print(response.status_code)\n', T1, NOT_READ),
    # Another response in the same function does not count for this call.
    ('    first = requests.get(f"{BILLING_URL}/customers/{cid}")\n    other = requests.get(f"{BILLING_URL}/items")\n    print(first.status_code, other.json()["customer"]["legacy_id"])\n', T1, NOT_READ),
    # The code cannot be followed far enough: unresolved, never "not used".
    ('    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n    print(data["customer"][key])\n', UNRESOLVED, UNKNOWN),
    ('    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n    for name, value in data["customer"].items():\n        print(name, value)\n', UNRESOLVED, UNKNOWN),
    ('    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n    render_somewhere_else(data["customer"])\n', UNRESOLVED, UNKNOWN),
    ('    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n    cache[cid] = data\n', UNRESOLVED, UNKNOWN),
    ('    return requests.get(f"{BILLING_URL}/customers/{cid}").json()["customer"]\n', UNRESOLVED, UNKNOWN),                 # returned, no caller in the files
    ('    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n    if retry:\n        response = requests.get(f"{BILLING_URL}/items")\n    print(response.json()["status"])\n', UNRESOLVED, UNKNOWN),
])
def test_python_response_field_usage(body, tier, usage):
    row = impact("legacy_id", PY + "def show(cid, key=None, retry=False, cache={}):\n" + body)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    assert row["file"] == "client.py" and row["line"] and row["snippet"]


def test_python_response_is_followed_into_callers_and_callees():
    helper = PY + "def fetch_customer(cid):\n    return requests.get(f\"{BILLING_URL}/customers/{cid}\").json()\n"
    reads = "from client import fetch_customer\n\ndef badge(cid):\n    return \"#%s\" % fetch_customer(cid)[\"customer\"][\"legacy_id\"]\n"
    row = impact("legacy_id", {"client.py": helper, "views.py": reads})
    assert (row["evidence_tier"], row["file"], row["line"]) == (T2, "views.py", 4)
    ignores = "from client import fetch_customer\n\ndef name(cid):\n    print(fetch_customer(cid)[\"customer\"][\"name\"])\n"
    assert impact("legacy_id", {"client.py": helper, "views.py": ignores})["usage"] == NOT_READ

    passes = "from store import store_customer\n" + PY + "def sync(cid):\n    data = requests.get(f\"{BILLING_URL}/customers/{cid}\").json()\n    store_customer(record=data[\"customer\"])\n"
    store = "def store_customer(record):\n    print(record[\"legacy_id\"])\n"
    row = impact("legacy_id", {"client.py": passes, "store.py": store})
    assert (row["evidence_tier"], row["file"], row["line"]) == (T2, "store.py", 2)
    # A second definition of the same name elsewhere changes nothing: the import says which one runs.
    row = impact("legacy_id", {"client.py": passes, "store.py": store, "other.py": store.replace("legacy_id", "name")})
    assert (row["evidence_tier"], row["file"]) == (T2, "store.py")
    # Without an import the name alone is not followed, whatever the repository happens to define.
    row = impact("legacy_id", {"client.py": passes.replace("from store import store_customer\n", ""), "store.py": store})
    assert row["evidence_tier"] == UNRESOLVED and "is not imported from an inspected file" in row["explanation"]


# ---- JavaScript / TypeScript: response fields ------------------------------------------------

@pytest.mark.parametrize("body, tier, usage", [
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res.data.customer.legacy_id)\n", T2, READS),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res['data']['customer']['legacy_id'])\n", T2, READS),
    ("  const { data } = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(data.customer?.legacy_id)\n", T2, READS),
    ("  const { data: { customer: { legacy_id: legacyId } } } = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(legacyId)\n", T2, READS),
    ("  const response = await fetch(`${BILLING_URL}/customers/${id}`)\n  const { customer: { legacy_id }, status } = await response.json()\n  console.log(status)\n", T2, READS),
    ("  const response = await fetch(`${BILLING_URL}/customers/${id}`)\n  const body = await response.json()\n  const { legacy_id = 0 } = body.customer\n", T2, READS),
    ("  fetch(`${BILLING_URL}/customers/${id}`).then((r) => r.json()).then((body) => console.log(body.customer.legacy_id))\n", T2, READS),
    ("  fetch(BILLING_URL + '/customers/' + id).then((r) => r.json()).then(({ customer }) => { console.log(customer.legacy_id) })\n", T2, READS),
    ("  const body = JSON.parse(await (await fetch(`${BILLING_URL}/customers/${id}`)).text())\n  console.log(body.customer.legacy_id)\n", T2, READS),
    ("  const res = await axios({ url: `${BILLING_URL}/customers/${id}`, method: 'GET' })\n  console.log(res.data.customer.legacy_id)\n", T2, READS),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res.data.customer.name, res.data.status)\n", T1, NOT_READ),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res.status)\n", T1, NOT_READ),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  const other = await axios.get(`${BILLING_URL}/items`)\n  console.log(res.status, other.data.customer.legacy_id)\n", T1, NOT_READ),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res.data.customer[key])\n", UNRESOLVED, UNKNOWN),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  const copy = { ...res.data.customer }\n", UNRESOLVED, UNKNOWN),
    ("  const { data: { customer: { name, ...rest } } } = await axios.get(`${BILLING_URL}/customers/${id}`)\n", UNRESOLVED, UNKNOWN),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  somethingImported(res.data)\n", UNRESOLVED, UNKNOWN),
    ("  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  return res.data.customer\n", UNRESOLVED, UNKNOWN),
])
def test_javascript_response_field_usage(body, tier, usage):
    row = impact("legacy_id", JS + "export async function show(id, key) {\n" + body + "}\n")
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]


def test_typescript_and_jsx_are_parsed_with_their_own_grammars():
    typed = JS.replace("const BILLING_URL", "const BILLING_URL: string") + (
        "interface Customer { legacy_id: number }\n"
        "export async function show(id: string): Promise<number> {\n"
        "  const res = await axios.get<{ customer: Customer }>(`${BILLING_URL}/customers/${id}`)\n"
        "  const customer = res.data.customer as Customer\n  return customer!.legacy_id satisfies number\n}\n")
    assert impact("legacy_id", {"api.ts": typed})["usage"] == READS
    component = JS + (
        "export function Badge({ id }) {\n  const [customer, setCustomer] = useState(null)\n"
        "  useEffect(() => { axios.get(`${BILLING_URL}/customers/${id}`).then((res) => setCustomer(res.data.customer)) }, [id])\n"
        "  return <b>{customer?.legacy_id}</b>\n}\n")
    row = impact("legacy_id", {"Badge.tsx": component})
    assert (row["usage"], row["line"]) == (READS, 6)
    assert impact("legacy_id", {"Badge.jsx": component.replace("customer?.legacy_id", "customer?.name")})["usage"] == NOT_READ


def test_arrays_loops_and_callbacks_reach_item_fields():
    for source in (
        JS + "export async function f() {\n  const res = await axios.get(`${BILLING_URL}/invoices?status=open`)\n  for (const invoice of res.data) { console.log(invoice.amount) }\n}\n",
        JS + "export async function f() {\n  const res = await axios.get(`${BILLING_URL}/invoices?status=open`)\n  return res.data.filter((i) => i.currency === 'EUR').map(({ amount }) => amount * 2).length\n}\n",
        JS + "export async function f() {\n  const { data: [first] } = await axios.get(`${BILLING_URL}/invoices?status=open`)\n  console.log(first.amount, 1)\n}\n",
        PY + "def f():\n    rows = requests.get(f\"{BILLING_URL}/invoices?status=open\").json()\n    print(sum(row[\"amount\"] for row in rows), rows[0][\"amount\"])\n",
    ):
        assert impact("amount_list", source)["usage"] == READS, source
        assert impact("status", source)["usage"] == SENDS     # ?status= in the URL


# ---- Request payloads ---------------------------------------------------------------------

@pytest.mark.parametrize("call, tier, usage", [
    ('requests.post(f"{BILLING_URL}/invoices", json={"amount": 1, "currency": "EUR"})', T2, SENDS),
    ('requests.post(f"{BILLING_URL}/invoices", json={"amount": 1, "memo": "x"})', T2, OMITS),
    ('requests.post(f"{BILLING_URL}/invoices", data=json.dumps({"amount": 1}))', T2, OMITS),
    ('requests.post(f"{BILLING_URL}/invoices", json=dict(amount=1, currency="EUR"))', T2, SENDS),
    ('requests.post(f"{BILLING_URL}/invoices")', T2, OMITS),
    ('requests.request("POST", f"{BILLING_URL}/invoices", json={"amount": 1})', T2, OMITS),
    ('requests.post(f"{BILLING_URL}/invoices", json=built)', T2, SENDS),                 # built = {...}; built["currency"] = ...
    ('requests.post(f"{BILLING_URL}/invoices", json=updated)', T2, SENDS),               # updated.update({"currency": ...})
    ('requests.post(f"{BILLING_URL}/invoices", json=make_invoice(1))', T2, OMITS),       # a local function returning a literal
    ('requests.post(f"{BILLING_URL}/invoices", json={"amount": 1, **extra})', UNRESOLVED, UNKNOWN),
    ('requests.post(f"{BILLING_URL}/invoices", json=payload)', UNRESOLVED, UNKNOWN),      # a parameter
    ('requests.post(f"{BILLING_URL}/invoices", json=merged)', UNRESOLVED, UNKNOWN),       # merged.update(extra)
    ('requests.post(f"{BILLING_URL}/invoices", json=imported_builder(1))', UNRESOLVED, UNKNOWN),
    ('requests.post(f"{BILLING_URL}/invoices", files={"csv": handle})', UNRESOLVED, UNKNOWN),
    ('requests.post(f"{BILLING_URL}/invoices", **options)', UNRESOLVED, UNKNOWN),
])
def test_python_request_body_fields(call, tier, usage):
    source = PY + (
        "def make_invoice(amount):\n    return {\"amount\": amount, \"memo\": \"\"}\n\n"
        "def create(payload, extra, options, handle):\n"
        "    built = {\"amount\": 1}\n    built[\"currency\"] = \"EUR\"\n"
        "    updated = {\"amount\": 1}\n    updated.update({\"currency\": \"EUR\"})\n"
        "    merged = {\"amount\": 1}\n    merged.update(extra)\n"
        f"    {call}\n")
    row = impact("currency", source)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]


@pytest.mark.parametrize("call, tier, usage", [
    ("fetch(`${BILLING_URL}/invoices`, { method: 'POST', body: JSON.stringify({ amount, currency }) })", T2, SENDS),
    ("fetch(`${BILLING_URL}/invoices`, { method: 'POST', body: JSON.stringify({ amount, memo: 'x' }) })", T2, OMITS),
    ("fetch(`${BILLING_URL}/invoices`, { method: 'POST' })", T2, OMITS),
    ("axios.post(`${BILLING_URL}/invoices`, { amount, 'currency': 'EUR' })", T2, SENDS),
    ("axios.post(`${BILLING_URL}/invoices`, { amount })", T2, OMITS),
    ("axios({ method: 'post', url: `${BILLING_URL}/invoices`, data: { amount } })", T2, OMITS),
    ("axios.post(`${BILLING_URL}/invoices`, built)", T2, SENDS),
    ("axios.post(`${BILLING_URL}/invoices`, makeInvoice(amount))", T2, OMITS),
    ("axios.post(`${BILLING_URL}/invoices`, { amount, ...extra })", UNRESOLVED, UNKNOWN),
    ("axios.post(`${BILLING_URL}/invoices`, { amount, [name]: 1 })", UNRESOLVED, UNKNOWN),
    ("axios.post(`${BILLING_URL}/invoices`, payload)", UNRESOLVED, UNKNOWN),
    ("fetch(`${BILLING_URL}/invoices`, options)", UNRESOLVED, UNKNOWN),
    ("fetch(`${BILLING_URL}/invoices`, { method: 'POST', body: formData })", UNRESOLVED, UNKNOWN),
    ("fetch(`${BILLING_URL}/invoices`, { method: 'POST', ...defaults })", UNRESOLVED, UNKNOWN),
])
def test_javascript_request_body_fields(call, tier, usage):
    source = JS + (
        "const makeInvoice = (amount) => ({ amount, memo: '' })\n\n"
        "export async function create(amount, currency, payload, extra, options, formData, defaults, name) {\n"
        "  const built = { amount }\n  built.currency = currency\n"
        f"  await {call}\n}}\n")
    row = impact("currency", source)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]


@pytest.mark.parametrize("source, tier, usage", [
    (PY + 'def f():\n    requests.get(f"{BILLING_URL}/invoices", params={"status": "open", "page": 2})\n', T2, SENDS),
    (PY + 'def f():\n    requests.get(f"{BILLING_URL}/invoices", params={"page": 2})\n', T2, OMITS),
    (PY + 'def f():\n    requests.get(f"{BILLING_URL}/invoices")\n', T2, OMITS),
    (PY + 'def f(filters):\n    requests.get(f"{BILLING_URL}/invoices", params=filters)\n', UNRESOLVED, UNKNOWN),
    (PY + 'def f(query):\n    requests.get(f"{BILLING_URL}/invoices?{query}")\n', UNRESOLVED, UNKNOWN),
    (JS + "export const f = () => axios.get(`${BILLING_URL}/invoices`, { params: { status: 'open' } }).then(() => 1)\n", T2, SENDS),
    (JS + "export const f = (page) => axios.get(`${BILLING_URL}/invoices`, { params: { page } }).then(() => 1)\n", T2, OMITS),
    (JS + "export const f = (page) => fetch(`${BILLING_URL}/invoices?page=${page}&status=open`).then(() => 1)\n", T2, SENDS),
    (JS + "export const f = (qs) => fetch(`${BILLING_URL}/invoices?${qs}`).then(() => 1)\n", UNRESOLVED, UNKNOWN),
    (JS + "export const f = (config) => axios.get(`${BILLING_URL}/invoices`, config).then(() => 1)\n", UNRESOLVED, UNKNOWN),
])
def test_query_parameters(source, tier, usage):
    row = impact("status", source)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]


def test_a_newly_required_header_is_only_resolved_when_the_call_sets_it():
    def doc(required):
        return json.dumps({"openapi": "3.0.3", "info": {"title": "Billing API", "version": "2.0.0" if required else "1.0.0"}, "paths": {"/invoices": {"get": {
            "parameters": [{"name": "X-Tenant", "in": "header", "required": required}], "responses": {"200": {"description": "ok"}}}}}})

    _, (found,) = analyze_specs([RepoInput("a", {"openapi.json": doc(False)}), RepoInput("b", {"openapi.json": doc(True)})])
    row = lambda call: consumer_entry(found, "web", {"c.js": JS + f"export const f = () => {call}.then(() => 1)\n"})["consumer_impact"][0]
    assert row("axios.get(`${BILLING_URL}/invoices`, { headers: { 'x-tenant': 't1' } })")["usage"] == SENDS
    assert row("axios.get(`${BILLING_URL}/invoices`)")["evidence_tier"] == UNRESOLVED      # a shared client may add it
    assert "shared client" in row("axios.get(`${BILLING_URL}/invoices`)")["explanation"]


# ---- What is and is not claimed ----------------------------------------------------------------

def test_an_operation_match_never_becomes_a_field_claim():
    entry = consumer_entry(COMPARISON, "web", {"a.js": JS + "export async function name(id) {\n  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n  console.log(res.data.customer.name)\n}\n"})
    (finding,) = entry["findings"]
    assert (finding["evidence_tier"], finding["usage"]) == (T1, NOT_READ)
    assert "a call alone does not show the field is used" in finding["impact"]
    assert "reads customer, customer.name" in finding["explanation"] and "no read of 'customer.legacy_id' was found" in finding["explanation"]


def test_no_usage_is_reported_as_no_usage_not_as_safe():
    entry = consumer_entry(COMPARISON, "web", {"a.js": JS + "export const items = () => fetch(`${BILLING_URL}/items`).then((r) => r.status)\n"})
    assert entry["status"] == "ANALYZED" and entry["findings"] == []
    assert {row["evidence_tier"] for row in entry["consumer_impact"]} == {NO_USAGE}
    assert all("This is not proof that it is unaffected" in row["explanation"] and row["file"] == "" and row["line"] is None for row in entry["consumer_impact"])
    assert "6 with no usage found" in entry["message"]


def test_a_call_that_already_satisfies_the_change_is_not_listed_as_a_finding():
    entry = consumer_entry(COMPARISON, "web", {"a.py": PY + 'def f():\n    requests.post(f"{BILLING_URL}/invoices", json={"amount": 1, "currency": "EUR"})\n'})
    rows = {row["field"]: row for row in entry["consumer_impact"] if row["path"] == "/invoices" and row["method"] == "POST"}
    assert rows["currency"]["usage"] == SENDS and "already sends" in rows["currency"]["explanation"]
    assert [f["field"] for f in entry["findings"]] == ["amount"]      # only the operation-level row about the response remains


def test_static_evidence_is_never_called_a_confirmed_failure():
    text = json.dumps([evaluation.run_tool(EXPECTED), COMPARISON.findings]).lower()
    assert "confirmed" not in text.replace("not a confirmed runtime failure", "")
    assert "safe" not in text.replace("unsafe", "")


def test_unsupported_or_unparseable_sources_are_unresolved_with_a_reason(monkeypatch):
    call = '    response = requests.get(f"{BILLING_URL}/customers/{cid}")\n'
    broken = PY + "def show(cid):\n" + call + "    print(response.json()[\"customer\"][\"legacy_id\"]\n"       # unbalanced parenthesis
    row = impact("legacy_id", {"client.py": broken})
    assert row["evidence_tier"] == UNRESOLVED and "could not be parsed" in row["explanation"]

    java = "class C {\n  String BILLING_URL = env(\"BILLING_URL\");\n  Object f(String id) { return rest.getForObject(BILLING_URL + \"/customers/\" + id, Map.class); }\n}\n"
    row = impact("legacy_id", {"C.java": java})
    assert row["evidence_tier"] == UNRESOLVED and "Python, JavaScript and TypeScript only" in row["explanation"]

    source = JS + "export const f = async (id) => console.log((await axios.get(`${BILLING_URL}/customers/${id}`)).data.customer.legacy_id)\n"
    assert impact("legacy_id", {"a.js": source})["usage"] == READS
    monkeypatch.setattr(consumer_usage, "_JS_AVAILABLE", False)
    row = impact("legacy_id", {"a.js": source})
    assert row["evidence_tier"] == UNRESOLVED and "tree-sitter" in row["explanation"]

    monkeypatch.setattr(consumer_usage.Repository, "_call_facts", lambda *_: 1 / 0)
    assert "could not be analyzed (ZeroDivisionError)" in impact("legacy_id", {"client.py": PY + "def show(cid):\n" + call})["explanation"]


# ---- Controlled evaluation ----------------------------------------------------------------------

def test_fixture_set_covers_the_required_scenarios():
    consumers = EXPECTED["consumers"]
    covers = " ".join(spec["covers"] for spec in consumers.values())
    for phrase in ("changed response field that a consumer reads", "new required request field that a consumer does not send", "calls the endpoint but does not use the changed field",
                   "unrelated service with overlapping paths", "dynamic field access that must remain unresolved", "dynamic URL that must remain unresolved",
                   "Regression for defect A", "Regression for defect B", "defect C"):
        assert phrase.lower() in covers.lower(), phrase
    assert set(consumers) == {path.name for path in (FIXTURES / "consumers").iterdir()}
    assert "before the tool was run" in EXPECTED["about"]


@pytest.mark.parametrize("case", RESULT["cases"], ids=lambda case: f"{case['consumer']}:{case['change']}")
def test_actual_result_matches_the_reviewed_expected_result(case):
    assert (case["actual_tier"], case["actual_usage"]) == (case["expected_tier"], case["expected_usage"]), case["explanation"]
    assert case["matches_expected"], f"evidence location {case['actual_location']} differs from the expected file and line"


def test_the_three_fixed_defects_stay_fixed_in_the_evaluation():
    by = {(case["consumer"], case["change"]): case for case in RESULT["cases"]}
    assert all(by[("nested_paths", change)]["actual_tier"] == NO_USAGE for change in EXPECTED["changes"])                 # A: nested paths are other routes
    assert by[("method_neighbors", "sessions")]["actual_tier"] == NO_USAGE                                             # B: the DELETE next door is not this call's method
    assert {by[(name, change)]["actual_tier"] for name in ("unrelated_shop", "shared_paths") for change in EXPECTED["changes"]} == {"RELATIONSHIP_UNVERIFIED"}   # C


def test_usage_detection_precision_and_recall_on_the_fixtures():
    """What is measured is whether usage of a changed element is detected, not whether anything breaks."""
    counts = RESULT["counts"]
    assert RESULT["task"] == "changed-element usage detection"
    assert len(RESULT["cases"]) == 174 and RESULT["matching_expected"] == 174
    # Reported as measured. Every miss is a real usage the tool declines to assert because it cannot establish it.
    assert counts == {"TP": 12, "FP": 0, "FN": 5, "TN": 157}
    assert {(case["consumer"], case["actual_tier"], case["actual_usage"]) for case in RESULT["cases"] if case["outcome"] == "FN"} == {
        ("dynamic_field", UNRESOLVED, UNKNOWN), ("dynamic_url", UNRESOLVED, UNKNOWN), ("dynamic_url_concat", UNRESOLVED, UNKNOWN),
        ("dynamic_url_template", UNRESOLVED, UNKNOWN), ("conditional_field", T2, "MAY_SEND_REQUIRED_FIELD")}
    assert RESULT["usage_detection_precision"] == 1.0 and RESULT["meets_precision_target"]
    # The recall target of 0.80 is currently missed, and the evaluation says so.
    assert round(RESULT["usage_detection_recall"], 3) == 0.706 and not RESULT["meets_recall_target"]
    assert not any("breakage" in key or "compatib" in key or key in ("precision", "recall") for key in RESULT)


def test_the_review_defect_patterns_are_not_asserted_as_usage():
    by = {(case["consumer"], case["change"]): case for case in RESULT["cases"]}
    for consumer in ("imported_function_name", "method_name_match", "other_object_call", "unknown_method", "axios_default_params", "axios_interceptor", "py_session_defaults"):
        assert not any(by[(consumer, change)]["usage_asserted"] for change in EXPECTED["changes"]), consumer
    assert (by[("conditional_field", "currency")]["actual_usage"], by[("conditional_field", "currency")]["usage_asserted"]) == ("MAY_SEND_REQUIRED_FIELD", False)


def test_evaluation_script_runs_standalone():
    import subprocess
    import sys

    script = str(BACKEND / "scripts" / "evaluate_contract_impact.py")
    done = subprocess.run([sys.executable, script], capture_output=True, text=True, cwd=BACKEND)
    assert done.returncode == 0, done.stdout + done.stderr      # no case differs from its reviewed expected result
    assert "Changed-element usage detection: 29 consumers x 6 changes = 174 cases" in done.stdout
    assert "usage asserted and real 12, asserted but not real 0, real but not asserted 5" in done.stdout
    assert "usage-detection precision 1.000 (target 0.90): met" in done.stdout
    assert "usage-detection recall    0.706 (target 0.80): NOT MET" in done.stdout
    assert "It is not a\n  measure of breakage" in done.stdout
    # --strict turns a missed research target into a failing exit code.
    assert subprocess.run([sys.executable, script, "--strict"], capture_output=True, text=True, cwd=BACKEND).returncode == 1


# ---- Through the real scan ------------------------------------------------------------------------

def test_scan_results_carry_evidence_tiers():
    record = scan(github("orders-v1", "orders-v2", "storefront", "mobile-bff", "reports"))
    entries = record.result["contract_analysis"]
    spec_level = next(e for e in entries if e["status"] == "ANALYZED" and not e["consumer_repo"])
    assert {f["evidence_tier"] for f in spec_level["findings"]} == {"T0_DETECTED"} and "consumer_impact" not in spec_level

    storefront = next(e for e in entries if e["consumer_repo"] == "storefront")
    rows = {(r["change_type"], r["method"], r["path"]): r for r in storefront["consumer_impact"]}
    assert len(rows) == 6
    assert rows[("REMOVED_PATH", "", "/orders/{id}/refunds")]["evidence_tier"] == T1
    # `(id) => axios.get(...)` hands the response to callers that are not in the repository.
    lookup = rows[("CHANGED_RESPONSE_FIELD_TYPE", "GET", "/orders/{orderId}")]
    assert lookup["evidence_tier"] == UNRESOLVED and "getOrder()" in lookup["explanation"] and (lookup["file"], lookup["line"]) == ("src/api.js", 4)
    assert rows[("NEW_REQUIRED_REQUEST_FIELD", "POST", "/orders")]["evidence_tier"] == NO_USAGE

    bff = next(e for e in entries if e["consumer_repo"] == "mobile-bff")
    assert [(r["evidence_tier"], r["usage"]) for r in bff["consumer_impact"] if r["change_type"] == "REMOVED_OPERATION"] == [(T1, "CALLS_OPERATION")]
    reports = next(e for e in entries if e["consumer_repo"] == "reports")
    assert reports["findings"] == [] and {r["evidence_tier"] for r in reports["consumer_impact"]} == {NO_USAGE}


def test_scan_reports_field_level_evidence_for_a_consumer():
    record = scan(github("orders-v1", "orders-v2", "checkout"))
    (entry,) = [e for e in record.result["contract_analysis"] if e["consumer_repo"] == "checkout"]
    rows = {(r["method"], r["path"], r["field"]): (r["evidence_tier"], r["usage"], r["file"], r["line"]) for r in entry["consumer_impact"]}
    assert rows == {
        ("GET", "/orders/{orderId}", "id"): (T2, READS, "src/checkout.js", 7),                    # String(res.data.id)
        ("POST", "/orders", "currency"): (T2, OMITS, "src/checkout.js", 10),                       # { item } only
        ("GET", "/orders", "status"): (T2, SENDS, "src/checkout.js", 13),                          # params: { status }
        ("GET", "/orders", "[].id"): (T1, NOT_READ, "src/checkout.js", 13),                        # only .length is used
        ("DELETE", "/orders/{id}", ""): (NO_USAGE, NO_USAGE, "", None),
        ("", "/orders/{id}/refunds", ""): (NO_USAGE, NO_USAGE, "", None),
    }
    # Findings list what may affect the consumer; the call that already sends `status` is not one of them.
    assert sorted((f["evidence_tier"], f["field"], f["source_file"], f["source_line"]) for f in entry["findings"]) == [
        (T1, "[].id", "src/checkout.js", 13), (T2, "currency", "src/checkout.js", 10), (T2, "id", "src/checkout.js", 7)]
    assert "2 field-level match(es)" not in entry["message"] and "3 field-level match(es), 1 operation-level match(es), 2 with no usage found" in entry["message"]
