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
| `ANALYZED` | set | That repository's source code calls endpoints of the changed API, and the calls are tied to this API by a server host or a naming signal (`relationship.consumer_evidence`). `findings` holds only the changes on endpoints it references, and may be empty. |
| `RELATIONSHIP_UNVERIFIED` | empty | The specification is the same API as another one, or might be, but identity or version order could not be established. Nothing was compared. |
| `RELATIONSHIP_UNVERIFIED` | set | No reference to the API was found in that repository, its source could not be scanned, or it only contains paths the API shares with other services and nothing ties them to this API (listed in `possible_references`). When the provider's server host is written somewhere in the repository but not on those calls, it is reported in `relationship.candidate_evidence`. It is not known to be a consumer and not ruled out. |
| `UNRESOLVED` | set | That repository builds request URLs at runtime from a base URL that carries a signal for this API (`f"{BILLING_URL}{path}"`, `BILLING_URL + path`, `urljoin(BILLING_URL, ...)`). No operation could be matched or excluded. The signal is listed in `relationship.candidate_evidence` and the call sites in `dynamic_urls`; it is a candidate, not an established relationship. |
| `NOT_COMPARED` | empty | A valid specification with no other version of the same API in this scan. |
| `SPEC_UNAVAILABLE` | empty | No specification was found, or it could not be downloaded. |
| `MALFORMED_SPEC` | empty | A specification file was found and could not be parsed. |

**Findings.** Every finding also names the changed element in a structured form: `field` (`customer.legacy_id`, `[].amount`, a parameter name, or empty for a removed operation) and `field_in` (`response_body`, `request_body`, `query`, `header`). `change_type` is `REMOVED_PATH`, `REMOVED_OPERATION`, `NEW_REQUIRED_REQUEST_FIELD` or `CHANGED_RESPONSE_FIELD_TYPE`. `previous_value` and `new_value` are the before and after evidence. `spec_file` and `json_pointer` (RFC 6901) locate that evidence; for a removal they point into the baseline file, named by `spec_repository`. `severity` is `HIGH` or `MEDIUM`, a fixed value per change type. Additive fields: `classification` and, on consumer entries, `consumer_references` (`repository`, `file`, `line`, `snippet`, `match`), where `match` is `exact` or `concatenated`.

**Evidence tiers.** Every finding has an `evidence_tier`. For an analyzed or unresolved consumer (`status` `ANALYZED` or `UNRESOLVED` with a `consumer_repo`) the entry also has `consumer_impact`: one row per change of the comparison, so that changes with no evidence are visible too.

| `evidence_tier` | Meaning | What it does not mean |
| --- | --- | --- |
| `T0_DETECTED` | A difference between two specification files. Used on specification-level entries. | Nothing about any consumer. |
| `T1_OPERATION_MATCH` | Consumer code calls the changed operation, with an HTTP method the call itself states. | That the consumer reads or sends the changed field. |
| `T2_FIELD_MATCH` | Consumer code uses the changed field itself; `usage` says how. | That anything fails at runtime. |
| `UNRESOLVED` | The code, the client configuration, the HTTP method or the URL could not be established; `explanation` says which and why. | That the consumer is unaffected, or that it is affected. |
| `NO_USAGE_FOUND` | No call to the operation was found in the inspected files. | That the consumer is unaffected. |

A repository whose relationship to the provider cannot be established keeps the entry status `RELATIONSHIP_UNVERIFIED` and gets no rows.

`usage` values: `CALLS_OPERATION` (a removed operation is called), `READS_CHANGED_FIELD`, `FIELD_NOT_READ` (the operation is called and no read of the field was found in the code that was followed), `OMITS_REQUIRED_FIELD` (the request, including the client configuration that could be read, lacks the value), `SENDS_REQUIRED_FIELD` (the request is seen to include it on every path, so it is listed in `consumer_impact` but not in `findings`), `MAY_SEND_REQUIRED_FIELD` (the value is set only under a condition, so a request without it is possible), `NOT_DETERMINED`, `NO_USAGE_FOUND`.

A `consumer_impact` row has `change_type`, `method`, `path`, `field`, `field_in`, `previous_value`, `new_value`, `evidence_tier`, `usage`, `repository`, `file`, `line`, `snippet` and `explanation`. `file` is empty and `line` is `null` when there is no source location. Findings of a consumer entry carry the same tier fields plus `source_file` and `source_line`.

```json
{ "change_type": "CHANGED_RESPONSE_FIELD_TYPE", "method": "GET", "path": "/orders/{orderId}", "field": "id", "field_in": "response_body",
  "previous_value": "200 response field id: integer", "new_value": "200 response field id: string",
  "evidence_tier": "T2_FIELD_MATCH", "usage": "READS_CHANGED_FIELD", "repository": "checkout",
  "file": "src/checkout.js", "line": 7, "snippet": "return String(res.data.id).padStart(8, '0')",
  "explanation": "The code reads response field 'id', whose type changed." }
```

