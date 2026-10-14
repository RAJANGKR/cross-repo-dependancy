/**
 * Types for the DriftLock scan API, following docs/API_CONTRACT.md and
 * docs/DATA_MODEL.md. They describe a record AFTER `parseScan`, so arrays are
 * always present and anything the backend left out is `null`, never a guess.
 *
 * Enum-like fields are typed as `string`: the known values are listed below,
 * and an unrecognized value from a newer backend is displayed as is instead of
 * being coerced into one of ours.
 */

export const SCAN_STATUSES = ['QUEUED', 'FETCHING', 'PARSING', 'ANALYZING', 'COMPLETED', 'FAILED'] as const
export type KnownScanStatus = (typeof SCAN_STATUSES)[number]
/** The four in-progress stages, in order. */
export const SCAN_STAGES = ['QUEUED', 'FETCHING', 'PARSING', 'ANALYZING'] as const

export const DRIFT_DISPARITIES = ['MAJOR_DRIFT', 'MINOR_DRIFT', 'INFO', 'IN_SYNC'] as const
export const COMPATIBILITY_RISKS = ['CONFIRMED_BREAKING', 'SUSPECTED_BREAKING', 'UNKNOWN_IMPACT', 'NONE'] as const
export const CONTRACT_STATES = ['ANALYZED', 'SPEC_UNAVAILABLE', 'MALFORMED_SPEC', 'RELATIONSHIP_UNVERIFIED', 'NOT_COMPARED', 'UNRESOLVED'] as const
/**
 * How much evidence stands behind a contract change, weakest first. None of
 * them is a runtime observation, and NO_USAGE_FOUND is not a statement of safety.
 */
export const EVIDENCE_TIERS = ['T0_DETECTED', 'POSSIBLE_REFERENCE', 'T1_OPERATION_MATCH', 'T2_FIELD_MATCH', 'NO_USAGE_FOUND', 'UNRESOLVED'] as const
export const FIELD_USAGES = [
  'CALLS_OPERATION',
  'READS_CHANGED_FIELD',
  'FIELD_NOT_READ',
  'OMITS_REQUIRED_FIELD',
  'SENDS_REQUIRED_FIELD',
  'MAY_SEND_REQUIRED_FIELD',
  'NOT_DETERMINED',
  'NO_USAGE_FOUND',
] as const

// ---- Request ---------------------------------------------------------------

export const MANIFEST_FILENAMES = [
  'package.json',
  'package-lock.json',
  'requirements.txt',
  'pyproject.toml',
  'poetry.lock',
  'pom.xml',
] as const
export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number]

export interface PastedFile {
  filename: ManifestFilename
  content: string
}

export type RepositoryTarget =
  | {
      type: 'github'
      url: string
      /** Branch, tag or commit. Omitted to let the backend use its default. */
      ref?: string
    }
  | { type: 'pasted'; name: string; files: PastedFile[] }

export interface ScanCreateRequest {
  repository_targets: RepositoryTarget[]
}

// ---- Responses -------------------------------------------------------------

export interface ScanAccepted {
  scan_id: string
  status: string
  poll_url: string | null
}

export interface ScanProgress {
  stage: string
  percentage: number | null
  current_action: string
}

export interface RepositorySummary {
  name: string
  url: string | null
  manifest_count: number | null
  total_dependencies: number | null
}

export interface ScanMetrics {
  total_unique_dependencies: number | null
  shared_dependencies_count: number | null
  drift_count: number | null
  in_sync_count: number | null
  /** Keyed by drift disparity. `null` when the backend sent no breakdown. */
  severity_counts: Record<string, number> | null
  /** Keyed by compatibility risk. `null` when the backend sent no breakdown. */
  compatibility_risk_counts: Record<string, number> | null
}

export interface RepoDeclaration {
  declared_range: string
  /** Lockfile pin. `null` means no resolved version was available. */
  resolved_version: string | null
  dep_type: string
  source_file: string
}

export interface ChangelogEvidence {
  source_url: string | null
  cited_excerpt: string
  verified_breaking: boolean
  /** LLM interpretation of the excerpt. Shown as AI-generated, never as fact. */
  notes: string
}

export interface DependencyDrift {
  /** `${ecosystem}:${dependency_name}`, unique within a result. */
  id: string
  dependency_name: string
  ecosystem: string
  drift_disparity: string
  compatibility_risk: string
  declarations_by_repo: Record<string, RepoDeclaration>
  present_in_repos: string[]
  missing_in_repos: string[]
  recommended_version: string | null
  evidence: ChangelogEvidence | null
  // Additive fields from the DriftLock backend. Each is null (or empty) when
  // the backend did not send it, and the UI then shows nothing for it.
  /** Deterministic 0 to 100 score. A secondary signal next to the classifications. */
  score: number | null
  /** Low | Medium | High | Critical, derived from the score by the backend. */
  risk_level: string | null
  breakdown: ScoreItem[]
  /** Heuristic 0 to 1: how much evidence was available. Not accuracy. */
  confidence: number | null
  signals_missing: string[]
  vulnerabilities: Vulnerability[]
  explanation: Explanation | null
}

export interface ScoreItem {
  signal: string
  points: number
}

