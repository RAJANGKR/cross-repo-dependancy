# DriftLock

**Dependabot tells you versions differ. DriftLock tells you whether your code will actually break.**

DriftLock reads 2 to 10 public GitHub repositories (or manifests you paste), lines up their direct dependencies, finds the libraries pinned to different versions, and rates how likely each drift is to break something, with the evidence shown.

Built for Hacktopia 2026, problem statement PS 07 (cross-repo dependency drift detector).

## What it does

- **Reads manifests and lockfiles**: `package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, `poetry.lock`, `pom.xml`. Declared ranges and resolved (lockfile) versions are kept separate.
- **Classifies each shared library** deterministically: major drift, minor drift, in sync, or not compared; and a compatibility risk: confirmed breaking, suspected breaking, unknown impact, or no issue identified.
- **Collects evidence**: registry version lists (npm, PyPI, Maven Central), known vulnerabilities (OSV.dev), release notes (GitHub Releases or a CHANGELOG file), and a code-usage scan of the repository source.
- **Scores** each drift 0 to 100 with a visible points breakdown and a confidence value that drops when evidence is missing.
- **Console UI**: command center, drift table, dependency graph, risk intelligence, review queue, fix plans, activity, repository comparison, settings.

## Run it (Windows)

Backend, in one terminal:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env   # optional: add GITHUB_TOKEN and GEMINI_API_KEY
uvicorn app.main:app --reload --port 8000
```

Frontend, in another:

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://localhost:5173`. If port 8000 or 5173 is already in use, run the backend on another port (`--port 8010`), set `VITE_API_BASE_URL=http://localhost:8010` in `frontend/.env.local`, and add your frontend origin to `CORS_ORIGINS` in `backend/.env`.

## Configuration

| Where | Variable | Purpose |
| --- | --- | --- |
| `backend/.env` | `GITHUB_TOKEN` | Optional. Raises the GitHub API limit from 60 to 5,000 requests per hour. A token with no scopes is enough. |
| `backend/.env` | `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional. Without a key, explanations are generated from rules. |
| `backend/.env` | `CORS_ORIGINS` | Frontend origins allowed to call the API. |
| `backend/.env` | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | Optional. Turns on Sign in with GitHub. |
| `backend/.env` | `SESSION_SECRET` | Any long random string. Keeps people signed in across backend restarts. |
| `backend/.env` | `AUTH_REQUIRED` | Default `false`. `true` makes sign-in mandatory: the app shows a sign-in screen and the API refuses scans without a session. |
| `backend/.env` | `CACHE_ENABLED`, `CACHE_PATH` | SQLite cache for public upstream data. |
| `frontend/.env.local` | `VITE_API_BASE_URL` | Backend base URL. |
| `frontend/.env.local` | `VITE_USE_MOCK` | `true` plays the bundled demo scan instead of calling the backend. |

No secret is ever needed in the frontend, and none is committed.

## Sign in with GitHub

Sign-in is optional, and GitHub is the only method. Everything works signed out. There is no separate sign-up: the first sign-in is the account.

1. On GitHub, open Settings, Developer settings, OAuth Apps, and create a new OAuth app.
2. Set the homepage URL to your frontend (for example `http://localhost:5173`) and the authorization callback URL to `{backend URL}/api/v1/auth/github/callback` (for example `http://localhost:8000/api/v1/auth/github/callback`).
3. Put the client ID and a generated client secret in `backend/.env` as `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`, set `SESSION_SECRET`, and restart the backend.

The backend asks GitHub only for the public profile (`read:user`), keeps the session in a signed HTTP-only cookie, and discards the GitHub access token straight after reading the profile. Without these settings the app runs as before and the sign-in button is disabled.

## How risk is decided

All classification and scoring is deterministic Python (`backend/app/services/classifier.py`, `scoring.py`). Gemini, when configured, only writes explanation text.

- `verified_breaking` is true only when the quoted line appears literally in release-note text the backend fetched for versions between the two being compared, and that line carries a breaking marker.
- The code-usage scan has tiers. **Tier 1** is an import map: where a library is used, with no claim that anything breaks. **Tier 2** is a rule pack checked against the library's official migration guide; `backend/app/rules/pydantic.json` is the one shipped. Tier 3 (AI-suggested candidate names) is not built.
- Score weights are untuned estimates: major gap +50, minor +20, patch +5, breaking marker +25, known vulnerability +20, used by 3 or more repositories +10, Tier 2 code hits +15, overlapping ranges -30.
- Confidence is a heuristic about how much evidence was available. It is not accuracy.

## Tests

```powershell
cd backend;  .\.venv\Scripts\python -m pytest      # 74 tests, no network: upstreams are mocked
cd frontend; npm test; npm run build               # 99 tests
```

`backend/scripts/live_smoke.py` is an optional script that runs one real scan against the live APIs. It is not part of the test suite.

## Demo script

1. Start both servers. The input screen shows "Backend online".
2. Paste three repository URLs (or press **Fill example repositories**), then **Analyze repositories**. Watch the stages: queued, fetching, parsing, analyzing.
3. **Command center**: the four headline numbers, the graph, and the priority drifts list.
4. Open the top drift. Walk the tabs: Overview (score breakdown, confidence, missing signals), Evidence (quoted release note, code locations), Versions, Fix (copy the version line), Notes (accept, dismiss, snooze).
5. Show a patch-level drift classified "No issue identified": it does not cry wolf.
6. **Fix plans**: copy all fixes. **Export report** as Markdown.
7. If the network fails: **Load demo run** plays bundled demo data, labeled as such everywhere.

`GET /api/v1/demo` serves `backend/demo/demo_scan.json`, a saved real run of this backend against four services of `GoogleCloudPlatform/microservices-demo`.

## Limitations

- Direct dependencies only. Transitive dependencies are not compared.
- Public GitHub repositories only. Private projects can be pasted, without a code scan.
- Only pushed code is read.
- The code scan finds changed names, not silent behavior changes, and cannot confirm a runtime failure.
- Maven: `${property}` and `dependencyManagement` in the same `pom.xml` only; parent POMs and BOM imports are not followed.
- API contract analysis compares OpenAPI / Swagger files only when they are verifiably two versions of the same API (matching `x-api-id` or title, and an orderable `info.version`). Findings are potentially breaking changes found in the files, never confirmed runtime failures. For each consumer repository, every change is given an evidence tier: the operation is called, the changed field itself is read or sent, no usage was found, or the code could not be followed. "No usage found" is not a statement of safety, and "unresolved" is the result whenever the call target, the client, the HTTP method or the URL cannot be established from the source. The evaluation measures detection of usage of a changed element; it does not measure breakage. Details and limits: `docs/API_CONTRACT.md`, "Contract analysis".
- Risk is a signal, not a guarantee.

## Not built

Tier 3 candidate rules, rule packs other than pydantic, graph export to PNG, and per-repository retry (a retry re-runs the whole scan).

## Roadmap

GitHub App for private repositories, a CI action that fails a build on new confirmed-breaking drift, transitive dependency comparison, more verified rule packs.

## Repository layout

```
backend/    FastAPI service: parsers, GitHub fetcher, registries, OSV, changelog, classifier, scoring, usage scanner
frontend/   React 19 + Vite + TypeScript + Tailwind v4 console
docs/       API contract and data model
```
