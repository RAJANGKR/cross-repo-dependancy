# DriftLock — Project Context & Hackathon Scope

## 1. Executive Summary

**DriftLock** is an automated cross-repository dependency drift detection and compatibility analysis engine built for multi-repo microservice architectures.

In distributed systems, microservices frequently depend on shared libraries (e.g., `requests`, `fastapi`, `react`, `pydantic`, `shared-auth-sdk`). Over time, independent deployment cycles lead to **cross-repository dependency drift**: Service A upgrades to `v2.x`, while Service B remains on `v1.x`, creating subtle integration mismatches, shared utility incompatibilities, and security vulnerabilities.

DriftLock inspects up to three repositories simultaneously, extracts declared manifest ranges and resolved lockfiles, constructs a unified cross-repo dependency graph using NetworkX, detects version divergence, and fetches verifiable release notes to produce evidence-backed compatibility reports via the Gemini API.

---

## 2. Hackathon Operating Parameters

- **Event Horizon**: 24-hour hackathon.
- **Target MVP Delivery**: Hour 18–20 (leaving 4 hours for end-to-end polish, rehearsal, and video capture).
- **Core Repository**: Monorepo hosting `backend/` and `frontend/` alongside unified `docs/`.
- **Target Inputs**: Exactly 3 public GitHub repositories per scan (or local manifest sets).
- **Authentication Stance**: Zero mandatory authentication for end users; optional personal GitHub token and Gemini API key configured on the backend server.

---

## 3. Team Structure & Workstream Allocation

The project is developed by a balanced 4-person engineering team:

| Team Member | Role | Primary Responsibility | Key Deliverables |
|---|---|---|---|
| **Engineer 1 (Lead)** | Backend Lead | Core FastAPI service, GitHub fetcher, Rate limiting, API routing | `app/main.py`, `app/api/`, `app/core/`, `app/services/github_fetcher.py` |
| **Engineer 2** | Graph & Analysis Lead | Manifest parsers, NetworkX cross-repo graph, SemVer comparator | `app/parsers/`, `app/services/version_service.py`, `app/services/graph_service.py` |
| **Engineer 3** | Intelligence & Evidence Lead | npm/PyPI registry client, Gemini changelog interpreter, Evidence validation | `app/services/registry_client.py`, `app/services/gemini_service.py` |
| **Engineer 4** | Frontend Lead | React 18, Vite, TypeScript, Tailwind/Lucide dashboard, Graph visualizer | `frontend/src/` (Dashboard, Scan Trigger, Matrix, Graph View) |

---

## 4. Technology Stack & Constraints

- **Language / Runtime**: Python 3.11 (Backend), Node.js 18+ (Frontend).
- **Backend Web Framework**: FastAPI with Pydantic v2 for data validation.
- **Dependency Graph**: NetworkX for directed multigraph representation of cross-repo package relationships.
- **Upstream Data Sources**:
  - GitHub REST API v3 (repository tree and raw file blobs).
  - PyPI JSON API (`https://pypi.org/pypi/{package}/json`).
  - npm Registry API (`https://registry.npmjs.org/{package}`).
- **LLM / Intelligence Engine**: Google Gemini API (`gemini-1.5-flash` or `gemini-1.5-pro`) strictly constrained to ground-truth release notes.
- **Caching Layer**: Optional local SQLite (`driftlock_cache.db`) for HTTP response caching and changelog interpretation caching to minimize API rate limit burn.
- **Frontend Framework**: React 18 with Vite and TypeScript.

---

## 5. Explicit Project Exclusions (Out of Scope for MVP)

To ensure completion within the 18–20 hour target, the following features are explicitly **out of scope**:
1. User registration, login, JWT authorization, and tenant isolation.
2. Private repository cloning requiring OAuth2 GitHub App workflows (MVP targets public repositories or provided manifest uploads).
3. Automated Git pull request generation or push actions.
4. Celery/RabbitMQ/Redis distributed background queues (all async scans run in-process via FastAPI `BackgroundTasks`).
5. Languages beyond Python (`requirements.txt`, `pyproject.toml`) and Node.js (`package.json`, `package-lock.json`).
6. Monorepo workspace orchestration engines (Nx, Turborepo deep internal graph resolution).
