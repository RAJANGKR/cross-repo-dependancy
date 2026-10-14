"""Candidate evidence for a consumer whose relationship to the API is unverified.

Its code contains strings that match the API's paths, and nothing ties them to
the API. What those possible references do with each change is reported, per
change, as a candidate. It is never promoted to a finding, to usage, or to a
verified relationship."""
from app.services.openapi_diff_engine import consumer_entry
from tests.test_contract_impact import COMPARISON, EXPECTED, PY

POSSIBLE, NO_USAGE = "POSSIBLE_REFERENCE", "NO_USAGE_FOUND"
KEY = {name: (change["method"], change["path"], change["field"]) for name, change in EXPECTED["changes"].items()}

# Calls to paths the Billing API also defines, sent to a host the specification does not name.
SHOP = (
    "import requests\nSHOP = 'https://shop.example'\n\n"
    "def invoices():\n    return requests.get(f\"{SHOP}/invoices\")\n\n"                                         # line 5
    "def logout(cid):\n    requests.delete(f\"{SHOP}/customers/{cid}/sessions\")\n\n"                          # line 8
    "def bill(amount):\n    requests.post(f\"{SHOP}/invoices\", json={\"amount\": amount})\n\n"                # line 11
    "def customer(cid):\n    return requests.get(f\"{SHOP}/customers/{cid}\").json()[\"customer\"][\"legacy_id\"]\n"  # line 14
)


def candidates(files, **options):
    entry = consumer_entry(COMPARISON, "shop", files, **options)
    return entry, {(row["method"], row["path"], row["field"]): row for row in entry.get("candidate_impact", [])}


def test_possible_references_are_reported_per_change_with_file_line_and_what_the_call_does():
    entry, rows = candidates({"shop/api.py": SHOP})
    # The relationship stays unverified, and nothing becomes a finding or counted usage.
    assert entry["status"] == "RELATIONSHIP_UNVERIFIED" and entry["findings"] == [] and "consumer_impact" not in entry
    assert set(rows) == set(KEY.values())                                    # one row per change of the comparison
    seen = {name: (rows[key]["evidence_tier"], rows[key]["usage"], rows[key]["file"], rows[key]["line"]) for name, key in KEY.items()}
    assert seen == {
        "legacy_id": (POSSIBLE, "READS_CHANGED_FIELD", "shop/api.py", 14),
        "sessions": (POSSIBLE, "CALLS_OPERATION", "shop/api.py", 8),
        "amount_list": (POSSIBLE, "NOT_DETERMINED", "shop/api.py", 5),
        "status": (POSSIBLE, "OMITS_REQUIRED_FIELD", "shop/api.py", 5),
        "amount_created": (POSSIBLE, "FIELD_NOT_READ", "shop/api.py", 11),
        "currency": (POSSIBLE, "OMITS_REQUIRED_FIELD", "shop/api.py", 11),
    }
    for row in rows.values():
        assert row["repository"] == "shop" and row["snippet"] and row["previous_value"] and row["new_value"]
        assert "it is a possible reference, and whether it reaches this API is unverified" in row["explanation"]
        assert row["references"] and all(ref["file"] == "shop/api.py" and ref["usage"] and ref["snippet"] for ref in row["references"])
    assert "does not send request field 'currency'" in rows[KEY["currency"]]["explanation"]
    assert "6 of the 6 change(s)" in entry["message"] and "listed as candidates only" in entry["message"]


def test_a_change_with_no_matching_string_is_no_usage_found_and_not_proof_of_anything():
    entry, rows = candidates({"shop/api.py": "import requests\nSHOP = 'https://shop.example'\n\ndef logout(cid):\n    requests.delete(f\"{SHOP}/customers/{cid}/sessions\")\n"})
    assert entry["status"] == "RELATIONSHIP_UNVERIFIED"
    assert rows[KEY["sessions"]]["evidence_tier"] == POSSIBLE
    for name in ("legacy_id", "amount_list", "status", "amount_created", "currency"):
        row = rows[KEY[name]]
        assert (row["evidence_tier"], row["usage"], row["file"], row["line"], row["references"]) == (NO_USAGE, NO_USAGE, "", None, [])
        assert "This is not proof that it is unaffected" in row["explanation"]
    assert "1 of the 6 change(s)" in entry["message"]


