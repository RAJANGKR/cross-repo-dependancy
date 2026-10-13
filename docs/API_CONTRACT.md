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
  "options": { "check_changelogs": true, "check_vulnerabilities": true, "scan_code": true, "ecosystems": ["npm", "python", "maven"] }
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
  "contract_analysis": null,
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
- `contract_analysis` is always `null`: OpenAPI analysis is not built.
- `data_sources[].status` is `ok`, `degraded`, `failed`, `not_used` or `not_configured`.
- `signals_missing` keys: `registry`, `lockfile`, `resolved_version`, `range_overlap`, `changelog`, `vulnerabilities`, `code_scan`, `import_mapping`.
