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
export const CONTRACT_STATES = ['ANALYZED', 'SPEC_UNAVAILABLE', 'MALFORMED_SPEC'] as const

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
 * PROVISIONAL. The backend does not return OpenAPI contract analysis yet and
 * docs/API_CONTRACT.md does not define it. These field names are this
 * frontend's best reading of the feature brief; align them with the backend
 * schema when it lands. The section renders only when the data is present.
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
}

export interface ContractAnalysisEntry {
  provider_repo: string
  consumer_repo: string
  status: string
  spec_file: string
  message: string
  findings: ContractFinding[]
}

/** PROVISIONAL, same caveat as `ContractAnalysisEntry`. */
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
