"""Unit tests for parsing, ranges, classification, scoring, changelog and the usage scanner."""
import asyncio
import json

import httpx
import pytest

from app.core.security import InvalidTarget, manifest_kind, parse_github_url
from app.parsers.lockfiles import parse_package_lock, parse_poetry_lock
from app.parsers.registry import default_registry
from app.services import changelog_service, graph_service, usage_scanner
from app.services import range_service as ranges
from app.services.classifier import Declaration, classify
from app.services.http import FetchError
from app.services.scoring import level_for, score_drift
from tests.fakes import USER_PY, fake_http, zip_of


# ---- URL validation ---------------------------------------------------------

def test_github_urls_are_parsed_and_cleaned():
    assert parse_github_url("https://github.com/pallets/flask") == ("pallets", "flask", None)
    assert parse_github_url(" https://github.com/pallets/flask.git/ ") == ("pallets", "flask", None)
    assert parse_github_url("https://github.com/a/b/tree/feature/x/y") == ("a", "b", "feature/x/y")


@pytest.mark.parametrize("url", [
    "", "http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/blob/main/x.py",
    "https://github.com/a/b/issues", "https://github.com/a/b/tree", "https://github.com/a/b?tab=readme", "https://github.com/a b/c",
    "https://github.com/../b",
])
def test_other_urls_are_rejected(url):
    with pytest.raises(InvalidTarget):
        parse_github_url(url)


def test_manifest_kinds():
    assert manifest_kind("web/package.json") == "package.json"
    assert manifest_kind("requirements-dev.txt") == "requirements.txt"
    assert manifest_kind("pom.xml") == "pom.xml"
    assert manifest_kind("setup.py") is None


# ---- Parsers ----------------------------------------------------------------

def test_requirements_comments_extras_markers_and_includes():
    text = "# c\nrequests[socks]>=2.25 ; python_version > '3.8'  # note\n-r base.txt\nflask==3.0.0\n"
    items = {i.name: i.version_spec for i in default_registry.parse_file("requirements.txt", text)}
    assert items == {"requests": ">=2.25", "flask": "==3.0.0"}


def test_package_lock_v3_and_v1_top_level_pins_only():
    v3 = json.dumps({"packages": {"": {}, "node_modules/axios": {"version": "1.6.2"}, "node_modules/@s/p": {"version": "2.0.0"},
                                  "node_modules/axios/node_modules/x": {"version": "9.0.0"}}})
    assert parse_package_lock(v3) == {"axios": "1.6.2", "@s/p": "2.0.0"}
    assert parse_package_lock(json.dumps({"dependencies": {"lodash": {"version": "4.17.21"}}})) == {"lodash": "4.17.21"}
    assert parse_package_lock("not json") == {}


def test_poetry_lock():
    assert parse_poetry_lock('[[package]]\nname = "Pydantic"\nversion = "2.5.0"\n') == {"pydantic": "2.5.0"}


def test_pom_properties_and_dependency_management():
    pom = """<project xmlns="http://maven.apache.org/POM/4.0.0"><version>1.0</version>
      <properties><jackson.version>2.15.2</jackson.version></properties>
      <dependencyManagement><dependencies><dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.12</version></dependency></dependencies></dependencyManagement>
      <dependencies>
        <dependency><groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version></dependency>
        <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>
        <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>${missing}</version><scope>test</scope></dependency>
      </dependencies></project>"""
    items = {i.name: (i.version_spec, i.dep_type.value) for i in default_registry.parse_file("pom.xml", pom)}
    assert items["com.fasterxml.jackson.core:jackson-databind"] == ("2.15.2", "runtime")
    assert items["org.slf4j:slf4j-api"] == ("2.0.12", "runtime")
    assert items["junit:junit"] == ("${missing}", "dev")
    assert ranges.unsupported_reason("maven", "${missing}") == "unresolved ${property}"
    assert default_registry.parse_file("pom.xml", "<!DOCTYPE x [<!ENTITY a 'b'>]><project/>") == []


