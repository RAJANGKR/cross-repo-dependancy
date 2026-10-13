# DriftLock Frontend

DriftLock is a React, TypeScript, and Vite dashboard for analyzing dependency drift across projects.

## Getting started

Requirements: Node.js and npm.

```powershell
cd frontend
npm ci
Copy-Item .env.example .env.local
npm run dev
```

The development server runs at `http://localhost:5173`.

Mock mode is enabled by default and uses the bundled demo report, so the frontend can be explored without a running backend. To use the API, set `VITE_USE_MOCK=false` in `.env.local` and set `VITE_API_URL` to the backend base URL.

## Scripts

```powershell
npm test
npm run typecheck
npm run build
```

## Frontend flow

- Add public GitHub repository URLs or paste supported manifests (`package.json`, `requirements.txt`, or `pom.xml`).
- Review dependency drift, risk, evidence, and project status.
- Filter, sort, and select drifts; view project and dependency relationships in the graph.
- Export the visible report as Markdown.

The frontend API client uses `POST /api/analyze`, `GET /api/demo`, and `GET /api/health`. Backend implementation and API contract details are maintained separately.
