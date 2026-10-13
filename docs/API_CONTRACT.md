# DriftLock API contract

This describes what the backend serves today. The frontend's types in `frontend/src/api/scanTypes.ts` and its parser in `parseScan.ts` are kept in step with it.

- Base URL: `http://localhost:8000`
- Content type: `application/json`
- Errors always have the shape `{ "error_code": "...", "message": "...", "details": {} }`.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `GET /health`, `GET /api/v1/health` | Liveness and which optional services are configured. |
| `POST /api/v1/scans` | Queue a scan. Returns `202` with a receipt. |
| `GET /api/v1/scans/{scan_id}` | Scan status, progress and (when finished) the result. |
| `GET /api/v1/auth/me` | `{ configured, required, user }`. `user` is `null` when signed out, else `{ id, login, name, avatar_url }`. |
| `GET /api/v1/auth/github/login?return_to=` | Starts Sign in with GitHub. `return_to` must be a configured frontend origin. |
| `GET /api/v1/auth/github/callback` | GitHub returns here. Sets the session cookie and redirects to the frontend, with `?auth_error=` on failure. |
| `POST /api/v1/auth/logout` | Clears the session cookie. |
| `GET /api/v1/demo` | A saved real run, as a completed scan record. `404 DEMO_NOT_AVAILABLE` if none is saved. |
| `POST /api/v1/scan/compare`, `/parse-file`, `/upload-repo` | Earlier manifest-only endpoints, still served. |

## `GET /health`

```json
{
  "status": "healthy",
  "service": "DriftLock Backend",
  "version": "0.1.0",
  "environment": "development",
  "timestamp": "2026-10-13T10:14:07.780Z",
  "services": {
    "github_api": { "authenticated": false, "rate_limit_remaining": null },
    "gemini_api": { "configured": false, "model": "gemini-2.5-flash" },
    "cache": { "type": "sqlite", "path": "driftlock_cache.db" }
  },
  "supported_manifests": ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "poetry.lock", "pom.xml"]
}
```

`rate_limit_remaining` is `null` here; the live value is reported per scan, as a warning when it is low.

## `POST /api/v1/scans`

Query parameter `wait=true` runs the scan synchronously and returns the finished record with `200`.

```json
{
  "repository_targets": [
    { "type": "github", "url": "https://github.com/owner/repo", "ref": "main" },
    { "type": "github", "url": "https://github.com/owner/repo/tree/feature/x/sub/folder" },
    { "type": "pasted", "name": "billing", "files": [{ "filename": "package.json", "content": "..." }] }
  ],
  "options": { "check_changelogs": true, "check_vulnerabilities": true, "scan_code": true, "check_contracts": true, "ecosystems": ["npm", "python", "maven"] }
}
```

Rules:

- 2 to 10 targets. GitHub and pasted targets can be mixed.
- A GitHub URL must be `https://github.com/{owner}/{repo}`, optionally followed by `/tree/{ref}`. The ref may contain slashes and may end with a sub-folder, which limits the scan to that folder. A trailing `.git` or slash is removed. Anything else is rejected.
- `ref` is optional; a ref in the URL takes precedence.
- A pasted file must be a supported manifest name and at most 200 KB. Pasted content is never cached or logged.
- `options` and each of its fields are optional.

`202 Accepted`:

```json
{ "scan_id": "scn_a75b33111781", "status": "QUEUED", "created_at": "2026-10-13T10:14:08.144Z", "poll_url": "/api/v1/scans/scn_a75b33111781", "message": "Scan job initiated. Poll the poll_url for progress updates." }
```

`401` with `error_code` `SIGN_IN_REQUIRED` only when the backend is started with `AUTH_REQUIRED=true` and the caller is signed out; the same then applies to `GET /api/v1/scans/{scan_id}`. By default sign-in is optional.

`400` with `error_code` `INVALID_TARGETS` (bad count, URL, duplicate, unsupported or oversized file) or `INVALID_REQUEST` (malformed body).

## `GET /api/v1/scans/{scan_id}`

```json
{
  "scan_id": "scn_a75b33111781",
  "status": "ANALYZING",
  "created_at": "...", "updated_at": "...", "completed_at": null, "duration_seconds": null,
  "progress": { "stage": "ANALYZING", "percentage": 85, "current_action": "Checking release notes and vulnerabilities for 4 drifted packages" },
  "result": null,
  "error": null
}
```

`status` moves through `QUEUED`, `FETCHING`, `PARSING`, `ANALYZING`, then `COMPLETED` or `FAILED`. Unknown id: `404 SCAN_NOT_FOUND`. Records are kept in memory for two hours.

A scan is `FAILED` only when no target could be analyzed; `error.error_code` is then `NO_REPOSITORIES_ANALYZED`, `RATE_LIMIT_EXCEEDED` or `SCAN_FAILED`. A target that fails on its own (not found, private, unresolved branch, no manifest) is reported in `warnings` and the scan still completes with the others.

### `result`