# ---- Ranges -----------------------------------------------------------------

AXIOS = ["0.21.4", "0.27.2", "1.2.0", "1.5.3", "1.6.2", "2.0.0-beta.1"]


def test_npm_ranges():
    assert ranges.ranges_overlap("npm", "^1.2.0", "~1.5.0", AXIOS) is True
    assert ranges.ranges_overlap("npm", "^0.21.0", "^1.6.0", AXIOS) is False
    assert ranges.resolve("npm", "^1.2.0", AXIOS) == "1.6.2"
    assert ranges.resolve("npm", ">=1.6.0", AXIOS) == "1.6.2"  # the prerelease is not preferred
    assert ranges.resolve("npm", "^0.21.0 || ^1.6.0", AXIOS) == "1.6.2"
    assert ranges.resolve("npm", "^9.0.0", AXIOS) is None


def test_unknown_is_none_not_a_guess():
    assert ranges.ranges_overlap("npm", "^1.0.0", "^1.2.0", []) is None
    assert ranges.ranges_overlap("npm", "^1.0.0", "git+https://x/y.git", AXIOS) is None
    assert ranges.satisfies("npm", "not a range!!", "1.0.0") is None
    assert ranges.gap("npm", "abc", "1.0.0") == "unknown"


def test_python_and_poetry_ranges():
    versions = ["1.10.13", "2.0.0", "2.5.0", "2.6.0a1"]
    assert ranges.resolve("python", ">=2.5,<3", versions) == "2.5.0"
    assert ranges.ranges_overlap("python", "==1.10.13", ">=2", versions) is False
    assert ranges.resolve("python", "^1.2", versions) == "1.10.13"
    assert ranges.satisfies("python", "~1.10.0", "1.10.13") is True
    assert ranges.exact_pin("python", "==2.5.0") == "2.5.0"
    assert ranges.exact_pin("python", ">=2.5.0") is None


def test_maven_ranges():
    assert ranges.satisfies("maven", "[1.0,2.0)", "1.5") is True
    assert ranges.satisfies("maven", "[1.0,2.0)", "2.0") is False
    assert ranges.exact_pin("maven", "2.15.2") == "2.15.2"
    assert ranges.gap("maven", "2.9.10", "2.15.2") == "minor"


def test_gap_and_the_zero_major_rule():
    assert ranges.gap("npm", "1.2.3", "2.0.0") == "major"
    assert ranges.gap("npm", "0.21.0", "0.27.2") == "major"
    assert ranges.gap("npm", "0.27.2", "1.6.2") == "major"
    assert ranges.gap("npm", "1.2.3", "1.4.0") == "minor"
    assert ranges.gap("npm", "4.17.20", "4.17.21") == "patch"
    assert ranges.gap("python", "2.5.0", "2.5.0") == "none"


def test_unsupported_specs():
    for spec in ("git+https://github.com/a/b.git", "workspace:*", "file:../x", "*", "latest", "user/repo", "next"):
        assert ranges.unsupported_reason("npm", spec), spec
    assert ranges.unsupported_reason("npm", "^1.2.3") is None
    assert ranges.unsupported_reason("python", ">=1.0") is None


# ---- Classifier decision table ----------------------------------------------

def decl(repo, declared, resolved=None):
    return Declaration(repo, declared, resolved, "runtime", "manifest")