export interface Vulnerability {
  id: string
  summary: string
  affects_repo: string
  fixed_in: string | null
}

export interface Explanation {
  text: string
  source: 'ai' | 'template'
}

export interface DataSource {
  name: string
  status: string
}

export interface RepositoryDetail {
  name: string
  kind: string
  ref: string | null
  commit: string | null
  manifests: string[]
  code_scanned: boolean
  error: string | null
}

export interface GraphSummary {
  total_nodes: number | null
  total_edges: number | null
  density: number | null
  highest_drift_nodes: string[]
}

/**
 * One change between two versions of the same API, as returned by
 * backend/app/services/openapi_diff_engine.py (docs/API_CONTRACT.md,
 * "Contract analysis"). A finding is a difference between two specification
 * files. It is potentially breaking; it is never a confirmed runtime failure.
 * The optional fields are filled by `parseScan` for every live result; they
 * are optional only so that older saved records still type-check.
 */
export interface ContractFinding {
  change_type: string
  path: string
  method: string
  previous_value: string
  new_value: string
  spec_file: string
  json_pointer: string
  severity: string
  impact: string
  /** Evidence tier for this finding; see EVIDENCE_TIERS. Empty when the backend sent none. */
  evidence_tier?: string
  /** The changed element, for example `customer.legacy_id`, `[].amount` or a parameter name. */
  field?: string
  /** Where the element lives: `response_body`, `request_body`, `query`, `header`. */
  field_in?: string
  /** What the consumer code does with it; see FIELD_USAGES. */
  usage?: string
  /** Why this tier was assigned, including what could not be determined. */
  explanation?: string
  /** Consumer source location of the decisive evidence. */
  source_file?: string
  source_line?: number | null
}

/** One contract change as seen from one consumer repository. */
export interface ContractImpactRow {
  change_type: string
  method: string
  path: string
  field: string
  field_in: string
  previous_value: string
  new_value: string
  evidence_tier: string
  usage: string
  repository: string
  /** Empty when there is no source location (NO_USAGE_FOUND). */
  file: string
  line: number | null
  snippet: string
  explanation: string
}

/** A place in a consumer's source code that matches a path of the API. */
export interface ContractReference {
  repository: string
  file: string
  line: number | null
  snippet: string
  /** The API path the string matches. Empty when the row it belongs to already names it. */
  path: string
  /** What that call was seen to do with the changed element; see FIELD_USAGES. Empty in a plain list of references. */
  usage: string
}

/**
 * One contract change as seen from the possible references of a consumer whose
 * relationship to the API is unverified. `evidence_tier` is POSSIBLE_REFERENCE
 * or NO_USAGE_FOUND. A candidate, never a finding.
 */
export interface ContractCandidateRow extends ContractImpactRow {
  references: ContractReference[]
}

/** A sign that the repository may talk to the provider. It ties no particular call to it. */
export interface ContractCandidateSignal {
  signal: string
  file: string
  line: number | null
}

/**
 * One row of contract analysis. With an empty `consumer_repo` it describes a
 * repository's specification: compared against an older version (ANALYZED),
 * or why it was not. With a `consumer_repo` it describes whether that
 * repository's source code references the changed API.
 */
export interface ContractAnalysisEntry {
  /** The repository holding the specification (the newer one when compared). */
  provider_repo: string
  consumer_repo: string
  status: string
  spec_file: string
  message: string
  findings: ContractFinding[]
  /** For an analyzed consumer: every change of the comparison with its evidence tier. */
  consumer_impact?: ContractImpactRow[]
  /** For an unverified consumer: what its possible references do with each change. Candidates, not findings. */
  candidate_impact?: ContractCandidateRow[]
  /** Strings matching a path of the API that nothing ties to it. The backend lists at most ten. */
  possible_references?: ContractReference[]
  /** Signs that the repository may use the provider, short of a verified relationship. */
  candidate_evidence?: ContractCandidateSignal[]
  /** Requests whose path is only known at runtime, so no operation could be matched or excluded. */
  dynamic_urls?: ContractReference[]
}

export interface CodeImpactItem {
  repository: string
  file: string
  line: number | null
  snippet: string
  /** The dependency or contract change this call site is tied to. */
  related_change: string
  dependency_name: string
  impact: string
  confidence: string
  limitations: string
}

export interface ScanResult {
  scanned_repositories: RepositorySummary[]
  summary: ScanMetrics | null
  drift_matrix: DependencyDrift[]
  graph_summary: GraphSummary | null
  warnings: string[]
  skipped_items: string[]
  /** `null` until the backend returns contract analysis. */
  contract_analysis: ContractAnalysisEntry[] | null
  /** `null` until the backend returns call-site analysis. */
  code_impact: CodeImpactItem[] | null
  /** Upstream services used by this scan and how each one answered. */
  data_sources: DataSource[]
  /** Per-target detail: resolved branch, commit, manifests read. */
  repository_details: RepositoryDetail[]
}

export interface ScanError {
  error_code: string
  message: string
}

export interface ScanRecord {
  scan_id: string
  status: string
  created_at: string | null
  updated_at: string | null
  completed_at: string | null
  duration_seconds: number | null
  progress: ScanProgress | null
  result: ScanResult | null
  error: ScanError | null
}

export interface Health {
  status: string
}
