"""Regression tests for the C1 hardening review: every case here was a
confident claim that the evidence did not support. When static evidence is
insufficient the expected answer is UNRESOLVED with a reason."""
import pytest

from app.services import openapi_diff_engine as engine
from app.services.openapi_diff_engine import consumer_entry
from tests.test_contract_impact import COMPARISON, EXPECTED, JS, NO_USAGE, PY, T1, T2, UNRESOLVED, impact

READS, NOT_READ, UNKNOWN = "READS_CHANGED_FIELD", "FIELD_NOT_READ", "NOT_DETERMINED"
OMITS, SENDS, MAY_SEND, CALLS = "OMITS_REQUIRED_FIELD", "SENDS_REQUIRED_FIELD", "MAY_SEND_REQUIRED_FIELD", "CALLS_OPERATION"
GET_CUSTOMER = "  const res = await axios.get(`${BILLING_URL}/customers/${id}`)\n"
PY_CUSTOMER = '    data = requests.get(f"{BILLING_URL}/customers/{cid}").json()\n'


def verdict(change, files):
    row = impact(change, files)
    return row["evidence_tier"], row["usage"]


def rows(files):
    entry = consumer_entry(COMPARISON, "web", files)
    return entry, {(r["method"], r["path"], r["field"]): r for r in entry.get("consumer_impact", [])}


# ---- 2. A call is followed only into the function it can be shown to reach -----------------

def test_an_imported_function_is_not_confused_with_a_local_one_of_the_same_name():
    files = {
        "a.js": "import { save } from 'some-library'\n" + JS + "export async function sync(id) {\n" + GET_CUSTOMER + "  save(res.data.customer)\n}\n",
        "tools/disk.js": "export function save(file) {\n  console.log(file.legacy_id)\n}\n",          # unrelated: saves files
    }
    row = impact("legacy_id", files)
    assert (row["evidence_tier"], row["usage"]) == (UNRESOLVED, UNKNOWN)
    assert "imported from 'some-library', which is not among the inspected files" in row["explanation"]


def test_a_method_call_is_not_matched_to_a_free_function_of_the_same_name():
    files = {
        "a.js": JS + "export class Sync {\n  async run(id) {\n  " + GET_CUSTOMER + "    this.cache.store(res.data.customer)\n  }\n}\n",
        "b.js": "export function store(record) {\n  return record.legacy_id\n}\n",
    }
    row = impact("legacy_id", files)
    assert (row["evidence_tier"], row["usage"]) == (UNRESOLVED, UNKNOWN)
    assert "store() is called on 'this.cache', whose type is not known statically" in row["explanation"]


def test_a_call_on_another_object_is_not_a_caller_of_the_local_function():
    files = {
        "client.py": PY + "def fetch_customer(cid):\n    return requests.get(f\"{BILLING_URL}/customers/{cid}\").json()\n",
        "crm.py": "def report(crm, cid):\n    return crm.fetch_customer(cid)[\"customer\"][\"legacy_id\"]\n",   # crm is some other client
    }
    row = impact("legacy_id", files)
    assert (row["evidence_tier"], row["usage"]) == (UNRESOLVED, UNKNOWN)
    assert "returned by fetch_customer()" in row["explanation"] and "unknown type" in row["explanation"]