def test_classifier_decision_table():
    c = classify("npm", [decl("a", "^0.27.2", "0.27.2"), decl("b", "^1.6.2")], 2, AXIOS)
    assert (c.drift_disparity, c.compatibility_risk, c.gap, c.overlap) == ("MAJOR_DRIFT", "SUSPECTED_BREAKING", "major", False)
    assert c.effective == {"a": "0.27.2", "b": "1.6.2"} and c.recommended_version == "1.6.2"

    lodash = ["4.17.20", "4.17.21"]
    c = classify("npm", [decl("a", "^4.17.20", "4.17.20"), decl("b", "^4.17.21")], 2, lodash)
    assert (c.drift_disparity, c.compatibility_risk, c.gap, c.overlap) == ("MINOR_DRIFT", "NONE", "patch", True)
    assert c.recommended_version == "4.17.21"

    c = classify("python", [decl("a", "==1.10.13"), decl("b", "==2.5.0")], 2, ["1.10.13", "2.5.0"], verified_breaking=True)
    assert c.compatibility_risk == "CONFIRMED_BREAKING"
    assert classify("python", [decl("a", "==1.10.13"), decl("b", "==2.5.0")], 2, [], tier2_hit=True).compatibility_risk == "CONFIRMED_BREAKING"

    c = classify("python", [decl("a", "==2.25.1"), decl("b", "==2.31.0")], 2, ["2.25.1", "2.31.0"])
    assert (c.drift_disparity, c.compatibility_risk) == ("MINOR_DRIFT", "UNKNOWN_IMPACT")

    assert classify("npm", [decl("a", "^1.0.0", "1.6.2"), decl("b", "^1.0.0", "1.6.2")], 2).drift_disparity == "IN_SYNC"
    # Agreeing in every repository that uses it is in sync, even if a third repository does not use it.
    assert classify("npm", [decl("a", "^1.0.0"), decl("b", "^1.0.0")], 3).drift_disparity == "IN_SYNC"
    assert classify("npm", [decl("a", "^1.0.0")], 3).drift_disparity == "INFO"

    # Different ranges that resolve to the same version are a (harmless) drift.
    c = classify("npm", [decl("a", "^1.2.0"), decl("b", "^1.5.0")], 2, AXIOS)
    assert (c.drift_disparity, c.compatibility_risk) == ("MINOR_DRIFT", "NONE")

    # No lockfile and no registry: the difference cannot be resolved, so nothing is claimed.
    c = classify("npm", [decl("a", "^1.2.0"), decl("b", "^2.0.0")], 2, [])
    assert (c.drift_disparity, c.compatibility_risk, c.recommended_version) == ("INFO", "UNKNOWN_IMPACT", None)
    assert {"registry", "lockfile", "resolved_version"} <= set(c.signals_missing)


def test_a_verified_break_is_not_claimed_without_drift():
    c = classify("npm", [decl("a", "^1.0.0", "1.6.2"), decl("b", "^1.0.0", "1.6.2")], 2, AXIOS, verified_breaking=True, tier2_hit=True)
    assert (c.drift_disparity, c.compatibility_risk) == ("IN_SYNC", "NONE")


# ---- Scoring ----------------------------------------------------------------

def test_scoring_points_levels_and_clamp():
    s = score_drift(gap="major", overlap=False, breaking_marker=True, vulnerable=True, repo_count=3, tier2_hits=2)
    assert s.score == 100 and s.level == "Critical" and sum(i["points"] for i in s.breakdown) == 120
    s = score_drift(gap="patch", overlap=True, breaking_marker=False, vulnerable=True, repo_count=2)
    assert s.score == 0 and s.level == "Low"
    assert {i["signal"]: i["points"] for i in s.breakdown} == {"Patch version gap": 5, "Known vulnerability": 20, "Ranges overlap": -30}
    assert [level_for(n) for n in (0, 24, 25, 49, 50, 74, 75, 100)] == ["Low", "Low", "Medium", "Medium", "High", "High", "Critical", "Critical"]


def test_confidence_drops_with_missing_signals():
    full = score_drift(gap="major", overlap=False, breaking_marker=False, vulnerable=False, repo_count=2)
    partial = score_drift(gap="major", overlap=False, breaking_marker=False, vulnerable=False, repo_count=2,
                          signals_missing=["changelog", "code_scan", "changelog"])
    assert full.confidence == 1.0 and partial.confidence == 0.75
    assert partial.signals_missing == ["changelog", "code_scan"]
    assert score_drift(gap="major", overlap=None, breaking_marker=False, vulnerable=False, repo_count=2,
                       signals_missing=list("abcdefghijklmnopqrstuvwxyz")).confidence == 0.1


