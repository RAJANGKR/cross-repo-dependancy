# DriftLock Frontend (React + Vite + TypeScript)

Welcome! This folder is designated for the **DriftLock React + Vite + TypeScript** frontend dashboard.

For complete specifications, see:
- [API Contract Specification](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/API_CONTRACT.md)
- [Data Model & Schemas](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/DATA_MODEL.md)
- [Project Architecture](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/ARCHITECTURE.md)

---

## 🚀 Quick Setup for React + Vite

To initialize the Vite project here, run:

```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install
npm install lucide-react clsx tailwindcss
npm run dev
```

The Vite dev server will run on `http://localhost:5173`.

---

## 🔗 Backend API Integration (Phase 0 Baseline)

The FastAPI backend runs on **`http://localhost:8000`**.  
Interactive Swagger docs: **`http://localhost:8000/docs`**

CORS is pre-configured to accept requests from `http://localhost:5173`.

### 1. Health & Capability Check
- **Endpoint**: `GET /health` (or `GET /api/v1/health`)
- **Response**: Returns backend status, active parsers, and GitHub/Gemini configuration state.

### 2. Multi-Repository Scan Lifecycle (`POST /api/v1/scans`)
- **Endpoint**: `POST /api/v1/scans`
- **Headers**: `Content-Type: application/json`

#### Request Payload (Up to 3 GitHub Repositories):
```json
{
  "repository_targets": [
    {
      "type": "github",
      "url": "https://github.com/my-org/user-service",
      "ref": "main"
    },
    {
      "type": "github",
      "url": "https://github.com/my-org/billing-service",
      "ref": "main"
    },
    {
      "type": "github",
      "url": "https://github.com/my-org/notification-service",
      "ref": "main"
    }
  ],
  "options": {
    "check_changelogs": true,
    "ecosystems": ["npm", "python"]
  }
}
```

#### Response: `202 Accepted`
```json
{
  "scan_id": "scn_a1b2c3d4e5f6",
  "status": "QUEUED",
  "created_at": "2026-10-13T12:01:00.000Z",
  "poll_url": "/api/v1/scans/scn_a1b2c3d4e5f6"
}
```

### 3. Polling Results (`GET /api/v1/scans/{scan_id}`)
Poll every 1.5 seconds until `status === "COMPLETED"` or `"FAILED"`.

```typescript
// Example React polling hook pattern:
async function pollScan(scanId: string) {
  const res = await fetch(`http://localhost:8000/api/v1/scans/${scanId}`);
  const data = await res.json();
  if (data.status === "COMPLETED") {
    return data.result; // Full drift matrix, graph summary, evidence
  } else if (data.status === "FAILED") {
    throw new Error(data.error?.message || "Scan failed");
  }
  // Continue polling if QUEUED, FETCHING, PARSING, or ANALYZING
}
```

Refer to [`docs/API_CONTRACT.md`](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/API_CONTRACT.md) for full response schema examples.