@pytest.mark.parametrize("files, where", [
    # Callee reached through a relative import.
    ({"a.js": "import { saveCustomer } from './store'\n" + JS + "export async function sync(id) {\n" + GET_CUSTOMER + "  saveCustomer(res.data.customer)\n}\n",
      "store.js": "export function saveCustomer(customer) {\n  console.log(customer.legacy_id)\n}\n"}, ("store.js", 2)),
    # Callee defined in the same file, and a default import.
    ({"a.js": JS + "function show(customer) {\n  console.log(customer.legacy_id)\n}\nexport async function sync(id) {\n" + GET_CUSTOMER + "  show(res.data.customer)\n}\n"}, ("a.js", 4)),
    ({"a.ts": "import persist from './lib/persist'\n" + JS + "export async function sync(id: string) {\n" + GET_CUSTOMER + "  persist(res.data.customer)\n}\n",
      "lib/persist.ts": "export default function persist(customer: any) {\n  console.log(customer.legacy_id)\n}\n"}, ("lib/persist.ts", 2)),
    # A namespace import, a method of the same class, and an instance constructed in the file.
    ({"a.js": "import * as store from './store'\n" + JS + "export async function sync(id) {\n" + GET_CUSTOMER + "  store.keep(res.data.customer)\n}\n",
      "store.js": "export const keep = (customer) => console.log(customer.legacy_id)\n"}, ("store.js", 1)),
    ({"a.js": JS + "export class Sync {\n  async run(id) {\n  " + GET_CUSTOMER + "    this.keep(res.data.customer)\n  }\n  keep(customer) {\n    console.log(customer.legacy_id)\n  }\n}\n"}, ("a.js", 9)),
    ({"a.js": JS + "class Store {\n  keep(customer) {\n    console.log(customer.legacy_id)\n  }\n}\nconst store = new Store()\nexport async function sync(id) {\n" + GET_CUSTOMER + "  store.keep(res.data.customer)\n}\n"}, ("a.js", 5)),
    # Python: imported callee, method on self, caller through an import, caller through a constructed instance.
    ({"client.py": "from store import keep\n" + PY + "def sync(cid):\n" + PY_CUSTOMER + "    keep(data[\"customer\"])\n",
      "store.py": "def keep(record):\n    print(record[\"legacy_id\"])\n"}, ("store.py", 2)),
    ({"client.py": PY + "class Sync:\n    def run(self, cid):\n    " + PY_CUSTOMER + "        self.keep(data[\"customer\"])\n\n    def keep(self, record):\n        print(record[\"legacy_id\"])\n"}, ("client.py", 11)),
    ({"client.py": PY + "def fetch_customer(cid):\n    return requests.get(f\"{BILLING_URL}/customers/{cid}\").json()\n",
      "views.py": "from client import fetch_customer\n\ndef badge(cid):\n    print(fetch_customer(cid)[\"customer\"][\"legacy_id\"])\n"}, ("views.py", 4)),
    ({"client.py": PY + "class Billing:\n    def customer(self, cid):\n        return requests.get(f\"{BILLING_URL}/customers/{cid}\").json()\n",
      "views.py": "from client import Billing\n\ndef badge(cid):\n    billing = Billing()\n    print(billing.customer(cid)[\"customer\"][\"legacy_id\"])\n"}, ("views.py", 5)),
])
def test_resolvable_callers_and_callees_are_still_followed(files, where):
    row = impact("legacy_id", files)
    assert (row["evidence_tier"], row["usage"], row["file"], row["line"]) == (T2, READS, *where), row["explanation"]


def test_the_imported_definition_is_used_when_two_files_define_the_name():
    files = {
        "a.js": "import { keep } from './real'\n" + JS + "export async function sync(id) {\n" + GET_CUSTOMER + "  keep(res.data.customer)\n}\n",
        "real.js": "export function keep(customer) {\n  console.log(customer.name)\n}\n",
        "decoy.js": "export function keep(customer) {\n  console.log(customer.legacy_id)\n}\n",
    }
    assert verdict("legacy_id", files) == (T1, NOT_READ)                # only real.js runs, and it reads the name
    files["a.js"] = files["a.js"].replace("./real", "./decoy")
    assert verdict("legacy_id", files) == (T2, READS)


def test_react_state_is_followed_only_inside_its_own_component():
    component = lambda name, field: (
        f"export function {name}({{ id }}) {{\n  const [customer, setCustomer] = useState(null)\n"
        f"  useEffect(() => {{ load(id).then((value) => setCustomer(value)) }}, [id])\n  return <b>{{customer?.{field}}}</b>\n}}\n")
    billing = JS + (
        "export function Badge({ id }) {\n  const [customer, setCustomer] = useState(null)\n"
        "  useEffect(() => { axios.get(`${BILLING_URL}/customers/${id}`).then((res) => setCustomer(res.data.customer)) }, [id])\n"
        "  return <b>{customer?.name}</b>\n}\n")
    # Another component in the same file uses the same state names for something else.
    assert verdict("legacy_id", {"Badge.jsx": billing + component("Other", "legacy_id")}) == (T1, NOT_READ)


# ---- 3. "Does not send" needs complete evidence about the client ----------------------------

LIST = "export const list = () => api.get(`${BILLING_URL}/invoices`).then((r) => r.status)\n"