# ---- Changelog --------------------------------------------------------------

def test_verified_breaking_requires_a_literal_match_in_fetched_text():
    assert changelog_service.verify_excerpt("BREAKING:  `@validator`   is replaced", "x BREAKING: `@validator` is replaced y")
    assert not changelog_service.verify_excerpt("validator was removed", "BREAKING: `@validator` is replaced")
    assert not changelog_service.verify_excerpt("", "anything")


def test_changelog_only_reads_versions_between_the_two():
    http = fake_http()
    log = asyncio.run(changelog_service.collect(http, "pydantic", "pydantic", "python", "1.10.13", "2.5.0"))
    assert log.fetched and [line.version for line in log.lines] == ["2.0.0"]
    evidence = changelog_service.to_evidence(log)
    assert evidence["verified_breaking"] is True
    assert evidence["cited_excerpt"] == "BREAKING: `@validator` is replaced by `@field_validator`"
    assert evidence["source_url"].startswith("https://github.com/pydantic/pydantic/releases")
    assert "removed everything" not in log.text  # 2.6.0 is outside (1.10.13, 2.5.0]


def test_no_markers_means_no_evidence_and_no_verification():
    log = asyncio.run(changelog_service.collect(fake_http(), "axios", "axios", "npm", "0.27.2", "1.6.2"))
    assert log.fetched and log.lines == [] and changelog_service.to_evidence(log) is None


def test_notable_but_not_breaking_line_is_never_verified_breaking():
    log = changelog_service.Changelog(fetched=True, text="The old API is deprecated.")
    log.lines.append(changelog_service.MatchedLine("2.0.0", "The old API is deprecated.", False, None))
    assert changelog_service.to_evidence(log)["verified_breaking"] is False


# ---- Usage scanner ----------------------------------------------------------

def test_import_maps_for_python_js_and_java():
    assert usage_scanner.python_imports("import os, yaml\nfrom pydantic.fields import Field as F\n") == [
        ("os", [], 1), ("yaml", [], 1), ("pydantic.fields", ["Field"], 2)]
    js = "import axios from 'axios'\nimport {a} from \"@scope/pkg/sub\"\nconst x = require('lodash/debounce')\nconst y = await import('./local')\n"
    assert usage_scanner.js_imports(js) == [("axios", 1), ("@scope/pkg/sub", 2), ("lodash/debounce", 3), ("./local", 4)]
    assert usage_scanner.java_imports("package a;\nimport com.fasterxml.jackson.databind.ObjectMapper;\nimport static org.junit.Assert.*;\n")[0] == (
        "com.fasterxml.jackson.databind.ObjectMapper", 2)


def test_import_name_mapping_never_guesses():
    assert usage_scanner.import_names("python", "PyYAML", None) == ["yaml"]
    assert usage_scanner.import_names("python", "scikit-learn", None) == ["sklearn"]
    assert usage_scanner.import_names("python", "python-dateutil", None) == ["python_dateutil"]
    assert usage_scanner.import_names("npm", "@scope/pkg", None) == ["@scope/pkg"]
    assert usage_scanner.import_names("maven", "com.fasterxml.jackson.core:jackson-databind", None) is None


def test_zip_reader_skips_vendored_binary_and_non_source_files():
    files = usage_scanner.read_zip(zip_of({"a.py": "x = 1", "node_modules/b.js": "x", "img.png": "x", "c.py": "a\x00b"}))
    assert list(files) == ["a.py"]
    assert usage_scanner.read_zip(b"not a zip") == {}


