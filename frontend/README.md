# DriftLock frontend

React, TypeScript and Vite dashboard for DriftLock. It submits 2 to 10 public GitHub repositories (or pasted manifests) to the backend, follows the scan while it runs, and shows where their shared dependencies have drifted and what the evidence says about it.

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
| `VITE_USE_MOCK` | `false` | `true` makes "Analyze repositories" and "Load demo run" play the sample built into the app instead of calling the backend. |

There are no secrets in the frontend. GitHub and Gemini keys are configured on the backend only.

## Backend contract

The API client follows `docs/API_CONTRACT.md`:

- `POST /api/v1/scans` with `{ repository_targets: [...] }`, where a target is `{ type: "github", url, ref? }` or `{ type: "pasted", name, files }`, answered with `202` and `{ scan_id, status, poll_url }`.
- `GET /api/v1/scans/{scan_id}`, polled every 1.5 seconds until the status is `COMPLETED` or `FAILED`.
- `GET /health`, used for the "Backend online" indicator.

Polling stops on a terminal status, on cancel, when the scan record is missing, after three consecutive failed polls, or after three minutes.

The backend in `backend/` implements this contract. See the root README for how to run both.

## Demo data

**Load demo run** requests the scan saved on the backend (`GET /api/v1/demo`), a real run that is replayed, and shows it through the same parser, state and screens as a live scan. It is labeled "Demo data" on every screen and in the exported report.

When that request fails (no backend, no saved run, or a record that is not a finished scan), the sample built into the app plays instead: hand-written, illustrative data. It is labeled "Sample data", and a notice on the results says why it is shown. Neither is ever mixed into real results.

With `VITE_USE_MOCK=true`, a `?mock=` query parameter plays a specific scenario when you click "Analyze repositories":

`failed`, `error400`, `ratelimit`, `offline`, `notfound`, `timeout`, `partial`, `empty`, `minimal`

## What the console shows

- **Command center**: scan status, overview numbers, four KPI cards, the dependency graph, priority drifts, repository health grades, top offenders and an ecosystem breakdown.
- **Active drifts**: one row per package with declared range, resolved version and source file per repository. Search, filters, quick toggles, saved views, bulk actions, compact rows.
- **Detail panel**: tabs for Overview (score breakdown, confidence, missing signals, vulnerabilities), Evidence, Versions, Fix (copy the version line, copy a PR description) and Notes (accept, dismiss, snooze, assign).
- **Risk intelligence**: release evidence, API contracts and code impact.
- **Review queue**, **Fix plans**, **Activity** (scan history and compare with previous), **Repositories** (coverage and two-repository comparison), **Settings**.
- Command palette (Ctrl or Cmd + K), keyboard shortcuts (?), light and dark themes, Technical and Executive views, a first-run tour, print styles.

A number the backend did not send is shown as "Not available", never as zero. Demo data is labeled on every screen.

### Saved in this browser

Review decisions, fix progress, the last 10 scan summaries, saved views and settings are kept in `localStorage` under one versioned key. Pasted manifest content is never written there: history keeps names and public URLs only. Settings has **Export all local data** and **Clear local data**.

### Provisional fields

The API contract section of the result (`contract_analysis`) is not produced by the backend yet. The frontend reads it using the field names in `src/api/scanTypes.ts`; only `src/api/parseScan.ts` needs to change when the backend defines it.

## Scripts

```powershell
npm test          # unit and render tests (Vitest)
npm run typecheck
npm run build
```

## Layout

```
src/api/         scan types, response parsing, HTTP client, polling, error mapping, demo scan
src/lib/         URL and form validation, classification labels, overview numbers, filters, graph layout, fixes, health grades, local store, export
src/hooks/       scan state, routing, keyboard navigation, announcements
src/components/  input, analyzing, console, results, detail, states, common
src/index.css    theme tokens (colors, fonts, motion)
```