@pytest.mark.parametrize("source, tier, usage, fragment", [
    # Defaults on an axios instance: resolved when they are literal.
    (JS + "const api = axios.create({ baseURL: BILLING_URL, params: { status: 'open' } })\n" + LIST, T2, SENDS, "default"),
    (JS + "const api = axios.create({ baseURL: BILLING_URL, params: { page: 1 } })\n" + LIST, T2, OMITS, ""),
    (JS + "const api = axios.create({ baseURL: BILLING_URL })\n" + LIST, T2, OMITS, ""),
    (JS + "const api = axios.create({ baseURL: BILLING_URL, ...shared })\n" + LIST, UNRESOLVED, UNKNOWN, "client"),
    (JS + "const api = axios.create(options)\n" + LIST, UNRESOLVED, UNKNOWN, "client"),
    (JS + "const api = axios.create({ baseURL: BILLING_URL })\napi.defaults.params = { status: 'open' }\n" + LIST, T2, SENDS, "default"),
    # A client that is not built here: nothing is known about what it adds.
    (JS + "export const list = (api) => api.get(`${BILLING_URL}/invoices`).then((r) => r.status)\n", UNRESOLVED, UNKNOWN, "client"),
    (JS + "import { api } from 'our-sdk'\n" + LIST, UNRESOLVED, UNKNOWN, "client"),
    (JS + "export class Service {\n  list() { return this.http.get(`${BILLING_URL}/invoices`).then((r) => r.status) }\n}\n", UNRESOLVED, UNKNOWN, "client"),
    # Direct calls with nothing shared: an omission is still an omission.
    (JS + "export const list = () => axios.get(`${BILLING_URL}/invoices`).then((r) => r.status)\n", T2, OMITS, ""),
    (JS + "export const list = () => fetch(`${BILLING_URL}/invoices`).then((r) => r.status)\n", T2, OMITS, ""),
])
def test_axios_client_defaults(source, tier, usage, fragment):
    row = impact("status", {"a.js": source})
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    assert fragment in row["explanation"]


MAKE = "export const make = (amount) => axios.post(`${BILLING_URL}/invoices`, { amount }).then((r) => r.status)\n"


@pytest.mark.parametrize("files, tier, usage, fragment", [
    ({"a.js": JS + "axios.interceptors.request.use((config) => { config.data = { ...config.data, currency: 'EUR' }; return config })\n" + MAKE}, T2, SENDS, "interceptor"),
    ({"a.js": JS + "axios.interceptors.request.use((config) => { config.data.currency = 'EUR'; return config })\n" + MAKE}, T2, SENDS, "interceptor"),
    ({"a.js": JS + "axios.interceptors.request.use((config) => { if (config.eu) { config.data.currency = 'EUR' } return config })\n" + MAKE}, T2, MAY_SEND, "interceptor"),
    ({"a.js": JS + "axios.interceptors.request.use((config) => enrich(config))\n" + MAKE}, UNRESOLVED, UNKNOWN, "interceptor"),
    ({"a.js": JS + "axios.interceptors.request.use(addDefaults)\n" + MAKE}, UNRESOLVED, UNKNOWN, "interceptor"),
    # Registered in another file of the repository: it still applies to the shared axios object.
    ({"a.js": JS + MAKE, "setup.js": "import axios from 'axios'\naxios.interceptors.request.use((config) => { config.data.currency = 'EUR'; return config })\n"}, T2, SENDS, "setup.js"),
    ({"a.js": JS + MAKE, "setup.js": "export function install(client) {\n  client.interceptors.request.use((config) => sign(config))\n}\n"}, UNRESOLVED, UNKNOWN, "interceptor"),
    # No interceptor anywhere: the direct omission is still detected.
    ({"a.js": JS + MAKE}, T2, OMITS, "it sends amount"),
    # fetch is not affected by axios interceptors.
    ({"a.js": JS + "axios.interceptors.request.use((config) => enrich(config))\nexport const make = (amount) => fetch(`${BILLING_URL}/invoices`, { method: 'POST', body: JSON.stringify({ amount }) }).then((r) => r.status)\n"}, T2, OMITS, ""),
])
def test_axios_interceptors(files, tier, usage, fragment):
    row = impact("currency", files)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    assert fragment in row["explanation"]


