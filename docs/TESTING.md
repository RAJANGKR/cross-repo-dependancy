# DriftLock — Testing & Quality Assurance Plan

This document details the test strategy, fixture datasets, automated verification suites, and acceptance criteria for DriftLock.

---

## 1. Testing Strategy

DriftLock uses a multi-tier testing pyramid to guarantee reliability within the rapid 24-hour delivery window:

```
          [ End-to-End Scans ]        (Live GitHub + Local Scans)
        [ API Contract Tests ]        (FastAPI TestClient Polling)
      [ Service Integration ]         (Graph + Version Engine + Mocks)
    [ Unit Tests (Parsers/SemVer) ]   (Pytest, Pure Logic, 100% Deterministic)
```

1. **Unit Tests**: Test manifest and lockfile parsing, SemVer version extraction, NetworkX graph node/edge creation, and anti-hallucination evidence validation in total isolation.
2. **Integration Tests**: Verify the stateful scan lifecycle (`POST /api/v1/scans` -> `GET /api/v1/scans/{scan_id}`) using FastAPI's `TestClient` and in-memory test store.
3. **Mock Upstream Tests**: Simulate external GitHub rate limiting (429), malformed JSON from npm, and slow/empty Gemini responses.
4. **Contract Acceptance Tests**: Validate that the serialized API response exactly satisfies the Pydantic v2 schemas defined in `docs/DATA_MODEL.md`.

---

## 2. Test Fixture Datasets

To ensure deterministic testing without consuming GitHub API rate limits or Gemini tokens during CI runs, the backend maintains offline test fixtures in `backend/tests/fixtures/`:

### Fixture Set 1: Fully Synchronized Repositories (`fixtures/in_sync/`)
- **Repo 1**: `package.json` (`react: 18.2.0`), `package-lock.json` (`18.2.0`)
- **Repo 2**: `package.json` (`react: 18.2.0`), `package-lock.json` (`18.2.0`)
- **Expected Outcome**:
  - `drift_disparity`: `IN_SYNC`
  - `compatibility_risk`: `NONE`
  - `drift_count`: 0

### Fixture Set 2: Minor / Patch Version Drift (`fixtures/minor_drift/`)
- **Repo 1**: `requirements.txt` (`fastapi>=0.100.0`), `poetry.lock` (`0.104.1`)
- **Repo 2**: `requirements.txt` (`fastapi>=0.110.0`), `poetry.lock` (`0.110.0`)
- **Expected Outcome**:
  - `drift_disparity`: `MINOR_DRIFT`
  - `compatibility_risk`: `NONE`
  - `recommended_version`: `>=0.110.0`

### Fixture Set 3: Critical Major Breaking Drift with Evidence (`fixtures/major_drift/`)
- **Repo 1**: `package.json` (`react: ^17.0.2`), `package-lock.json` (`17.0.2`)
- **Repo 2**: `package.json` (`react: ^18.2.0`), `package-lock.json` (`18.2.0`)
- **Mock Changelog**: React 18 release notes describing removal of `ReactDOM.render`.
- **Expected Outcome**:
  - `drift_disparity`: `MAJOR_DRIFT`
  - `compatibility_risk`: `CONFIRMED_BREAKING`
  - `evidence.verified_breaking`: `True`
  - `evidence.cited_excerpt`: Must contain `"ReactDOM.render has been replaced by createRoot"`.

### Fixture Set 4: Missing Changelog / Anti-Hallucination Guard (`fixtures/no_changelog/`)
- **Repo 1**: `requirements.txt` (`internal-auth-lib==1.0.0`)
- **Repo 2**: `requirements.txt` (`internal-auth-lib==2.0.0`)
- **Registry Response**: 404 or empty description text.
- **Expected Outcome**:
  - `drift_disparity`: `MAJOR_DRIFT`
  - `compatibility_risk`: `UNKNOWN_IMPACT` (or `SUSPECTED_BREAKING`)
  - `evidence.cited_excerpt`: `""` (Empty string; LLM MUST NOT invent changelog notes).

### Fixture Set 5: Upstream Rate Limit Exhaustion (`fixtures/rate_limited/`)
- Simulated GitHub API response returning HTTP 403 / 429 with `X-RateLimit-Remaining: 0`.
- **Expected Outcome**:
  - Backend does not crash with unhandled exception.
  - Scan state marks failure with structured `error_code: "RATE_LIMIT_EXCEEDED"`.

---

## 3. Test Cases & Verification Checklist

| Test Suite | File | Target Behavior | Pass Criteria |
|---|---|---|---|
| **Parsers** | `test_parsers.py` | Parse `package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, `poetry.lock` | 100% extraction of names, constraints, and locked pins. |
| **Graph** | `test_graph_service.py` | Build NetworkX DiGraph from 3 repository sets | Nodes correctly typed; shared dependencies yield `in_degree >= 2`. |
| **Drift Engine** | `test_drift_engine.py` | Evaluate SemVer version pairs across repos | Correct categorization into `IN_SYNC`, `MINOR_DRIFT`, `MAJOR_DRIFT`, `INFO`. |
| **Intelligence** | `test_gemini_service.py` | Parse changelogs with strict ground-truth prompting | Zero fabricated quotes; quotes must match substring of input text. |
| **API Lifecycle** | `test_api.py` | Test `POST /api/v1/scans` (async & sync) and `GET /api/v1/scans/{id}` | Correct HTTP status codes (202, 200, 400, 404, 429). |
| **Health** | `test_api.py` | Verify `GET /health` | Reports service status, environment, and parser capabilities. |

---

## 4. Execution Commands

```bash
# Activate virtual environment
cd backend
source .venv/bin/activate

# Run full test suite with verbose output
pytest -v

# Run with coverage report (target >= 85%)
pytest --cov=app --cov-report=term-missing tests/

# Run API contract tests specifically
pytest tests/test_api.py -v
```
