# DriftLock frontend

React, TypeScript and Vite dashboard for DriftLock. It submits three public GitHub repositories to the backend, follows the scan while it runs, and shows where their shared dependencies have drifted and what the evidence says about it.

## Run it

Requirements: Node.js 20.19 or newer, and npm.

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev
```

The dev server runs at `http://localhost:5173`. The port is fixed because the backend's CORS allowlist expects that origin, so stop anything else that is using it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Base URL of the FastAPI backend. |
| `VITE_USE_MOCK` | `false` | `true` makes "Analyze repositories" play the bundled demo scan instead of calling the backend. |

There are no secrets in the frontend. GitHub and Gemini keys are configured on the backend only.

## Backend contract

The API client follows `docs/API_CONTRACT.md`:

- `POST /api/v1/scans` with `{ repository_targets: [{ type: "github", url, ref? }] }`, answered with `202` and `{ scan_id, status, poll_url }`.
- `GET /api/v1/scans/{scan_id}`, polled every 1.5 seconds until the status is `COMPLETED` or `FAILED`.
- `GET /health`, used for the "Backend online" indicator.

Polling stops on a terminal status, on cancel, when the scan record is missing, after three consecutive failed polls, or after three minutes.

The backend in this repository does not serve `/api/v1/scans` yet (it has `/api/v1/scan/compare`). Until it does, a real scan ends on a "Scan endpoint not available" screen. Use **Load demo run** to see the full dashboard in the meantime.

## Demo data

**Load demo run** plays a bundled, hand-written scan through the same submit-and-poll code as a real one. It is labeled "Demo data" on every screen and in the exported report. It is never mixed into real results.

With `VITE_USE_MOCK=true`, a `?mock=` query parameter plays a specific scenario when you click "Analyze repositories":

`failed`, `error400`, `ratelimit`, `offline`, `notfound`, `timeout`, `partial`, `empty`, `minimal`

## What the dashboard shows

- **Overview**: repositories scanned, dependencies analyzed, in sync, minor drift, major drift, single-repository packages, compatibility findings and warnings. A number the backend did not send is shown as "Not available", never as zero.
- **Dependencies**: one row per package, with each repository's declared range, resolved version and source file kept separate. Filter by name, ecosystem, drift and risk; sort from the menu or the column headers; filters live in the URL.
- **Detail panel**: versions by repository, what the classifications mean, release evidence, related call sites and a rule-based next step.
- **Graph**: repository-to-package links built from the declarations in the result. Calls between services are not inferred.
- **Release evidence**: quoted release notes, the source link, and AI interpretation labeled and kept apart from the quote.
- **API contracts** and **Code impact**: rendered when the backend returns the data, with a plain "not returned" state until then.
- **Repositories and warnings**: what was and was not analyzed, including repositories the backend dropped.

### Provisional fields

The API contract does not define contract analysis or call-site analysis yet. The frontend reads them from `result.contract_analysis` and `result.code_impact` using the field names in `src/api/scanTypes.ts`. Align those names with the backend schema when it is written; only `src/api/parseScan.ts` needs to change.

## Scripts

```powershell
npm test          # unit and render tests (Vitest)
npm run typecheck
npm run build
```

## Layout

```
src/api/         scan types, response parsing, HTTP client, polling, error mapping, demo scan
src/lib/         URL validation, classification labels, overview numbers, filters, graph layout, export
src/hooks/       scan state, routing, keyboard navigation, announcements
src/components/  input, analyzing, results, detail, states, common
src/index.css    theme tokens (colors, fonts, motion)
```