@pytest.mark.parametrize("body, tier, usage, fragment", [
    ('session = requests.Session()\nsession.params = {"status": "open"}\n\ndef f():\n    session.get(f"{BILLING_URL}/invoices")\n', T2, SENDS, "default"),
    ('session = requests.Session()\nsession.params.update({"status": "open"})\n\ndef f():\n    session.get(f"{BILLING_URL}/invoices")\n', T2, SENDS, "default"),
    ('def f():\n    session = requests.Session()\n    session.params["status"] = "open"\n    session.get(f"{BILLING_URL}/invoices")\n', T2, SENDS, "default"),
    ('def f(flag):\n    session = requests.Session()\n    if flag:\n        session.params["status"] = "open"\n    session.get(f"{BILLING_URL}/invoices")\n', T2, MAY_SEND, "some"),
    ('session = requests.Session()\nsession.headers.update({"X-Tenant": "t"})\n\ndef f():\n    session.get(f"{BILLING_URL}/invoices")\n', T2, OMITS, ""),
    ('session = requests.Session()\nsession.params = load_defaults()\n\ndef f():\n    session.get(f"{BILLING_URL}/invoices")\n', UNRESOLVED, UNKNOWN, "session"),
    ('def f(session):\n    session.get(f"{BILLING_URL}/invoices")\n', UNRESOLVED, UNKNOWN, "client"),
    ('class Api:\n    def f(self):\n        self._client.get(f"{BILLING_URL}/invoices")\n', UNRESOLVED, UNKNOWN, "client"),
    ('def f():\n    requests.get(f"{BILLING_URL}/invoices")\n', T2, OMITS, "it sends no query parameters"),
    ('def f():\n    requests.get(f"{BILLING_URL}/invoices", params={"status": "open"})\n', T2, SENDS, ""),
    # A value the call itself sends is known whatever the client is.
    ('def f(session):\n    session.get(f"{BILLING_URL}/invoices", params={"status": "open"})\n', T2, SENDS, ""),
])
def test_python_session_defaults(body, tier, usage, fragment):
    row = impact("status", PY + body)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    assert fragment in row["explanation"]


@pytest.mark.parametrize("source, name", [
    (PY + 'def f():\n    requests.get(with_defaults(f"{BILLING_URL}/invoices"))\n', "a.py"),
    (JS + "export const f = () => axios.get(withDefaults(`${BILLING_URL}/invoices`)).then((r) => r.status)\n", "a.js"),
])
def test_a_url_passed_through_a_helper_may_gain_query_parameters(source, name):
    row = impact("status", {name: source})
    assert (row["evidence_tier"], row["usage"]) == (UNRESOLVED, UNKNOWN) and "may add query parameters" in row["explanation"]


# ---- 4. A URL does not say which HTTP method is used -----------------------------------------

SESSIONS = ("DELETE", "/customers/{id}/sessions", "")


@pytest.mark.parametrize("source, name, tier, usage", [
    # The method is not knowable: neither a match nor "no usage".
    (JS + "export function f(id, client) {\n  const url = `${BILLING_URL}/customers/${id}/sessions`\n  return client.send(url)\n}\n", "a.js", UNRESOLVED, UNKNOWN),
    (JS + "export const f = (id, options) => fetch(`${BILLING_URL}/customers/${id}/sessions`, options)\n", "a.js", UNRESOLVED, UNKNOWN),
    (JS + "export const f = (id, method) => axios({ url: `${BILLING_URL}/customers/${id}/sessions`, method })\n", "a.js", UNRESOLVED, UNKNOWN),
    (PY + "def f(cid, transport):\n    url = f\"{BILLING_URL}/customers/{cid}/sessions\"\n    return transport.send(url)\n", "a.py", UNRESOLVED, UNKNOWN),
    (PY + "def f(cid, verb):\n    return requests.request(verb, f\"{BILLING_URL}/customers/{cid}/sessions\")\n", "a.py", UNRESOLVED, UNKNOWN),
    (JS + "export const SESSIONS = `${BILLING_URL}/customers/1/sessions`\n", "a.js", UNRESOLVED, UNKNOWN),          # never passed to a call here
    # An explicit DELETE is a call to the removed operation.
    (JS + "export const f = (id) => axios.delete(`${BILLING_URL}/customers/${id}/sessions`)\n", "a.js", T1, CALLS),
    (JS + "export const f = (id) => fetch(`${BILLING_URL}/customers/${id}/sessions`, { method: 'DELETE' })\n", "a.js", T1, CALLS),
    (PY + "def f(cid):\n    url = f\"{BILLING_URL}/customers/{cid}/sessions\"\n    requests.delete(url)\n", "a.py", T1, CALLS),      # local data flow
    (JS + "export function f(id) {\n  const url = `${BILLING_URL}/customers/${id}/sessions`\n  return axios.delete(url)\n}\n", "a.js", T1, CALLS),
    (PY + "def f(cid):\n    requests.request(\"DELETE\", f\"{BILLING_URL}/customers/{cid}/sessions\")\n", "a.py", T1, CALLS),
    # The GET that still exists is not the removed DELETE.
    (JS + "export const f = (id) => fetch(`${BILLING_URL}/customers/${id}/sessions`).then((r) => r.status)\n", "a.js", NO_USAGE, NO_USAGE),
    (JS + "export const f = (id) => axios.get(`${BILLING_URL}/customers/${id}/sessions`).then((r) => r.status)\n", "a.js", NO_USAGE, NO_USAGE),
    (PY + "def f(cid):\n    url = f\"{BILLING_URL}/customers/{cid}/sessions\"\n    requests.get(url)\n", "a.py", NO_USAGE, NO_USAGE),
])
def test_removed_operation_needs_a_known_method(source, name, tier, usage):
    entry, found = rows({name: source})
    row = found[SESSIONS]
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    if tier == UNRESOLVED:
        assert "HTTP method could not be determined" in row["explanation"] and row["file"] == name and row["line"]
        # Reported as something that could not be analyzed, never as a call to the removed operation.
        assert [f["usage"] for f in entry["findings"] if f["change_type"] == "REMOVED_OPERATION"] == [UNKNOWN]
        assert "no longer defines" not in row["explanation"]


