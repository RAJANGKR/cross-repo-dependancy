"""The CI gate: decides whether a change should be blocked for the drift it
introduces. It runs the normal scan (same deterministic classifier, no extra
rules) once for the pull request's branch and once for its base branch, and
compares the two results.

A drift that already existed on the base branch does not fail the check by
default: the gate is about what THIS change adds or makes worse.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from app.schemas.scan import ScanCreateRequest, ScanRecord
from app.services import scan_runner
from app.services.http import Http
from app.services.scan_store import ScanStore

#: Which classifications each --fail-on level blocks.
FAIL_ON = {
    "confirmed": lambda row: row["compatibility_risk"] == "CONFIRMED_BREAKING",
    "suspected": lambda row: row["compatibility_risk"] in ("CONFIRMED_BREAKING", "SUSPECTED_BREAKING"),
    "major": lambda row: row["drift_disparity"] == "MAJOR_DRIFT",
}
FAIL_ON_TEXT = {
    "confirmed": "confirmed-breaking drift",
    "suspected": "confirmed or suspected breaking drift",
    "major": "major version drift",
}
_DRIFTED = ("MAJOR_DRIFT", "MINOR_DRIFT")
_LABELS = {
    "MAJOR_DRIFT": "Major drift",
    "MINOR_DRIFT": "Minor drift",
    "CONFIRMED_BREAKING": "Confirmed breaking",
    "SUSPECTED_BREAKING": "Suspected breaking",
    "UNKNOWN_IMPACT": "Unknown impact",
    "NONE": "No issue identified",
}


@dataclass
class Verdict:
    failed: bool
    fail_on: str
    #: Blocking drifts this change adds or makes worse.
    introduced: List[dict] = field(default_factory=list)
    #: Blocking drifts that were already there on the base branch.
    existing: List[dict] = field(default_factory=list)
    #: Blocking drifts on the base branch that this change removes.
    resolved: List[str] = field(default_factory=list)
    #: False when there was no base scan to compare with.
    compared: bool = True


def blocking(result: Optional[dict], fail_on: str) -> Dict[str, dict]:
    """Drifted rows of a scan result that the chosen level blocks, by id."""
    if not result:
        return {}
    matches = FAIL_ON[fail_on]
    return {row["id"]: row for row in result.get("drift_matrix", []) if row["drift_disparity"] in _DRIFTED and matches(row)}


def compare(base_result: Optional[dict], head_result: dict, fail_on: str = "confirmed", fail_on_existing: bool = False) -> Verdict:
    """Decide the gate from the base and head scan results.

    Without a base result every blocking drift counts as introduced, because
    nothing shows it was there before."""
    head = blocking(head_result, fail_on)
    base = blocking(base_result, fail_on)
    introduced = [row for drift_id, row in head.items() if drift_id not in base]
    existing = [row for drift_id, row in head.items() if drift_id in base]
    return Verdict(
        failed=bool(introduced) or (fail_on_existing and bool(existing)),
        fail_on=fail_on,
        introduced=introduced,
        existing=existing,
        resolved=sorted(drift_id for drift_id in base if drift_id not in head),
        compared=base_result is not None,
    )


def _cell(text: object) -> str:
    """One line of plain text that cannot break a Markdown table."""
    return " ".join(str(text).split()).replace("|", "\\|")


def _table(rows: List[dict]) -> List[str]:
    lines = ["| Package | Drift | Risk | Versions | Evidence |", "| --- | --- | --- | --- | --- |"]
    for row in rows:
        versions = ", ".join(
            f"{repo}: {decl['resolved_version'] or decl['declared_range']}" for repo, decl in row["declarations_by_repo"].items()
        )
        evidence = (row.get("evidence") or {}).get("cited_excerpt") or "No release-note line quoted"
        lines.append(
            f"| `{_cell(row['dependency_name'])}` | {_LABELS.get(row['drift_disparity'], row['drift_disparity'])} "
            f"| {_LABELS.get(row['compatibility_risk'], row['compatibility_risk'])} | {_cell(versions)} | {_cell(evidence)[:200]} |"
        )
    return lines


def render_markdown(verdict: Verdict, head_result: dict) -> str:
    """The job summary shown on the pull request's checks page."""
    what = FAIL_ON_TEXT[verdict.fail_on]
    lines = ["## DriftLock check: " + ("failed" if verdict.failed else "passed"), ""]
    if verdict.introduced:
        lines += [f"This change introduces {len(verdict.introduced)} {what} against the other repositories.", "", *_table(verdict.introduced), ""]
    elif verdict.compared:
        lines += [f"This change introduces no {what}.", ""]
    if not verdict.compared:
        lines += ["No base branch was scanned, so every blocking drift is reported as introduced.", ""]
    if verdict.existing:
        note = "They fail this check because --fail-on-existing is set." if verdict.failed and not verdict.introduced else "They were already present on the base branch, so they do not fail this check."
        lines += [f"### Already present ({len(verdict.existing)})", "", note, "", *_table(verdict.existing), ""]
    if verdict.resolved:
        lines += [f"### Resolved by this change ({len(verdict.resolved)})", "", *[f"- `{_cell(drift_id)}`" for drift_id in verdict.resolved], ""]

    summary = head_result.get("summary") or {}
    counts = summary.get("severity_counts") or {}
    lines += [
        "### Scan of the pull request branch",
        "",
        f"- Packages compared: {summary.get('total_unique_dependencies', 'not reported')}",
        f"- Major drift: {counts.get('MAJOR_DRIFT', 0)}, minor drift: {counts.get('MINOR_DRIFT', 0)}, in sync: {counts.get('IN_SYNC', 0)}",
    ]
    for warning in head_result.get("warnings", [])[:8]:
        lines.append(f"- Warning: {_cell(warning)}")
    lines += ["", "Risk is a signal, not a guarantee. Missing evidence is not proof of safety.", ""]
    return "\n".join(lines)


async def scan(urls: List[str], scan_code: bool = True, http: Optional[Http] = None) -> ScanRecord:
    """Run one scan in-process (no server needed) and return its record."""
    request = ScanCreateRequest(
        repository_targets=[{"type": "github", "url": url} for url in urls],
        options={"scan_code": scan_code},
    )
    store = ScanStore()
    record = store.create()
    await scan_runner.run_scan(record.scan_id, scan_runner.validate_request(request), request.options, store, http)
    return store.get(record.scan_id)
