"""Evaluates consumer-aware contract impact analysis on the controlled fixtures
in tests/fixtures/contract_eval. Offline: no network, no API keys.

    python scripts/evaluate_contract_impact.py [--json] [--strict]

WHAT IS MEASURED: changed-element usage detection. Every (consumer, contract
change) pair is one case. The ground truth (`uses_changed_element` in
expected.json) says whether the consumer's own code uses the element that
changed: it reads the changed response field, calls the removed operation, or
makes a request that lacks the newly required value on some path.

WHAT IS NOT MEASURED: breakage. A consumer that reads a changed field and
handles both types counts as "uses". These numbers are therefore not
breaking-impact or compatibility precision, and they say nothing about runtime
behaviour. A breakage metric would need its own, independently established
ground truth; none exists here.

The tool counts as detecting usage only when it asserts it:

  * T2_FIELD_MATCH with READS_CHANGED_FIELD or OMITS_REQUIRED_FIELD, or
  * T1_OPERATION_MATCH on a removed operation (CALLS_OPERATION).

UNRESOLVED, MAY_SEND_REQUIRED_FIELD, NO_USAGE_FOUND, RELATIONSHIP_UNVERIFIED
and a plain operation match on a field change assert nothing. A real usage
reported that way is a false negative, so honest uncertainty lowers recall
instead of hiding.

Research targets: usage-detection precision >= 0.90, recall >= 0.80. They are
reported, not enforced: the exit code is 1 only when a case differs from its
reviewed expected result (a regression). Pass --strict to also fail when a
target is missed.
"""
import json
import sys
from pathlib import Path
from typing import Dict, List

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services.openapi_diff_engine import RepoInput, analyze_specs, consumer_entry  # noqa: E402

FIXTURES = BACKEND / "tests" / "fixtures" / "contract_eval"
PRECISION_TARGET, RECALL_TARGET = 0.90, 0.80
ASSERTS_USAGE = {("T2_FIELD_MATCH", "READS_CHANGED_FIELD"), ("T2_FIELD_MATCH", "OMITS_REQUIRED_FIELD"), ("T1_OPERATION_MATCH", "CALLS_OPERATION")}


def load_expected() -> dict:
    return json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))


def consumer_files(name: str) -> Dict[str, str]:
    root = FIXTURES / "consumers" / name
    # as_posix(): repository paths use "/" on every platform. str() would give
    # "src\\file.js" on Windows and no longer match the reviewed expected results.
    return {path.relative_to(root).as_posix(): path.read_text(encoding="utf-8") for path in sorted(root.rglob("*")) if path.is_file()}


def run_tool(expected: dict) -> Dict[str, dict]:
    """{consumer: contract-analysis entry} produced by the real engine."""
    provider = expected["provider"]
    _, comparisons = analyze_specs([
        RepoInput("billing-v1", {"openapi.yaml": (FIXTURES / provider["baseline"]).read_text(encoding="utf-8")}),
        RepoInput("billing-v2", {"openapi.yaml": (FIXTURES / provider["candidate"]).read_text(encoding="utf-8")}),
    ])
    (comparison,) = comparisons
    return {name: consumer_entry(comparison, name, consumer_files(name)) for name in sorted(expected["consumers"])}


def actual_row(entry: dict, change: dict) -> dict:
    if "consumer_impact" not in entry:  # no per-change evidence: the entry status is the answer for every change
        return {"tier": entry["status"], "usage": entry["status"], "file": "", "line": None, "explanation": entry["message"]}
    for row in entry["consumer_impact"]:
        if (row["change_type"], row["method"], row["path"], row["field"]) == (change["change_type"], change["method"], change["path"], change["field"]):
            return {"tier": row["evidence_tier"], "usage": row["usage"], "file": row["file"], "line": row["line"], "explanation": row["explanation"]}
    raise KeyError(f"the tool did not report {change}")