```json
{
  "scanned_repositories": [{ "name": "service-a", "url": "https://github.com/o/service-a", "manifest_count": 3, "total_dependencies": 4 }],
  "summary": {
    "total_unique_dependencies": 4, "shared_dependencies_count": 3, "drift_count": 3, "in_sync_count": 0,
    "severity_counts": { "MAJOR_DRIFT": 2, "MINOR_DRIFT": 1, "INFO": 1, "IN_SYNC": 0 },
    "compatibility_risk_counts": { "CONFIRMED_BREAKING": 1, "SUSPECTED_BREAKING": 1, "UNKNOWN_IMPACT": 0, "NONE": 2 }
  },
  "drift_matrix": [
    {
      "id": "python:pydantic",
      "dependency_name": "pydantic",
      "ecosystem": "python",
      "drift_disparity": "MAJOR_DRIFT",
      "compatibility_risk": "CONFIRMED_BREAKING",
      "declarations_by_repo": {
        "service-a": { "declared_range": "==1.10.13", "resolved_version": null, "dep_type": "runtime", "source_file": "requirements.txt" }
      },
      "present_in_repos": ["service-a", "service-b"],
      "missing_in_repos": ["service-c"],
      "recommended_version": "2.5.0",
      "evidence": { "source_url": "https://github.com/pydantic/pydantic/releases/tag/v2.0.0", "cited_excerpt": "...", "verified_breaking": true, "notes": "" },
      "score": 90,
      "risk_level": "Critical",
      "breakdown": [{ "signal": "Major version gap", "points": 50 }],
      "confidence": 0.9,
      "signals_missing": ["lockfile"],
      "vulnerabilities": [{ "id": "GHSA-...", "summary": "...", "fixed_in": "1.2.3", "affects_repo": "service-a" }],
      "explanation": { "text": "...", "source": "template" }
    }
  ],
  "graph_summary": { "total_nodes": 7, "total_edges": 8, "density": 0.19, "highest_drift_nodes": ["axios", "pydantic"] },
  "warnings": ["..."],
  "skipped_items": ["service-a/package.json: left workspace:* (unsupported spec (not a registry version))"],
  "contract_analysis": [
    {
      "provider_repo": "orders-v2", "consumer_repo": "", "status": "ANALYZED", "spec_file": "docs/openapi.json",
      "message": "Compared \"Orders API v2\" 1.0.0 (orders-v1/openapi.yaml) with 2.0.0 (orders-v2/docs/openapi.json); same API by matching normalized info.title, order by info.version. ...",
      "findings": [
        { "change_type": "REMOVED_OPERATION", "path": "/orders/{id}", "method": "DELETE", "previous_value": "operation present", "new_value": "operation not present",
          "spec_file": "openapi.yaml", "json_pointer": "/paths/~1orders~1{id}/delete", "severity": "HIGH", "impact": "Potentially breaking for clients that still call this operation. ...",
          "classification": "POTENTIALLY_BREAKING", "description": "...", "spec_repository": "orders-v1" }
      ],
      "relationship": { "same_api_basis": "matching normalized info.title" },
      "baseline": { "repository": "orders-v1", "spec_file": "openapi.yaml", "version": "1.0.0", "title": "Orders API" },
      "candidate": { "repository": "orders-v2", "spec_file": "docs/openapi.json", "version": "2.0.0", "title": "Orders API v2" }
    }
  ],
  "code_impact": [
    { "repository": "service-a", "file": "models/user.py", "line": 7, "snippet": "...", "related_change": "...", "dependency_name": "pydantic", "impact": "Tier 2 verified rule: ...", "confidence": "high", "limitations": "..." }
  ],
  "data_sources": [{ "name": "GitHub", "status": "ok" }],
  "repository_details": [{ "name": "service-a", "kind": "github", "ref": "main", "commit": "...", "manifests": ["requirements.txt"], "code_scanned": true, "error": null }]
}
```

Notes on fields:

- `ecosystem` is `npm`, `python` or `maven`. Maven names are `groupId:artifactId`.
- `resolved_version` is the lockfile pin, or `null` when there is no lockfile entry. It is never derived from the declared range.
- `drift_disparity`: `MAJOR_DRIFT`, `MINOR_DRIFT`, `IN_SYNC` (every repository that uses the package agrees), `INFO` (used by one repository, or the difference could not be resolved).
- `compatibility_risk`: `CONFIRMED_BREAKING`, `SUSPECTED_BREAKING`, `UNKNOWN_IMPACT`, `NONE`.
- `evidence` is `null` when no matching release-note line was found. `evidence.notes` holds AI-written text only, and is empty without a Gemini key.
- `score`, `risk_level`, `breakdown`, `confidence`, `signals_missing`, `vulnerabilities` and `explanation` are present only on drifted packages.
- `code_impact` is `null` when no code scan ran (it is off, or every target was pasted).
- `contract_analysis` is `null` when no contract analysis was performed (`options.check_contracts` is false, or no GitHub repository could be read). Otherwise it is a list; see "Contract analysis" below.
- `data_sources[].status` is `ok`, `degraded`, `failed`, `not_used` or `not_configured`.
- `signals_missing` keys: `registry`, `lockfile`, `resolved_version`, `range_overlap`, `changelog`, `vulnerabilities`, `code_scan`, `import_mapping`.

