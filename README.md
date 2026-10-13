# 🔒 DriftLock

> **Automated Cross-Repository Dependency Drift Detection & Compatibility Analysis Engine**  
> *A 24-Hour Hackathon Project | Target MVP Delivery: 18–20 Hours*

[![Python 3.11](https://img.shields.io/badge/Python-3.11-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg)](https://fastapi.tiangolo.com/)
[![Pydantic v2](https://img.shields.io/badge/Pydantic-v2-E92063.svg)](https://docs.pydantic.dev/)
[![React 18](https://img.shields.io/badge/React-18-61DAFB.svg)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-5.0-646CFF.svg)](https://vitejs.dev/)
[![NetworkX](https://img.shields.io/badge/NetworkX-3.0+-orange.svg)](https://networkx.org/)
[![Gemini API](https://img.shields.io/badge/Gemini-1.5--Flash-8E75B2.svg)](https://ai.google.dev/)

---

## 📌 Executive Overview

In modern microservice architectures, independent development teams frequently deploy services relying on common third-party libraries (`react`, `fastapi`, `pydantic`, `requests`). Over time, divergence between declared constraints and resolved lockfile pins leads to **cross-repository dependency drift**, causing subtle integration incompatibilities, runtime serialization errors, and security vulnerabilities.

**DriftLock** ingests up to three public repositories, extracts both declared specifications and resolved lockfile pins, constructs a unified cross-repository dependency graph using **NetworkX**, and uses the **Google Gemini API** (strictly constrained to ground-truth release notes) to classify breaking changes with verifiable citations.

---

## 📚 Phase 0: Engineering Contract & Documentation Hub

All foundational specifications, architectural contracts, and development plans are established in the [`docs/`](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/) directory:

| Document | Purpose & Description |
|---|---|
| [**`docs/PROJECT_CONTEXT.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/PROJECT_CONTEXT.md) | Hackathon constraints, 4-member team workstream allocation, and project boundaries. |
| [**`docs/REQUIREMENTS.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/REQUIREMENTS.md) | Functional requirements (FR-1 to FR-7), Non-functional requirements, and explicit out-of-scope boundaries. |
| [**`docs/ARCHITECTURE.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/ARCHITECTURE.md) | Subsystem architecture, Mermaid system diagrams, data flows, and error boundaries. |
| [**`docs/API_CONTRACT.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/API_CONTRACT.md) | Stable REST/JSON contract (`GET /health`, `POST /api/v1/scans`, `GET /api/v1/scans/{id}`), polling spec, error formats. |
| [**`docs/DATA_MODEL.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/DATA_MODEL.md) | Pydantic v2 domain schemas, ER diagrams, declared vs. resolved boundary rules, and evidence models. |
| [**`docs/DEVELOPMENT_PLAN.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/DEVELOPMENT_PLAN.md) | 24-hour hour-by-hour roadmap, engineer task breakdown, milestones, and MVP target checkpoints. |
| [**`docs/TESTING.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/TESTING.md) | Testing pyramid, fixture datasets (in-sync, minor drift, breaking drift, rate limits), and verification checklist. |
| [**`docs/DECISIONS.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/DECISIONS.md) | Architectural Decision Records (ADRs: In-process async model, Grounded LLM, NetworkX, Lockfile separation). |
| [**`docs/DEMO_PLAN.md`**](file:///Users/rjn_g/Documents/%20Tech/Hactopia/docs/DEMO_PLAN.md) | 3-minute pitch script, curated test repositories, and 4-tier live demo contingency fallbacks. |

---

## 🏗️ Repository Layout

```
.
├── backend/                  # FastAPI + Python 3.11 Backend
│   ├── app/
│   │   ├── api/              # REST Endpoints (v1 router, health, scans)
│   │   ├── core/             # Configuration & environment settings
│   │   ├── parsers/          # Node.js (package.json, lock) & Python (reqs, pyproject, lock)
│   │   ├── schemas/          # Pydantic v2 schemas (Dependency, Drift, Scan models)
│   │   └── services/         # VersionService, DriftEngine, NetworkX Graph, Registry & Gemini
│   ├── tests/                # Pytest unit, integration, and contract tests
│   ├── requirements.txt      # Python dependencies
│   ├── .env.example          # Sample environment configuration
│   └── .gitignore            # Git ignore rules
│
├── frontend/                 # React 18 + Vite + TypeScript Frontend
│   └── README.md             # Collaborator setup guide and mock payload integration
│
├── docs/                     # Shared Engineering Specifications (Phase 0)
│   ├── PROJECT_CONTEXT.md
│   ├── REQUIREMENTS.md
│   ├── ARCHITECTURE.md
│   ├── API_CONTRACT.md
│   ├── DATA_MODEL.md
│   ├── DEVELOPMENT_PLAN.md
│   ├── TESTING.md
│   ├── DECISIONS.md
│   └── DEMO_PLAN.md
│
└── README.md                 # Master Project Documentation
```

---

## ⚡ Quickstart Guide

### 1. Backend Service (FastAPI)

```bash
# Navigate to the backend directory
cd backend

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env

# Run unit and integration tests
pytest -v

# Start the dev server
uvicorn app.main:app --reload --port 8000
```

- **API Base URL**: `http://localhost:8000`
- **Swagger Documentation**: `http://localhost:8000/docs`
- **Health Check**: `http://localhost:8000/health`

### 2. Frontend Dashboard (React + Vite)

See [frontend/README.md](file:///Users/rjn_g/Documents/%20Tech/Hactopia/frontend/README.md) for full instructions:

```bash
cd frontend
npm create vite@latest . -- --template react-ts
npm install
npm run dev
```

The frontend dashboard runs on `http://localhost:5173` and communicates with the backend via CORS.

---

## 👥 Hackathon Team Workstreams

- **Engineer 1 (Backend Lead)**: FastAPI infrastructure, GitHub REST fetcher, Rate limiting, Async job store.
- **Engineer 2 (Graph & Analysis Lead)**: Manifest & lockfile parsers, NetworkX cross-repo graph, SemVer comparator.
- **Engineer 3 (Intelligence & Registry Lead)**: npm/PyPI registry clients, Gemini grounded changelog interpreter, SQLite cache.
- **Engineer 4 (Frontend Lead)**: React 18, Vite, TypeScript, Tailwind UI, Drift Matrix, Graph Visualizer.
