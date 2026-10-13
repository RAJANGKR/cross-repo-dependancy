"""OPTIONAL LIVE SMOKE SCRIPT. Not part of the test suite.

Runs one real scan against the live GitHub, registry and OSV APIs and prints a
summary. It needs network access and uses GitHub API quota (60 requests per
hour without GITHUB_TOKEN).

    python scripts/live_smoke.py URL URL [URL ...] [--save demo/demo_scan.json]
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas.scan import ScanCreateRequest  # noqa: E402
from app.services import scan_runner  # noqa: E402
from app.services.scan_store import ScanStore  # noqa: E402


def main() -> int:
    args = sys.argv[1:]
    save = None
    if "--save" in args:
        index = args.index("--save")
        save, args = args[index + 1], args[:index] + args[index + 2:]
    if len(args) < 2:
        print(__doc__)
        return 2
    request = ScanCreateRequest(repository_targets=[{"type": "github", "url": url} for url in args])
    store = ScanStore()
    record = store.create()
    asyncio.run(scan_runner.run_scan(record.scan_id, scan_runner.validate_request(request), request.options, store))
    record = store.get(record.scan_id)
    print(f"status={record.status} duration={record.duration_seconds}s error={record.error}")
    if record.result:
        result = record.result
        print("summary:", json.dumps(result["summary"]))
        print("sources:", {s["name"]: s["status"] for s in result["data_sources"]})
        for row in result["drift_matrix"]:
            if row["drift_disparity"] in ("MAJOR_DRIFT", "MINOR_DRIFT"):
                versions = {repo.split("/")[-1]: d["resolved_version"] or d["declared_range"] for repo, d in row["declarations_by_repo"].items()}
                print(f"  {row['drift_disparity']:<12} {row['compatibility_risk']:<19} score={row.get('score')} conf={row.get('confidence')} {row['id']} {versions}")
        print(f"code_impact: {len(result['code_impact'] or [])} items; warnings: {len(result['warnings'])}; skipped: {len(result['skipped_items'])}")
        for warning in result["warnings"]:
            print("  !", warning)
    if save and record.status == "COMPLETED":
        Path(save).write_text(json.dumps(record.model_dump(), indent=1), encoding="utf-8")
        print("saved", save)
    return 0 if record.status == "COMPLETED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