def test_pydantic_rule_pack_reports_lines_with_the_guides_wording():
    packs = usage_scanner.load_rule_packs()
    target = usage_scanner.LibraryTarget("python:pydantic", "python", "pydantic", 1, 2, "pydantic 1.10.13 to 2.5.0")
    found = usage_scanner.scan_repository("service-a", {"models/user.py": USER_PY, "other.py": "x = dict()"}, [target], packs)
    tier1, *tier2 = found["items"]
    assert tier1["impact"].startswith("Tier 1 import map: 1 file(s)") and tier1["line"] == 1 and "not evidence" in tier1["impact"]
    hits = {(item["line"], item["related_change"].split(": ", 1)[1]) for item in tier2}
    assert hits == {
        (7, "validator is deprecated in pydantic 2; use field_validator"),
        (11, "Config is deprecated in pydantic 2; use model_config"),
        (12, "orm_mode is renamed in pydantic 2; use from_attributes"),
    }
    assert all(item["impact"].startswith("Tier 2 verified rule") and "removed" not in item["impact"] for item in tier2)
    assert all(item["limitations"] == usage_scanner.LIMITATIONS for item in found["items"])
    assert found["tier2"] == {"python:pydantic": 3}


def test_rules_do_not_fire_on_the_newer_major_or_without_a_pack():
    packs = usage_scanner.load_rule_packs()
    newer = usage_scanner.LibraryTarget("python:pydantic", "python", "pydantic", 2, 1, "pydantic 1 to 2")
    assert usage_scanner.scan_repository("b", {"m.py": USER_PY}, [newer], packs)["tier2"] == {}
    axios = usage_scanner.LibraryTarget("npm:axios", "npm", "axios", 0, 1, "axios 0.27.2 to 1.6.2")
    found = usage_scanner.scan_repository("a", {"src/http.js": "import axios from 'axios'\n"}, [axios], packs)
    assert len(found["items"]) == 1 and found["items"][0]["confidence"] == "low" and found["tier2"] == {}
    maven = usage_scanner.LibraryTarget("maven:g:a", "maven", "g:a", 2, 3, "g:a 2 to 3")
    assert usage_scanner.scan_repository("a", {"A.java": "import g.a.B;"}, [maven], packs)["unmapped"] == ["maven:g:a"]


def test_every_verified_rule_states_its_basis():
    for pack in usage_scanner.load_rule_packs().values():
        for change in pack["changes"]:
            assert change["source_url"].startswith("https://")
            for item in change["items"]:
                assert item["status"] in ("deprecated", "renamed", "removed", "changed")
                assert not item.get("verified") or item.get("basis")


# ---- Graph ------------------------------------------------------------------

def test_graph_summary_uses_real_counts():
    row = lambda name, drift, repos: {"id": f"npm:{name}", "dependency_name": name, "drift_disparity": drift, "declarations_by_repo": {
        r: {"declared_range": "^1", "resolved_version": None, "dep_type": "runtime", "source_file": "package.json"} for r in repos}}
    summary = graph_service.summarize([row("a", "MINOR_DRIFT", ["x", "y"]), row("b", "MAJOR_DRIFT", ["x", "y", "z"]), row("c", "INFO", ["z"])])
    assert summary["total_nodes"] == 6 and summary["total_edges"] == 6
    assert summary["highest_drift_nodes"] == ["b", "a"] and 0 < summary["density"] < 1


# ---- HTTP & Gemini ----------------------------------------------------------

def test_changelog_probe_404_does_not_count_as_source_failure():
    http = fake_http()
    # Query a changelog probe that 404s
    with pytest.raises(FetchError) as exc:
        asyncio.run(http.get_text("https://api.github.com/repos/acme/empty/contents/CHANGELOG.md?ref=HEAD"))
    assert exc.value.kind == "not_found"
    assert http.calls.get("api.github.com", 0) == 1
    assert http.failures.get("api.github.com", 0) == 0

    # A non-probe missing endpoint DOES count towards failures
    with pytest.raises(FetchError) as exc2:
        asyncio.run(http.get_text("https://api.github.com/repos/acme/empty/contents/nonexistent_file.py?ref=HEAD"))
    assert exc2.value.kind == "not_found"
    assert http.failures.get("api.github.com", 0) == 1