**Four levels of claim, kept apart.**

1. A detected schema change: every finding is a difference between two files.
2. A potentially breaking change: `classification: "POTENTIALLY_BREAKING"`. Only the three kinds above are reported; additive changes are ignored.
3. Evidence that a consumer references the endpoint: `classification: "CONSUMER_REFERENCE_FOUND"` with file and line.
4. A confirmed runtime failure: never reported. Static analysis cannot establish it.

**When two specifications are compared.** Both conditions must hold:

- Same API: both declare the same `x-api-id` or `x-service-id` (in `info` or at the root), or their `info.title` values match exactly after normalization (case, punctuation and a trailing version tag such as ` v2` are dropped). Framework default titles such as `FastAPI`, `API` or `OpenAPI definition` never establish identity. Shared paths are never used.
- Version order: both `info.version` values parse as versions (PEP 440, an optional leading `v`, or `YYYY-MM-DD`) and differ. The lower one is the baseline. Submission order is never used. With three or more versions, adjacent versions are compared.

Anything else is reported as `RELATIONSHIP_UNVERIFIED` or `NOT_COMPARED` with the reason in `message`.

**Consumer references.** Only when a comparison found changes, the other GitHub repositories' source archives are searched (reusing the code-scan download). Three questions are answered separately:

1. *Is a string literal a path of the API?* The whole literal must be the path. `/orders/123/items` matches `/orders/{id}/items` and never `/orders` or `/orders/{id}`. A trailing slash, a query string and template placeholders (`${id}`, `{id}`, `%s`, `:id`) are accepted. String concatenation is read as one path, so `"/orders/" + id + "/items"` is `/orders/{id}/items`. Before the path only a base-URL placeholder, a scheme and host, or a base path the specification declares may appear; `/internal/${tenant}/orders` is not `/orders`. Comment lines and server route declarations (`app.get(...)`, `@router.get(...)`, `@GetMapping`) are skipped.
2. *Which HTTP method does the call send?* Only the invocation that receives the literal is read: its name (`axios.post(...)`, `requests.delete(...)`, `postForObject(...)`) or a method named inside its own parentheses (`fetch(url, { method: 'POST' })`, `requests.request("PUT", url)`). `fetch(url)` with no options is a GET. Neighbouring statements, comments and log messages are never read. When the method cannot be determined, the reference counts for every method of that path.
3. *Is the call addressed to this provider?* A path match alone never is. A reference is attributed only with a signal: a server host from the specification (`servers[].url`, Swagger `host`) in the URL, or a name containing a distinctive word of the API's title, id or repository (`ORDERS_API_URL`, `ordersClient.get(...)`). Names are followed one assignment back in the same file. The signals found are returned in `relationship.consumer_evidence`. References without a signal produce no finding and are listed in `possible_references`; if a repository has only those, the entry is `RELATIONSHIP_UNVERIFIED`.

**Field-level usage.** Implemented in `backend/app/services/consumer_usage.py`. Source is parsed, never executed: Python with the standard `ast` module, JavaScript, JSX, TypeScript and TSX with tree-sitter. Starting from a call that was already attributed to the provider, it extracts:

| | Python | JavaScript / TypeScript |
| --- | --- | --- |
| Response reads | `response.json()["customer"]["legacy_id"]`, `.get("status")`, `json.loads(response.text)`, variables assigned from these, `with ... as response`, `for item in data`, comprehensions | `res.data.customer.legacy_id` (axios), `(await res.json()).customer`, `res["data"]["customer"]`, optional chaining, object and array destructuring with renames and defaults, `.then(...)` chains, `for...of`, `map` / `filter` / `find` / `forEach` callbacks, `JSON.parse(await res.text())` |
| Request body | `json=` / `data=` dict literals, `dict(...)`, `json.dumps(...)`, a variable built in the same function (including `payload["k"] = v` and `.update({...})`), a local function that returns a literal | `axios.post(url, {...})`, `fetch(url, { body: JSON.stringify({...}) })`, `axios({ data })`, shorthand properties, a variable built in the same function, a local function that returns a literal |
| Query | `params={...}`, keys in the URL string | `{ params: {...} }`, keys in the URL string |
| Headers | `headers={...}` | `{ headers: {...} }` |

**Which function a call reaches.** A response returned from a function is followed to its callers, and a response passed as an argument is followed into the function that receives it, at most two functions deep. A call is followed only when the source establishes where it goes. A matching name is never enough.

