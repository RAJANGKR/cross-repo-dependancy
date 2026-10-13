"""CI gate tests. GitHub, the registries and OSV are faked; nothing touches the network."""
import asyncio
import importlib.util
from pathlib import Path

import pytest
import yaml

from app.core.config import settings
from app.services import ci_gate, scan_runner
from tests.fakes import fake_http

ROOT = Path(__file__).resolve().parents[2]
GH = "https://github.com/acme/"

_spec = importlib.util.spec_from_file_location("driftlock_ci", ROOT / "backend" / "scripts" / "driftlock_ci.py")
driftlock_ci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(driftlock_ci)


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr(scan_runner, "shared_cache", lambda: None)
    monkeypatch.setattr(settings, "GITHUB_TOKEN", "")
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "")


def row(name, disparity="MAJOR_DRIFT", risk="CONFIRMED_BREAKING", excerpt="BREAKING: x | y"):
    return {
        "id": f"npm:{name}",
        "dependency_name": name,
        "drift_disparity": disparity,
        "compatibility_risk": risk,
        "declarations_by_repo": {
            "a": {"declared_range": "^1.0.0", "resolved_version": "1.0.0"},
            "b": {"declared_range": "^2.0.0", "resolved_version": None},
        },
        "evidence": {"cited_excerpt": excerpt} if excerpt else None,
    }


def result(*rows):
    return {"drift_matrix": list(rows), "summary": {"total_unique_dependencies": len(rows), "severity_counts": {"MAJOR_DRIFT": len(rows)}}, "warnings": []}


def test_only_drift_the_change_introduces_fails_the_check():
    base = result(row("old"))
    head = result(row("old"), row("new"))
    verdict = ci_gate.compare(base, head)
    assert verdict.failed
    assert [r["dependency_name"] for r in verdict.introduced] == ["new"]
    assert [r["dependency_name"] for r in verdict.existing] == ["old"]

    unchanged = ci_gate.compare(base, base)
    assert not unchanged.failed and unchanged.introduced == [] and len(unchanged.existing) == 1
    assert ci_gate.compare(base, base, fail_on_existing=True).failed


def test_a_drift_that_gets_worse_counts_as_introduced_and_a_fixed_one_as_resolved():
    base = result(row("lib", risk="SUSPECTED_BREAKING"), row("gone"))
    head = result(row("lib", risk="CONFIRMED_BREAKING"))
    verdict = ci_gate.compare(base, head)
    assert verdict.failed and [r["dependency_name"] for r in verdict.introduced] == ["lib"]
    assert verdict.resolved == ["npm:gone"]


def test_fail_on_levels():
    head = result(
        row("confirmed"),
        row("suspected", risk="SUSPECTED_BREAKING"),
        row("unknown", risk="UNKNOWN_IMPACT"),
        row("minor", disparity="MINOR_DRIFT", risk="NONE"),
        row("in-sync-but-flagged", disparity="IN_SYNC"),  # not drifted, so never blocking
    )
    names = lambda level: sorted(r["dependency_name"] for r in ci_gate.compare(result(), head, level).introduced)
    assert names("confirmed") == ["confirmed"]
    assert names("suspected") == ["confirmed", "suspected"]
    assert names("major") == ["confirmed", "suspected", "unknown"]
    assert not ci_gate.compare(result(), result(row("minor", disparity="MINOR_DRIFT", risk="NONE")), "major").failed


def test_without_a_base_scan_every_blocking_drift_is_introduced():
    verdict = ci_gate.compare(None, result(row("x")))
    assert verdict.failed and not verdict.compared and len(verdict.introduced) == 1
    assert "No base branch was scanned" in ci_gate.render_markdown(verdict, result(row("x")))


