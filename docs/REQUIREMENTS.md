# DriftLock — Requirements Specification

## 1. Functional Requirements (FR)

### FR-1: Repository Ingestion
- **FR-1.1**: The system MUST accept a scan request containing up to three (3) repository targets.
- **FR-1.2**: Each repository target may be specified either as a public GitHub repository URL (e.g., `https://github.com/pallets/flask`) or as uploaded raw manifest files.
- **FR-1.3**: The GitHub fetcher MUST retrieve manifests from the default branch (`main` or `master`) or an explicitly specified git ref/tag.
- **FR-1.4**: If a repository target is inaccessible (404, private, or invalid URL), the system MUST flag that repository as unreachable without crashing the overall scan process.

### FR-2: Manifest & Lockfile Parsing
- **FR-2.1**: The system MUST support parsing the following manifest types:
  - **Node.js**: `package.json` (declared dependencies) and `package-lock.json` (resolved lockfile versions).
  - **Python**: `requirements.txt` (PEP 508 declared constraints), `pyproject.toml` (PEP 621 & Poetry declared constraints), and `poetry.lock` (resolved lockfile versions).
- **FR-2.2 (Crucial Boundary)**: The system MUST strictly distinguish between:
  - **Declared Version Range**: The constraint declared in developer manifests (e.g., `^18.2.0`, `>=2.0.0,<3.0.0`, `~1.4.0`).
  - **Resolved Version**: The exact locked version pinned in lockfiles (e.g., `18.2.0`, `2.4.1`).
- **FR-2.3**: Package names MUST be normalized across ecosystems (e.g., lowercase and canonicalized per PEP 503 for Python; case-preserved for npm).

### FR-3: Cross-Repository Dependency Graph Construction
- **FR-3.1**: The backend MUST construct a directed NetworkX graph (`networkx.DiGraph`) representing the cross-repository dependency topology.
- **FR-3.2**: Graph nodes MUST represent either `Repository` entities or `Package` entities.
- **FR-3.3**: Directed edges from a `Repository` node to a `Package` node MUST store attributes:
  - `declared_spec`: String representing the manifest constraint.
  - `resolved_version`: String representing the lockfile pin (if present).
  - `dep_type`: Dependency classification (`runtime`, `dev`, `peer`, `optional`).
  - `source_file`: Manifest file origin.
- **FR-3.4**: The system MUST serialize graph metrics (node count, edge count, shared dependency density) for presentation in the API response.

### FR-4: Version Drift Detection & Classification
- **FR-4.1**: For every shared package across two or more repositories, the system MUST compute drift disparity:
  - `IN_SYNC`: Both declared ranges and resolved versions are identical.
  - `MINOR_DRIFT`: Versions diverge within the same major version (minor or patch disparity).
  - `MAJOR_DRIFT`: Versions diverge across major version boundaries (e.g., `v1.x` vs `v2.x`).
  - `INFO`: Package is declared in only one repository (no cross-repo conflict).
- **FR-4.2**: The system MUST recommend a unified harmonization target version (typically the highest stable resolved version or latest compatible constraint).

### FR-5: Upstream Registry & Release Metadata Ingestion
- **FR-5.1**: For packages exhibiting `MAJOR_DRIFT` or `MINOR_DRIFT`, the system MUST query the official package registry:
  - **npm**: `https://registry.npmjs.org/{package}`
  - **PyPI**: `https://pypi.org/pypi/{package}/json`
- **FR-5.2**: The system MUST extract release timestamps, latest stable releases, and raw release notes/changelogs between the divergent versions.

### FR-6: Grounded LLM Compatibility Assessment (Gemini API)
- **FR-6.1 (Strict Anti-Hallucination Constraint)**: Any claim of a breaking change or backward incompatibility MUST cite concrete evidence from extracted release notes or official changelogs.
- **FR-6.2**: The LLM prompt MUST strictly instruct Gemini: *"Analyze ONLY the provided changelog excerpts. If no changelog text is available or if no breaking change is explicitly stated, classify compatibility risk as UNKNOWN_IMPACT or NONE. Do NOT invent breaking changes or speculate on API signatures without cited text."*
- **FR-6.3**: Every breaking change report MUST include:
  - `compatibility_risk`: `NONE` | `SUSPECTED_BREAKING` | `CONFIRMED_BREAKING` | `UNKNOWN_IMPACT`.
  - `evidence_text`: Verifiable excerpt from release notes or changelog (or empty if none found).
  - `source_url`: URL pointing to the release note or changelog.
- **FR-6.4**: If the Gemini API is unavailable or unconfigured, the system MUST gracefully fallback to heuristic SemVer analysis without failing the scan.

### FR-7: Scan Lifecycle & API Endpoints
- **FR-7.1**: The system MUST expose:
  - `GET /health`: Health and upstream dependency status.
  - `POST /api/v1/scans`: Ingestion endpoint returning a `202 Accepted` status with a `scan_id`.
  - `GET /api/v1/scans/{scan_id}`: Polling endpoint returning scan state and results.
- **FR-7.2**: Scan states MUST transition strictly: `QUEUED` -> `FETCHING` -> `PARSING` -> `ANALYZING` -> `COMPLETED` (or `FAILED`).

---

## 2. Non-Functional Requirements (NFR)

### NFR-1: Response Times
- Manifest-only scans (local or cached) MUST complete in `< 5 seconds`.
- Remote GitHub fetches + registry lookups MUST complete in `< 15 seconds`.
- Scans with Gemini changelog interpretation MUST complete in `< 30 seconds`.

### NFR-2: Upstream Rate Limit Resilience
- **GitHub API**: Public rate limit without token is 60 requests/hour. The backend MUST support an optional `GITHUB_TOKEN` environment variable raising the limit to 5,000 requests/hour.
- If a rate limit is exceeded (HTTP 403/429), the fetcher MUST return a descriptive error and fallback to cached or mock manifest fixtures.
- PyPI and npm calls MUST employ exponential backoff with a maximum of 2 retries.

### NFR-3: Storage & Memory Footprint
- In-memory scan store with automatic eviction after 2 hours.
- Optional SQLite database (`driftlock_cache.db`) for caching HTTP responses and Gemini changelog interpretations to prevent redundant network and token usage.

### NFR-4: Error Handling & Defensive Isolation
- Malformed manifest files in one repository MUST NOT crash the scan of other repositories.
- Unparseable dependencies MUST be logged as `skipped_items` and included in the scan warning report.

### NFR-5: Testability & Quality
- Minimum 85% test coverage for core parsers, SemVer engine, and graph builders.
- All endpoints must include schema validation via Pydantic v2.

---

## 3. Explicit Exclusions

1. **No Continuous CI/CD Bot Integration**: DriftLock is an on-demand analyzer for the hackathon MVP; webhook daemon setups are excluded.
2. **No Automatic Code Refactoring**: DriftLock recommends version harmonization; it does not rewrite application source code.
3. **No Private Monorepo Internal Build Tooling**: Tools like Bazel, Pants, Buck, Nx workspaces are excluded.