| Followed | Not followed (reported as `UNRESOLVED` with the reason) |
| --- | --- |
| A function defined in the same file or an enclosing function | A name that is neither defined in the file nor imported from an inspected file |
| A function imported from an inspected file: `from store import keep`, `import { keep } from './store'`, a default import, `import * as store from './store'`, `require('./store')` | A function imported from a package or through a path alias (`'some-library'`, `'@/lib/store'`) |
| `self.method()` / `this.method()` inside the same class | A method on any other object: `this.cache.store(x)`, `crm.fetch_customer()` |
| A method on an object constructed in the same file or function: `billing = Billing()`, `const store = new Store()` | A method on a parameter, an attribute, or an injected object |
| A React `useState` setter, inside the component that declares it | The same setter name in another component |

**What a request sends.** A value missing from the immediate call arguments is not proof that the request lacks it, so `OMITS_REQUIRED_FIELD` is reported only when the client is fully visible:

- `requests.get(...)`, `httpx.post(...)` and `fetch(...)` have no shared configuration.
- A `requests.Session()` / `httpx.Client(...)` created in the same file is read: constructor `params` and `headers`, `session.params = {...}`, `session.params.update({...})`, `session.params["k"] = v`. Hooks, auth and transports make the result `UNRESOLVED`.
- The axios library object and an instance made with `axios.create({...})` are read: literal `params`, `headers` and `data`, `X.defaults.params = {...}`, and request interceptors registered anywhere in the repository. A value an interceptor adds is counted. A value that is absent while an interceptor exists is `UNRESOLVED`, because the interceptor may add or change it.
- Any other object (`self._client`, `this.http`, a parameter, an imported SDK) is `UNRESOLVED`: its defaults are not visible. A value the call itself sends is still reported as sent.
- A value set under a condition before the request (`if c: payload["currency"] = c`) is `MAY_SEND_REQUIRED_FIELD`. A value set in the other branch, or after the request, does not count.

**Which HTTP method a call uses.** Only what the call states: its name (`axios.delete`, `requests.post`), a literal `method` in its own options, `requests.request("PUT", ...)`, or `fetch(url)` with no options, which is a GET. A URL assigned to a variable is followed to the call that receives it in the same function. When the method cannot be told (`client.send(url)`, `fetch(url, options)`), a change that applies to one method is `UNRESOLVED`; it is not a call to that operation and not an absence of usage. A removed path, where every method is gone, does not need the method.

The result is also `UNRESOLVED`, with the reason, whenever a value leaves what was followed: a key computed at runtime, `**mapping` or `...spread`, a payload or options object that comes from a parameter, a value stored on an object, a variable assigned more than once, a URL passed through a helper that may add query parameters, a file that does not parse, or a language other than the ones above. A newly required header is resolved only when the call or a readable client sets it.

**Evaluation: changed-element usage detection.** `backend/tests/fixtures/contract_eval` holds a provider in two versions, 29 small consumer repositories and `expected.json`, a reviewed expected result for each of the 174 (consumer, change) cases. Run it with:

```bash
cd backend && python scripts/evaluate_contract_impact.py
```

What is measured is whether the tool detects that a consumer's own code *uses* a changed element: it reads the changed response field, calls the removed operation, or makes a request that lacks the newly required value on some path. That is the meaning of `uses_changed_element` in `expected.json`.

It is not a breakage metric. A consumer that reads a field whose type changed and copes with both types counts as usage. The reported precision is therefore not "breaking-impact precision" or "compatibility precision", and it is no evidence that runtime breakage is predicted correctly. A breakage metric would need separate ground truth about actual breakage, which does not exist in this repository.

A case counts as detected only when the tool asserts it (`T2_FIELD_MATCH` with a read or an omission, or a known-method call to a removed operation). Real usage that ends as `UNRESOLVED` or `MAY_SEND_REQUIRED_FIELD` counts against recall.

Current result on these fixtures: usage asserted and real 12, asserted but not real 0, real but not asserted 5. Usage-detection precision is 1.000 (target 0.90, met) and usage-detection recall is 0.706 (target 0.80, not met). The five misses are a field read through a computed key, three request URLs built at runtime, and a field set only under a condition. The script exits non-zero when a case differs from its reviewed expected result; `--strict` also fails on a missed target. The fixtures are small, hand-written and written by the authors of the tool, so the numbers describe them and not arbitrary repositories.

**Known limitations.**