def test_an_unknown_method_is_not_a_field_claim_either():
    source = JS + "export async function f(id, client) {\n  const url = `${BILLING_URL}/customers/${id}`\n  const res = await client.send(url)\n  return res.data.customer.legacy_id\n}\n"
    row = impact("legacy_id", {"a.js": source})
    assert (row["evidence_tier"], row["usage"]) == (UNRESOLVED, UNKNOWN) and "HTTP method could not be determined" in row["explanation"]


def test_a_removed_path_is_affected_whatever_the_method():
    removed = dict(COMPARISON.findings[0], change_type="REMOVED_PATH", method="", path="/customers/{id}/sessions", field="", field_in="")
    comparison = engine.Comparison(COMPARISON.baseline, COMPARISON.candidate, COMPARISON.basis, [removed], COMPARISON.holders)
    entry = consumer_entry(comparison, "web", {"a.js": JS + "export function f(id, client) {\n  const url = `${BILLING_URL}/customers/${id}/sessions`\n  return client.send(url)\n}\n"})
    assert [(r["evidence_tier"], r["usage"]) for r in entry["consumer_impact"]] == [(T1, CALLS)]


# ---- 5. A field set on some paths is not "already sent" ---------------------------------------

POST = '    requests.post(f"{BILLING_URL}/invoices", json=p)\n'


@pytest.mark.parametrize("body, tier, usage", [
    ('def f(c):\n    p = {"amount": 1}\n    p["currency"] = c\n' + POST, T2, SENDS),                              # unconditional
    ('def f(c):\n    p = {"amount": 1, "currency": c if c else "EUR"}\n' + POST, T2, SENDS),
    ('def f(c):\n    p = {"amount": 1}\n    if c:\n        p["currency"] = c\n' + POST, T2, MAY_SEND),               # the reviewed defect
    ('def f(c):\n    p = {"amount": 1}\n    for code in c:\n        p["currency"] = code\n' + POST, T2, MAY_SEND),
    ('def f(c):\n    p = {"amount": 1}\n    try:\n        p.update({"currency": lookup(c)})\n    except KeyError:\n        pass\n' + POST, T2, MAY_SEND),
    ('def f(c):\n    p = {"amount": 1}\n    if c:\n        p["currency"] = c\n    ' + POST, T2, SENDS),              # the request is made under the same condition
    ('def f(c):\n    p = {"amount": 1}\n    if c:\n        p["currency"] = c\n    else:\n    ' + POST, T2, OMITS),  # ...or only in the other branch
    ('def f(c):\n    p = {"amount": 1}\n' + POST + '    p["currency"] = c\n', T2, OMITS),                            # set after the request
    ('def f(c):\n    p = {"amount": 1}\n    if c:\n        p["memo"] = c\n' + POST, T2, OMITS),                      # absent on every path
])
def test_python_conditional_request_fields(body, tier, usage):
    row = impact("currency", PY + body)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]
    if usage == MAY_SEND:
        assert "only on some paths" in row["explanation"]