## Contract analysis

Implemented in `backend/app/services/openapi_diff_engine.py`. Request option: `options.check_contracts` (default `true`).

**Discovery.** The file tree already listed for manifests is searched for `openapi` or `swagger` `.json`, `.yaml`, `.yml` files at the repository root and under `docs/`, `api/`, `spec/`, `specs/` and `src/` (up to five levels deep, at most 4 files of 2 MB per repository). Only those files are downloaded. OpenAPI 3.x and Swagger 2.0 are parsed with `json` and `yaml.safe_load`. Pasted targets carry manifests only, so they never have a specification.

**Entries.** Every entry has `provider_repo`, `consumer_repo`, `status`, `spec_file`, `message` and `findings`.

| `status` | `consumer_repo` | Meaning |
| --- | --- | --- |
| `ANALYZED` | empty | Two versions of the same API were compared. `provider_repo` holds the newer one; `baseline` and `candidate` name both files. `findings` lists every change. |
| `ANALYZED` | set | That repository's source code references endpoints of the changed API. `findings` holds only the changes on endpoints it references, and may be empty. |
| `RELATIONSHIP_UNVERIFIED` | empty | The specification is the same API as another one, or might be, but identity or version order could not be established. Nothing was compared. |
| `RELATIONSHIP_UNVERIFIED` | set | No reference to the API was found in that repository, or its source could not be scanned. It is not known to be a consumer and not ruled out. |
| `NOT_COMPARED` | empty | A valid specification with no other version of the same API in this scan. |
| `SPEC_UNAVAILABLE` | empty | No specification was found, or it could not be downloaded. |
| `MALFORMED_SPEC` | empty | A specification file was found and could not be parsed. |

**Findings.** `change_type` is `REMOVED_PATH`, `REMOVED_OPERATION`, `NEW_REQUIRED_REQUEST_FIELD` or `CHANGED_RESPONSE_FIELD_TYPE`. `previous_value` and `new_value` are the before and after evidence. `spec_file` and `json_pointer` (RFC 6901) locate that evidence; for a removal they point into the baseline file, named by `spec_repository`. `severity` is `HIGH` or `MEDIUM`, a fixed value per change type. Additive fields: `classification` and, on consumer entries, `consumer_references` (`repository`, `file`, `line`, `snippet`, `match`).

**Four levels of claim, kept apart.**

1. A detected schema change: every finding is a difference between two files.
2. A potentially breaking change: `classification: "POTENTIALLY_BREAKING"`. Only the three kinds above are reported; additive changes are ignored.
3. Evidence that a consumer references the endpoint: `classification: "CONSUMER_REFERENCE_FOUND"` with file and line.
4. A confirmed runtime failure: never reported. Static analysis cannot establish it.

**When two specifications are compared.** Both conditions must hold:

- Same API: both declare the same `x-api-id` or `x-service-id` (in `info` or at the root), or their `info.title` values match exactly after normalization (case, punctuation and a trailing version tag such as ` v2` are dropped). Framework default titles such as `FastAPI`, `API` or `OpenAPI definition` never establish identity. Shared paths are never used.
- Version order: both `info.version` values parse as versions (PEP 440, an optional leading `v`, or `YYYY-MM-DD`) and differ. The lower one is the baseline. Submission order is never used. With three or more versions, adjacent versions are compared.

Anything else is reported as `RELATIONSHIP_UNVERIFIED` or `NOT_COMPARED` with the reason in `message`.

**Consumer references.** Only when a comparison found changes, the other GitHub repositories' source archives are searched (reusing the code-scan download) for quoted string literals that match a path template of the API, for example `` `${BASE}/orders/${id}` ``. Comment lines and server route declarations (`app.get(...)`, `@router.get(...)`, `@GetMapping`) are skipped. The text before the path may only be a placeholder, a scheme and host, or a base path the specification declares.

**Known limitations.**

- Identity by title is a heuristic. Two different APIs with the same specific title would be compared; add `x-api-id` to be exact. Two versions of one API with different titles and no id are not compared.
- Only the default branch (or the requested ref) of each repository is read. Two versions of an API in the history of one repository are not compared; two specification files in one repository are.
- A specification outside the listed folders or with another file name is not found. External `$ref` targets are not fetched, and `oneOf` / `anyOf` schemas are not compared; both produce no finding rather than a guess.
- Not reported: removed response fields, enum changes, format changes, status code changes, security scheme changes, media type changes.
- Consumer matching is textual. It cannot tell which host a call goes to, so a repository that calls a different service with the same path is reported as referencing the endpoint. `/health`, `/status` and similar universal paths are never counted. URLs built in ways other than a literal or a simple concatenation, calls under an undeclared base path, and languages outside `.py`, `.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.java` are missed.
- A repository that holds a specification of the API is not checked as its consumer.
- A consumer with no finding is not proven unaffected, and a consumer with a finding is not proven broken.