- Identity by title is a heuristic. Two different APIs with the same specific title would be compared; add `x-api-id` to be exact. Two versions of one API with different titles and no id are not compared.
- Only the default branch (or the requested ref) of each repository is read. Two versions of an API in the history of one repository are not compared; two specification files in one repository are.
- A specification outside the listed folders or with another file name is not found. External `$ref` targets are not fetched, and `oneOf` / `anyOf` schemas are not compared; both produce no finding rather than a guess.
- Not reported: removed response fields, enum changes, format changes, status code changes, security scheme changes, media type changes.
- Consumer matching is textual and conservative. A genuine consumer whose base URL comes from an unnamed variable (`${API}/orders`), from another file, or from more than one assignment away is reported as unverified, not as a consumer. A naming signal is a heuristic: a variable named after a different service with the same word would be accepted. URLs built in ways other than a literal or a `+` concatenation on one line, calls under an undeclared base path, and languages outside `.py`, `.js`, `.ts`, `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.java` are missed. `/health`, `/status` and similar universal paths are never counted.
- A repository that holds a specification of the API is not checked as its consumer.
- Field-level usage is followed within one function and two functions around it, along call edges the source establishes. Values that travel through injected objects, class attributes, stores, queues, package imports, path aliases, dependency injection or framework state other than React `useState` end as `UNRESOLVED`. Most real API clients are written this way, so `UNRESOLVED` is the common result on real repositories.
- A request URL that is a base URL plus a runtime path (`BILLING_URL + path`, a `get_json(path)` helper, a client with a configured `base_url`) is `UNRESOLVED` or unverified even when the path is a literal at the call site, because the path is not followed into the helper.
- The provider relationship still rests on a server host or a naming signal on the call. A base URL configured in a settings file, an environment file or a framework configuration is two steps away from the call and is reported only as a candidate. A variable that merely contains a word of the API's name (`billingAddress`) is accepted as a naming signal.
- Client configuration is read only for `requests`, `httpx`, `fetch` and axios. Interceptors and defaults are read where they are literal; middleware, proxies, gateways and server-side defaults are never visible, so `OMITS_REQUIRED_FIELD` describes the request as written, not as received.
- `MAY_SEND_REQUIRED_FIELD` and conditions are judged structurally (same block, same branch, before the request). Loops, early returns and exceptions are not modelled.
- A read is matched by field path, ignoring array positions. A consumer that reads the field and handles both types correctly is still reported as reading it.
- When a call's HTTP method is unknown, changes that apply to one method are `UNRESOLVED` for that call.
- Java consumers are matched at operation level only; field usage is `UNRESOLVED` for them.
- A consumer with no finding is not proven unaffected, and a consumer with a finding is not proven broken.

## Rollout planner

`POST /api/v1/rollout` compares deployment order for one provider and one consumer. It is synchronous: one request, one answer. Implemented in `backend/app/services/rollout_planner.py`; the frontend page is at `/rollout`.

```json
{
  "provider": { "url": "https://github.com/owner/provider", "current_ref": "v1.4.0", "proposed_ref": "v2.0.0" },
  "consumer": { "url": "https://github.com/owner/consumer", "current_ref": "main", "proposed_ref": "feature/use-v2" }
}
```

`current_ref` is what is deployed (P0, C0) and `proposed_ref` what is about to be released (P1, C1). Each is a branch, tag or commit. URLs are plain repository URLs, without `/tree/`. Every ref is resolved to a commit and everything is read at that commit.

The response has `recommendation` (`PROVIDER_FIRST`, `CONSUMER_FIRST`, `EITHER`, `NEITHER`, `UNRESOLVED`), `summary`, `refs` (the four refs with repository, ref, commit, specification file or number of source files, and `problem` when a ref could not be read), three states (`provider_first`: P1 with C0; `consumer_first`: P0 with C1; `final`: P1 with C1, informational), `contract_changes`, `unresolved` and `limitations`. Each state has `status` (`COMPATIBLE`, `INCOMPATIBLE`, `UNKNOWN`), `reason`, `evidence` and `unresolved`.

`contract_changes[].direction` is `P0_TO_P1` (what P1 no longer accepts or returns; it matters while the consumer is still C0) or `P1_TO_P0` (what P1 offers that P0 does not; it matters while the provider is still P0).

Rules:

- A state is `INCOMPATIBLE` only on a demonstrated problem: the consumer code calls an operation the provider in that state does not define, or sends a request without a value that provider requires.
- A state is `COMPATIBLE` only on positive evidence: no contract change that could affect it was detected, or every detected change is seen to be satisfied at every call site.
- Everything else is `UNKNOWN`: no call found, a call that could not be followed, a field that is read after its type changed, a value sent to a provider version that does not define it, a ref that could not be fetched, a specification that could not be parsed.
- An order is recommended only when its own intermediate state is `COMPATIBLE`. `NEITHER` needs two demonstrated incompatibilities. Every other combination is `UNRESOLVED`.

Errors: `400 INVALID_TARGETS` for a URL that is not a GitHub repository URL, `400 INVALID_REQUEST` for a missing field or an empty ref, `401 SIGN_IN_REQUIRED` when the backend requires sign-in. A ref that cannot be fetched is not an error: the answer is `200` with the affected states `UNKNOWN`.

Limits: "compatible" covers only the three kinds of contract change that are detected. The consumer is taken to call this provider because the request says so, and calls are matched by path. Nothing is executed.