@pytest.mark.parametrize("body, tier, usage", [
    ("  const p = { amount }\n  p.currency = c\n", T2, SENDS),
    ("  const p = { amount }\n  if (c) p.currency = c\n", T2, MAY_SEND),
    ("  const p = { amount }\n  if (c) { p['currency'] = c }\n", T2, MAY_SEND),
    ("  const p = { amount }\n  c && (p.currency = c)\n", T2, MAY_SEND),
    ("  const p = { amount }\n  if (c) { p.memo = c }\n", T2, OMITS),
    ("  const p = { amount, ...(c ? { currency: c } : {}) }\n", UNRESOLVED, UNKNOWN),
])
def test_javascript_conditional_request_fields(body, tier, usage):
    source = JS + "export async function f(amount, c) {\n" + body + "  await axios.post(`${BILLING_URL}/invoices`, p)\n}\n"
    row = impact("currency", source)
    assert (row["evidence_tier"], row["usage"]) == (tier, usage), row["explanation"]


def test_a_possibly_sent_field_is_listed_as_a_finding_not_as_reassurance():
    entry, found = rows({"a.py": PY + 'def f(c):\n    p = {"amount": 1}\n    if c:\n        p["currency"] = c\n' + POST})
    row = found[("POST", "/invoices", "currency")]
    assert row["usage"] == MAY_SEND and "already sends" not in row["explanation"]
    (finding,) = [f for f in entry["findings"] if f["field"] == "currency"]
    assert finding["usage"] == MAY_SEND and "only on some code paths" in finding["impact"]


# ---- 6. A URL built at runtime stays unresolved -------------------------------------------------

@pytest.mark.parametrize("name, source", [
    ("a.py", PY + 'def f(path):\n    return requests.get(f"{BILLING_URL}{path}").json()["customer"]["legacy_id"]\n'),
    ("a.py", PY + 'def f(path):\n    return requests.get(BILLING_URL + path).json()["customer"]["legacy_id"]\n'),
    ("a.py", PY + 'from urllib.parse import urljoin\n\ndef f(cid):\n    return requests.get(urljoin(BILLING_URL, "customers/" + cid)).json()["customer"]["legacy_id"]\n'),
    ("a.py", PY + 'def f(resource, cid):\n    return requests.get(f"{BILLING_URL}/{resource}/{cid}").json()\n'),          # already detected before
    ("a.js", JS + "export const f = (path) => fetch(`${BILLING_URL}${path}`).then((r) => r.json()).then((b) => console.log(b.customer.legacy_id))\n"),
    ("a.js", JS + "const CUSTOMERS = '/customers'\nexport const f = (id) => fetch(BILLING_URL + CUSTOMERS + '/' + id).then((r) => r.json())\n"),
    ("a.js", JS + "export const f = (path) => fetch(new URL(path, BILLING_URL)).then((r) => r.json())\n"),
])
def test_runtime_built_urls_are_unresolved_not_unverified_and_not_matched(name, source):
    entry, found = rows({name: source})
    assert entry["status"] == "UNRESOLVED", entry["message"]
    assert "at runtime" in entry["message"] and entry["findings"] == []
    assert len(found) == 6 and {(r["evidence_tier"], r["usage"]) for r in found.values()} == {(UNRESOLVED, UNKNOWN)}
    assert all(r["file"] == name and r["line"] for r in found.values())
    # The naming signal is kept as a candidate, not as an established relationship.
    assert "consumer_evidence" not in entry["relationship"] and entry["relationship"]["candidate_evidence"]
    assert entry["dynamic_urls"] and set(entry["dynamic_urls"][0]) == {"repository", "file", "line", "snippet", "evidence"}