def test_summary_names_the_package_versions_and_evidence_without_breaking_the_table():
    head = result(row("new"), row("old"))
    text = ci_gate.render_markdown(ci_gate.compare(result(row("old")), head), head)
    assert text.startswith("## DriftLock check: failed")
    assert "introduces 1 confirmed-breaking drift" in text
    assert "| `new` | Major drift | Confirmed breaking | a: 1.0.0, b: ^2.0.0 | BREAKING: x \\| y |" in text
    assert "### Already present (1)" in text and "do not fail this check" in text
    assert "not proof of safety" in text
    passed = ci_gate.render_markdown(ci_gate.compare(head, head), head)
    assert passed.startswith("## DriftLock check: passed") and "introduces no confirmed-breaking drift" in passed
    quiet = ci_gate.render_markdown(ci_gate.compare(result(), result(row("q", excerpt=None))), result(row("q", excerpt=None)))
    assert "No release-note line quoted" in quiet


def run_cli(*argv, tmp_path=None):
    args = driftlock_ci.parse_args(list(argv) + (["--summary-file", str(tmp_path / "summary.md")] if tmp_path else []))
    return asyncio.run(driftlock_ci.run(args, http=fake_http()))


def test_cli_passes_when_the_pull_request_adds_no_new_drift(tmp_path, capsys):
    code = run_cli("--head", GH + "service-a", "--base", GH + "service-a", "--against", GH + "service-b", "--against", GH + "service-c", tmp_path=tmp_path)
    assert code == 0
    summary = (tmp_path / "summary.md").read_text(encoding="utf-8")
    assert summary.startswith("## DriftLock check: passed")
    assert "### Already present (1)" in summary and "`pydantic`" in summary  # real, pre-existing confirmed break
    assert "DriftLock check: passed" in capsys.readouterr().out


def test_cli_fails_for_existing_drift_only_when_asked(tmp_path):
    common = ("--head", GH + "service-a", "--base", GH + "service-a", "--against", GH + "service-b")
    assert run_cli(*common) == 0
    assert run_cli(*common, "--fail-on-existing", tmp_path=tmp_path) == 1
    assert "because --fail-on-existing is set" in (tmp_path / "summary.md").read_text(encoding="utf-8")


def test_cli_without_a_base_reports_everything_as_introduced():
    assert run_cli("--head", GH + "service-a", "--against", GH + "service-b") == 1
    assert run_cli("--head", GH + "service-a", "--against", GH + "service-b", "--fail-on", "major", "--no-code-scan") == 1


def test_cli_reports_a_scan_that_cannot_run_as_an_error_not_a_pass(capsys):
    assert run_cli("--head", GH + "nope-1", "--against", GH + "nope-2") == 2
    assert "could not be scanned" in capsys.readouterr().err
    assert run_cli("--head", "https://gitlab.com/a/b", "--against", GH + "service-b") == 2
    assert run_cli("--head", GH + "service-a") == 2  # nothing to compare with


def test_cli_treats_an_unscannable_base_strictly(capsys):
    code = run_cli("--head", GH + "service-a", "--base", GH + "service-a/tree/no-such-branch", "--against", GH + "service-b")
    # service-b alone still completes the base scan, so pydantic is not "already present" there.
    assert code == 1
    assert "`pydantic`" in capsys.readouterr().out


def test_action_and_example_workflow_are_valid_and_do_not_interpolate_event_data_into_the_script():
    action = yaml.safe_load((ROOT / "action.yml").read_text(encoding="utf-8"))
    assert action["runs"]["using"] == "composite" and action["inputs"]["against"]["required"] is True
    step = action["runs"]["steps"][-1]
    assert "driftlock_ci.py" in step["run"]
    # Branch names and inputs reach the script only through env, which prevents command injection.
    assert "github.event" not in step["run"] and "inputs." not in step["run"]
    assert step["env"]["DRIFTLOCK_HEAD_REF"].startswith("${{ github.event.pull_request.head.ref")

    example = yaml.safe_load((ROOT / "docs" / "ci-example.yml").read_text(encoding="utf-8"))
    job = example["jobs"]["drift"]
    assert example["permissions"] == {"contents": "read"}
    assert job["steps"][0]["uses"].startswith("RAJANGKR/cross-repo-dependancy@")
