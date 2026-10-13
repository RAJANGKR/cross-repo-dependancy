# DriftLock — Architectural Decision Records (ADRs)

This document formalizes the key engineering decisions, evaluated alternatives, and trade-offs for DriftLock.

---

## ADR-001: In-Process Asynchronous Job Model vs. External Distributed Queue

### Status
**Accepted**

### Context
Analyzing 3 repositories involves multiple network calls: GitHub tree traversal, manifest fetching, npm/PyPI registry queries, and optional Gemini LLM interpretation. Total execution time ranges from 5 to 25 seconds. A synchronous request risks browser connection timeouts. However, adding Celery with Redis or RabbitMQ introduces multi-process coordination, daemon dependencies, and significant deployment friction during a 24-hour hackathon.

### Decision
Use FastAPI’s native `BackgroundTasks` combined with an in-memory thread-safe `ScanStore` (`dict` protected by `asyncio.Lock` or `threading.Lock`).
- `POST /api/v1/scans` assigns a `scan_id`, sets status to `QUEUED`, kicks off the worker, and responds immediately with `202 Accepted`.
- Clients poll `GET /api/v1/scans/{scan_id}` until status reaches `COMPLETED` or `FAILED`.
- Provide an optional `?wait=true` query flag for synchronous CLI or test suite execution.

### Consequences
- **Positive**: Zero external infrastructure dependencies; running `uvicorn app.main:app` runs the entire system; trivial local development for all 4 teammates.
- **Negative**: Jobs do not persist across server process restarts; single-process scalability only (fully adequate for hackathon demo).

---

## ADR-002: Grounded LLM Evidence Requirement (Anti-Hallucination Guard)

### Status
**Accepted**

### Context
LLMs frequently exhibit hallucinations when asked about software compatibility—inventing plausible-sounding API removals or falsely asserting that a patch version broke backward compatibility. Presenting fabricated release notes undermines engineering credibility during the demo.

### Decision
Enforce a strict evidence-based pipeline:
1. Fetch official raw release notes from PyPI JSON metadata or npm registry release entries.
2. Provide raw changelog text directly in the Gemini prompt.
3. System prompt constraint: *"You are an evidence extractor. You must ONLY cite exact sentences from the provided text that declare breaking changes, deprecations, or major migrations. If no breaking change is explicitly stated, output verified_breaking: false and compatibility_risk: NONE or UNKNOWN_IMPACT. NEVER invent API signatures or release notes."*
4. The backend validates that `cited_excerpt` is a verbatim substring of the source text. If not, it falls back to heuristic classification.

### Consequences
- **Positive**: 100% verifiable, trustworthy drift intelligence; judges can inspect the direct release note source.
- **Negative**: If an open-source maintainer publishes an empty release note on PyPI/npm, the risk defaults to `UNKNOWN_IMPACT`.

---

## ADR-003: NetworkX for Dependency Graph Modeling

### Status
**Accepted**

### Context
DriftLock must cross-compare dependencies across multiple repositories to identify common packages, shared foundational tools, and high-density divergence clusters.

### Decision
Use Python's `networkx` library (`networkx.DiGraph`) as the internal graph representation.
- Node types: `Repository` and `Package`.
- Directed edges from `Repository` -> `Package` store `declared_range`, `resolved_version`, `dep_type`, and `file_origin`.
- Shared dependencies are extracted via graph degree filtering (`in_degree > 1`).

### Consequences
- **Positive**: Clean, robust, battle-tested graph algorithms; straightforward extraction of metrics (centrality, clustering, density); easy serialization to D3/ReactFlow format for the frontend teammate.
- **Negative**: NetworkX is an in-memory graph library, not a persistent graph database (e.g., Neo4j), which is optimal for our dataset scale (< 5,000 nodes).

---

## ADR-004: Strict Separation of Declared Ranges vs. Resolved Versions

### Status
**Accepted**

### Context
In modern package ecosystems, developers specify acceptable version ranges in manifests (`package.json`, `requirements.txt`), while package managers pin exact immutable versions in lockfiles (`package-lock.json`, `poetry.lock`). Two microservices might have identical declared ranges (`^18.0.0`) but run completely different locked versions (`18.0.2` vs `18.2.0`), or vice-versa.

### Decision
Explicitly separate `declared_range` from `resolved_version` across all data models, parsers, and API responses.
- Manifest parsers populate `declared_range`.
- Lockfile parsers populate `resolved_version`.
- Drift detection evaluates both layers independently.

### Consequences
- **Positive**: Pinpoints whether drift is caused by loose manifest ranges or out-of-sync deployment lockfiles; provides actionable remediation advice to engineers.
- **Negative**: Requires parsing two files per project instead of one when lockfiles exist.

---

## ADR-005: Dual Ingestion Modes (GitHub URLs + Local Manifest Upload)

### Status
**Accepted**

### Context
Unauthenticated GitHub REST API calls are rate-limited to 60 requests per hour per IP. During development and testing across 4 team members, this limit can be exhausted rapidly. Furthermore, local demo rehearsals require reliable, offline-capable test executions.

### Decision
Support both GitHub remote URLs and direct manifest file / payload submissions in `POST /api/v1/scans`. Provide bundled offline test fixtures in the repository.

### Consequences
- **Positive**: Zero risk of demo failure if WiFi drops or GitHub throttles; instant local feedback during automated test runs.
- **Negative**: Ingestion layer must handle two input shapes (handled cleanly via polymorphic `RepositoryTarget` schema).

---

## ADR-006: Optional SQLite Caching Layer for HTTP & Gemini Calls

### Status
**Accepted**

### Context
Fetching release metadata for large packages (like `react` or `aws-sdk`) and sending release notes to Gemini consumes network bandwidth, time, and API token quota.

### Decision
Implement an optional local SQLite database (`driftlock_cache.db`) with tables `http_cache` and `changelog_cache`.
- Caches PyPI/npm JSON payloads keyed by package and version.
- Caches Gemini changelog interpretations keyed by `(package_name, version_from, version_to)`.

### Consequences
- **Positive**: Repeat scans finish in under 1 second; zero redundant LLM API costs; completely transparent to the user.
- **Negative**: Cache invalidation logic needed if upstream release notes change (solved with 24-hour TTL).