def test_the_three_outcomes_without_a_match_stay_distinct():
    nothing = consumer_entry(COMPARISON, "web", {"a.js": "export const f = () => fetch('/elsewhere')\n"})
    assert nothing["status"] == "RELATIONSHIP_UNVERIFIED" and "No reference to an endpoint" in nothing["message"] and "consumer_impact" not in nothing
    # Arithmetic on a variable that merely contains the word is not URL construction.
    arithmetic = consumer_entry(COMPARISON, "web", {"a.py": "def total(billing_total, tax):\n    return billing_total + tax\n"})
    assert arithmetic["status"] == "RELATIONSHIP_UNVERIFIED"
    shared = consumer_entry(COMPARISON, "web", {"a.js": "export const f = (id) => fetch(`${SHOP}/customers/${id}`)\n"})
    assert shared["status"] == "RELATIONSHIP_UNVERIFIED" and shared["possible_references"] and "consumer_impact" not in shared
    dynamic = consumer_entry(COMPARISON, "web", {"a.py": PY + "def f(path):\n    return requests.get(BILLING_URL + path)\n"})
    assert dynamic["status"] == "UNRESOLVED"
    # A matched call next to a runtime-built one: analyzed, and what was not matched is unresolved rather than "no usage".
    both = PY + 'def f(path):\n    return requests.get(BILLING_URL + path)\n\ndef g():\n    requests.delete(f"{BILLING_URL}/customers/1/sessions")\n'
    entry, found = rows({"a.py": both})
    assert entry["status"] == "ANALYZED" and found[SESSIONS]["usage"] == CALLS
    assert {r["evidence_tier"] for key, r in found.items() if key != SESSIONS} == {UNRESOLVED}


def test_relative_paths_without_a_leading_slash_are_seen_but_not_attributed_without_evidence():
    files = {
        "tests/pets.spec.ts": "test('x', async ({ request }) => {\n  const response = await request.get('invoices', { params: { status: 'open' } })\n  await request.delete('customers/7/sessions')\n})\n",
        "playwright.config.ts": "export default { use: { baseURL: 'https://billing.acme.example/' } }\n",
    }
    entry = consumer_entry(COMPARISON, "web", files)
    assert entry["status"] == "RELATIONSHIP_UNVERIFIED"
    assert [ref["path"] for ref in entry["possible_references"]] == ["/customers/{id}/sessions"]     # a one-segment word like 'invoices' is too weak to list
    # The provider's host is in the repository, two steps away from the call: a candidate, not a verification.
    assert entry["relationship"]["candidate_evidence"] == [{"signal": "server host billing.acme.example", "file": "playwright.config.ts", "line": 1}]
    assert "playwright.config.ts:1" in entry["message"] and "not tied to it" in entry["message"]
    # With a client that names the API, the same relative paths are attributed.
    named = {"api.ts": "const billingApi = axios.create({ baseURL: process.env.API })\nexport const revoke = (id: string) => billingApi.delete(`customers/${id}/sessions`)\n"}
    entry, found = rows(named)
    assert entry["status"] == "ANALYZED" and found[SESSIONS]["usage"] == CALLS


def test_evaluation_includes_the_reviewed_defect_patterns():
    covers = " ".join(spec["covers"] for spec in EXPECTED["consumers"].values())
    for phrase in ("imported function with the same name", "method call matched by name", "call on another object", "client default parameters",
                   "request interceptor", "session default parameters", "HTTP method is unknown", "set only on some paths", "base URL plus a runtime path"):
        assert phrase in covers, phrase


# ---- The dashboard is tested against this real output -------------------------------------------

UI_FIXTURE = ["py_reads_field", "axios_interceptor", "conditional_field", "unknown_method", "dynamic_url_concat", "js_calls_only"]


def test_frontend_fixture_is_the_current_backend_output():
    """frontend/src/api/fixtures/contract-impact-eval.json is what the engine returns for six of the
    evaluation consumers. The frontend tests render it, so labels are checked against real evidence."""
    import json
    import os
    from pathlib import Path

    from tests.test_contract_impact import evaluation

    path = Path(__file__).resolve().parents[2] / "frontend" / "src" / "api" / "fixtures" / "contract-impact-eval.json"
    produced = evaluation.run_tool(EXPECTED)
    entries = [produced[name] for name in UI_FIXTURE]
    assert [(e["status"], e["consumer_repo"] or e["consumer"]) for e in entries] == [
        ("ANALYZED", "py_reads_field"), ("ANALYZED", "axios_interceptor"), ("ANALYZED", "conditional_field"),
        ("ANALYZED", "unknown_method"), ("UNRESOLVED", "dynamic_url_concat"), ("ANALYZED", "js_calls_only")]
    if os.environ.get("UPDATE_FIXTURES"):
        path.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8")) == entries, "run UPDATE_FIXTURES=1 pytest tests/test_contract_hardening.py to refresh the frontend fixture"