def evaluate() -> dict:
    expected = load_expected()
    entries = run_tool(expected)
    cases: List[dict] = []
    for consumer, spec in expected["consumers"].items():
        for change_id, change in expected["changes"].items():
            want = spec["changes"].get(change_id) or spec.get("default") or expected["default"]
            got = actual_row(entries[consumer], change)
            predicted = (got["tier"], got["usage"]) in ASSERTS_USAGE
            located = "file" not in want or (got["file"], got["line"]) == (want["file"], want["line"])
            cases.append({
                "consumer": consumer, "change": change_id,
                "expected_tier": want["tier"], "expected_usage": want["usage"], "uses_changed_element": want["uses_changed_element"],
                "actual_tier": got["tier"], "actual_usage": got["usage"], "usage_asserted": predicted,
                "actual_location": f"{got['file']}:{got['line']}" if got["file"] else "",
                "matches_expected": (got["tier"], got["usage"]) == (want["tier"], want["usage"]) and located,
                "outcome": {(True, True): "TP", (True, False): "FP", (False, True): "FN", (False, False): "TN"}[(predicted, want["uses_changed_element"])],
                "explanation": got["explanation"],
            })
    counts = {key: sum(1 for case in cases if case["outcome"] == key) for key in ("TP", "FP", "FN", "TN")}
    precision = counts["TP"] / (counts["TP"] + counts["FP"]) if counts["TP"] + counts["FP"] else None
    recall = counts["TP"] / (counts["TP"] + counts["FN"]) if counts["TP"] + counts["FN"] else None
    return {
        "task": expected.get("task", "changed-element usage detection"),
        "cases": cases, "counts": counts, "usage_detection_precision": precision, "usage_detection_recall": recall,
        "consumers": len(expected["consumers"]), "changes": len(expected["changes"]),
        "matching_expected": sum(1 for case in cases if case["matches_expected"]),
        "tiers": {tier: sum(1 for case in cases if case["actual_tier"] == tier) for tier in sorted({case["actual_tier"] for case in cases})},
        "targets": {"usage_detection_precision": PRECISION_TARGET, "usage_detection_recall": RECALL_TARGET},
        "meets_precision_target": precision is not None and precision >= PRECISION_TARGET,
        "meets_recall_target": recall is not None and recall >= RECALL_TARGET,
    }


def main() -> int:
    result = evaluate()
    regressions = len(result["cases"]) - result["matching_expected"]
    if "--json" in sys.argv:
        print(json.dumps(result, indent=2))
    else:
        counts = result["counts"]
        print(f"Changed-element usage detection: {result['consumers']} consumers x {result['changes']} changes = {len(result['cases'])} cases\n")
        for case in result["cases"]:
            if case["outcome"] != "TN" or not case["matches_expected"]:
                flag = "" if case["matches_expected"] else "  << differs from expected"
                print(f"  {case['outcome']}  {case['consumer']:24} {case['change']:15} {case['actual_tier']:22} {case['actual_usage']:24} {case['actual_location']}{flag}")
        print(f"\n  usage asserted and real {counts['TP']}, asserted but not real {counts['FP']}, real but not asserted {counts['FN']}, neither {counts['TN']}")
        print(f"  tiers reported: {result['tiers']}")
        print(f"  cases matching the reviewed expected result: {result['matching_expected']} of {len(result['cases'])}")
        show = lambda value: "n/a" if value is None else f"{value:.3f}"
        print(f"  usage-detection precision {show(result['usage_detection_precision'])} (target {PRECISION_TARGET:.2f}): {'met' if result['meets_precision_target'] else 'NOT MET'}")
        print(f"  usage-detection recall    {show(result['usage_detection_recall'])} (target {RECALL_TARGET:.2f}): {'met' if result['meets_recall_target'] else 'NOT MET'}")
        print("\n  This measures whether usage of a changed element is detected in source code. It is not a")
        print("  measure of breakage: a consumer that uses a changed field and tolerates the change counts as usage.")
        print("  The fixtures are small and hand-written; the numbers describe them, not arbitrary repositories.")
    missed = not (result["meets_precision_target"] and result["meets_recall_target"])
    return 1 if regressions or ("--strict" in sys.argv and missed) else 0


if __name__ == "__main__":
    sys.exit(main())
