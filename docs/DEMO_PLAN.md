# DriftLock — Demo Plan & Presentation Script

This document details the live demonstration strategy, the 3-minute pitch narrative, curated demo repositories, and contingency fallbacks for the final hackathon presentation.

---

## 1. 3-Minute Demo Pitch Structure

```
[0:00 - 0:30] The Hook: The Hidden Cost of Microservice Dependency Drift
[0:30 - 1:15] The Live Scan: Ingesting 3 Repositories into DriftLock
[1:15 - 2:00] Deep Dive: The Cross-Repo Matrix, NetworkX Graph & Grounded Evidence
[2:00 - 2:35] Actionable Value: The Harmonization Solver
[2:35 - 3:00] Wrap-Up: Architecture, Engineering Rigor & Impact
```

### Detailed Script

#### 1. Hook (0:00 – 0:30)
> *"Every engineering team with multiple microservices has lived through this nightmare: Team A upgrades a foundational library like Pydantic or React to v2. Team B is still on v1. Everything compiles locally, but during cross-service communication or shared library imports, production silently breaks with a cryptic serialization bug. Dependency drift is invisible until it causes an outage. Today, we built **DriftLock** to make cross-repo drift immediately visible, mathematically mapped, and backed by verifiable release evidence."*

#### 2. Live Scan Ingestion (0:30 – 1:15)
> *"Let's see it in action. Here on our React dashboard, we enter three real services: `user-service`, `billing-service`, and `notification-service`. With one click on **Analyze Repositories**, DriftLock hits our FastAPI backend, pulls the live manifest files and lockfiles via GitHub API, parses both declared ranges and locked pins, and builds a unified dependency graph in under 5 seconds."*

#### 3. Deep Dive into the Drift Matrix & Grounded Intelligence (1:15 – 2:00)
> *"Notice the immediate breakdown. DriftLock didn't just dump a list of packages:
> - Here are our 14 shared packages across the 3 services.
> - Notice `react`: It is flagged in bold red as **MAJOR_DRIFT** and **CONFIRMED_BREAKING**. Service 1 is on React 18.2, while Service 2 is pinned on React 17.0.2.
> - When we click on the **Evidence Drawer**, DriftLock doesn't give a vague AI guess. Using the Gemini API strictly grounded on official release notes, it quotes the exact line: *'ReactDOM.render has been replaced by createRoot'*, with a direct link to the official GitHub release tag! No hallucinations, pure verifiable engineering facts."*

#### 4. Actionable Harmonization & NetworkX Graph (2:00 – 2:35)
> *"Over on the **Topology View**, we see our NetworkX dependency graph. Nodes with high degree centrality indicate foundational dependencies that multiple services rely on. And here at the top, DriftLock provides a **Harmonization Recommendation**: exactly what version each service needs to upgrade to in order to restore cross-repo alignment without introducing breaking regressions."*

#### 5. Wrap-up (2:35 – 3:00)
> *"Built in 20 hours with FastAPI, Pydantic v2, NetworkX, React, Vite, and Gemini. DriftLock turns multi-repo dependency chaos into deterministic clarity. Thank you!"*

---

## 2. Curated Demo Repositories

### Primary Live Target Set (3 Public GitHub Repositories or Live Samples)
1. **Repository A (`user-service`)**:
   - `package.json`: `react: ^18.2.0`, `axios: ^1.6.0`
   - `requirements.txt`: `fastapi>=0.110.0`, `pydantic>=2.6.0`
2. **Repository B (`billing-service`)**:
   - `package.json`: `react: ^17.0.2` (Major breaking drift with Repo A!)
   - `requirements.txt`: `fastapi>=0.100.0`, `pydantic>=1.10.12` (Critical breaking drift with Repo A!)
3. **Repository C (`notification-service`)**:
   - `package.json`: `axios: ^1.2.0` (Minor drift with Repo A)
   - `requirements.txt`: `fastapi>=0.100.0`, `celery>=5.3.0`

---

## 3. Contingency & Fallback Matrix

Hackathon live demos can fail due to conference WiFi drops, GitHub rate limits, or LLM latency spikes. DriftLock includes a 4-tier safety net:

| Tier | Strategy | Activation Condition | User Experience |
|---|---|---|---|
| **Tier 1 (Default)** | Live GitHub API + Live Gemini API | Normal operating conditions. | Full live scan completes in ~8–12 seconds. |
| **Tier 2 (SQLite Cache)** | Local SQLite Cache (`driftlock_cache.db`) | Network slow or repeat scan triggered. | Instant scan response (< 1s); identical UI display. |
| **Tier 3 (Local Fixtures)** | Pre-bundled Mock Fixtures | WiFi disconnected or GitHub API 429 rate-limited. | Toggle *"Demo Sample Mode"* in UI to load local mock targets instantly. |
| **Tier 4 (Video Safety)** | 1080p Recorded Backup Video | Catastrophic machine or projection failure. | Play 60-second walkthrough video while presenting live voiceover. |