def test_a_call_with_another_http_method_is_not_a_possible_reference_to_the_operation():
    only_post = "import requests\nSHOP = 'https://shop.example'\n\ndef bill(amount):\n    requests.post(f\"{SHOP}/invoices\", json={\"amount\": amount, \"currency\": \"EUR\"})\n"
    _, rows = candidates({"shop/api.py": only_post})
    assert {rows[KEY[name]]["evidence_tier"] for name in ("amount_list", "status")} == {NO_USAGE}        # the GET /invoices changes
    assert (rows[KEY["currency"]]["evidence_tier"], rows[KEY["currency"]]["usage"]) == (POSSIBLE, "SENDS_REQUIRED_FIELD")
    # A call that already sends the value is still only a candidate.
    assert "whether it reaches this API is unverified" in rows[KEY["currency"]]["explanation"]


def test_an_unknown_http_method_is_reported_as_unknown_not_as_a_match():
    wrapped = "SHOP = 'https://shop.example'\n\ndef invoices(http):\n    return http.send(f\"{SHOP}/invoices\")\n"
    entry, rows = candidates({"shop/api.py": wrapped})
    assert entry["status"] == "RELATIONSHIP_UNVERIFIED"
    row = rows[KEY["status"]]
    assert (row["evidence_tier"], row["usage"], row["file"], row["line"]) == (POSSIBLE, "NOT_DETERMINED", "shop/api.py", 4)
    assert "its HTTP method could not be determined" in row["explanation"] and "it is not known whether it is GET /invoices" in row["explanation"]


def test_a_provider_host_elsewhere_in_the_repository_does_not_verify_the_relationship():
    # The shape of a real consumer: the base URL lives in settings, and the call goes through an injected client.
    files = {
        "config/settings.py": "class Settings:\n    base_url: str = \"https://billing.acme.example\"\n\nsettings = Settings()\n",
        "tests/test_invoices.py": "def test_list(api_client):\n    response = api_client.get(\"/invoices\")\n    assert response.status_code == 200\n",
    }
    entry, rows = candidates(files)
    assert entry["status"] == "RELATIONSHIP_UNVERIFIED" and entry["findings"] == []
    # The host is a candidate signal, with its location, and ties no call to the provider.
    assert entry["relationship"]["candidate_evidence"] == [{"signal": "server host billing.acme.example", "file": "config/settings.py", "line": 2}]
    assert "consumer_evidence" not in entry["relationship"]
    row = rows[KEY["status"]]
    assert (row["evidence_tier"], row["usage"], row["file"], row["line"]) == (POSSIBLE, "NOT_DETERMINED", "tests/test_invoices.py", 2)
    assert "a client whose defaults are not visible here" in row["explanation"]              # what remains unknown is said, not guessed


def test_entries_without_possible_references_carry_no_candidate_rows():
    nothing, rows = candidates({"a.py": "import requests\n\ndef f():\n    return requests.get('https://shop.example/elsewhere')\n"})
    assert nothing["status"] == "RELATIONSHIP_UNVERIFIED" and rows == {} and "possible_references" not in nothing
    not_scanned = consumer_entry(COMPARISON, "shop", None, "the code scan is turned off")
    assert not_scanned["status"] == "RELATIONSHIP_UNVERIFIED" and "candidate_impact" not in not_scanned


def test_a_verified_or_declared_relationship_is_analyzed_as_before_without_candidate_rows():
    verified = PY + 'def f():\n    requests.delete(f"{BILLING_URL}/customers/1/sessions")\n'
    entry, rows = candidates({"client.py": verified})
    assert entry["status"] == "ANALYZED" and rows == {} and entry["consumer_impact"]
    # The rollout planner declares the relationship: the same unverified code is then analyzed, not listed as candidates.
    declared, rows = candidates({"shop/api.py": SHOP}, declared=True)
    assert declared["status"] == "ANALYZED" and rows == {} and "candidate_impact" not in declared
    by = {(row["method"], row["path"], row["field"]): row for row in declared["consumer_impact"]}
    assert (by[KEY["currency"]]["evidence_tier"], by[KEY["currency"]]["usage"]) == ("T2_FIELD_MATCH", "OMITS_REQUIRED_FIELD")