def test_gemini_ai_notes_succeeds_with_fallback_and_multi_parts(monkeypatch):
    from app.core.config import settings
    from app.services import explain
    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(settings, "GEMINI_MODEL", "gemini-2.5-flash")  # deprecated model name triggers fallback

    def mock_gemini(request):
        if "gemini-2.5-flash" in request.url.path:
            return httpx.Response(404, json={"error": {"message": "model no longer available"}})
        if "gemini-3.1-flash-lite" in request.url.path:
            return httpx.Response(200, json={
                "candidates": [{
                    "content": {
                        "parts": [
                            {"thought": True, "text": "thinking..."},
                            {"text": "Validator was replaced by field_validator. Migrate model validators."}
                        ]
                    }
                }]
            })
        return None

    http = fake_http(overrides=mock_gemini)
    notes = asyncio.run(explain.ai_notes(http, "pydantic", ["1.10.13", "2.5.0"], ["major drift"], ["BREAKING: validator replaced"]))
    assert notes is not None
    assert "Validator was replaced" in notes
    assert "thinking" not in notes


# ---- Evidence quality ---------------------------------------------------------

def _scan_body(body: str) -> changelog_service.Changelog:
    log = changelog_service.Changelog(fetched=True)
    changelog_service._scan(log, "2.0.0", body, "https://github.com/o/r/releases/tag/v2.0.0")
    return log


def test_a_heading_is_never_quoted_and_its_entries_are():
    log = _scan_body("## What's new\n- Faster startup everywhere\n\n### Breaking Changes\n\n* The `proxies` argument is gone, use `proxy`\n- Dropped Python 3.8 support\n\n### Fixes\n- Fixed a typo in the docs page\n")
    assert [(line.line, line.breaking) for line in log.lines] == [
        ("The `proxies` argument is gone, use `proxy`", True),
        ("Dropped Python 3.8 support", True),
    ]
    evidence = changelog_service.to_evidence(log)
    assert evidence["cited_excerpt"] == "The `proxies` argument is gone, use `proxy`" and evidence["verified_breaking"] is True
    assert all("Breaking Changes" not in line.line for line in log.lines)
    assert _scan_body("**Breaking changes**\n- Renamed the client class to Client2\n").lines[0].breaking is True


def test_an_imperative_remove_in_a_commit_title_is_not_a_stated_break():
    log = _scan_body("* setup: remove upper bound from python_requires by @someone\n* build: remove unused dev dependency\n")
    assert log.lines == [] and changelog_service.to_evidence(log) is None
    assert _scan_body("- The deprecated `proxies` argument has now been removed.\n").lines[0].breaking is True
    # A negated "removed" says the opposite of a removal.
    assert _scan_body("* BaseSettings moved, not removed by @someone in https://github.com/o/r/pull/1\n").lines == []


def test_a_truncated_ai_reply_is_dropped_not_shown(monkeypatch):
    import httpx
    from app.core.config import settings
    from app.services import explain

    monkeypatch.setattr(settings, "GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(settings, "GEMINI_MODEL", "model-a")

    def reply(finish: str, text: str):
        return lambda request: httpx.Response(200, json={"candidates": [{"finishReason": finish, "content": {"parts": [{"text": text}]}}]}) if request.url.host.startswith("generativelanguage") else None

    cut = asyncio.run(explain.ai_notes(fake_http(reply("MAX_TOKENS", "Different parts of our codebase are")), "x", ["1", "2"], ["Major version gap"], ["BREAKING: y"]))
    assert cut is None
    whole = asyncio.run(explain.ai_notes(fake_http(reply("STOP", "It may break.  Test first.")), "x", ["1", "2"], ["Major version gap"], ["BREAKING: y"]))
    assert whole == "It may break. Test first."
    odd = lambda request: httpx.Response(200, json=["not", "an", "object"]) if request.url.host.startswith("generativelanguage") else None
    assert asyncio.run(explain.ai_notes(fake_http(odd), "x", ["1", "2"], ["r"], ["BREAKING: y"])) is None
