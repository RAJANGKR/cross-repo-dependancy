/**
 * Contract types for the DriftLock API.
 *
 * These describe the report AFTER it has passed through `parseReport`, so every
 * array is present (possibly empty) and every optional value is `null` rather
 * than `undefined`. Components can read them without further guarding.
 */

export const RISK_LEVELS = ['Low', 'Medium', 'High', 'Critical'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

export const REPORT_SOURCES = ['live', 'cache', 'demo'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]

export const GAPS = ['major', 'minor', 'patch', 'unknown'] as const
export type Gap = (typeof GAPS)[number]

export const MANIFEST_FILENAMES = ['package.json', 'requirements.txt', 'pom.xml'] as const
export type ManifestFilename = (typeof MANIFEST_FILENAMES)[number]

export type RepoOrigin = 'github' | 'pasted'
export type RepoStatus = 'ok' | 'no_manifest' | 'error'
export type CodeScanState = 'ran' | 'unavailable'

// ---- Request ---------------------------------------------------------------

export interface PastedFile {
  filename: ManifestFilename
  content: string
}

export interface PastedProject {
  project: string
  files: PastedFile[]
}

export interface AnalyzeRequest {
  repos: string[]
  pasted: PastedProject[]
}

// ---- Response --------------------------------------------------------------

export interface ReportMeta {
  source: ReportSource
  generated_at: string | null
  duration_ms: number | null
  github_rate_limit_remaining: number | null
}

export interface ReportSummary {
  repos: number
  dependencies: number
  drifts: number
  by_risk: Record<RiskLevel, number>
}

export interface RepoInfo {
  name: string
  origin: RepoOrigin
  url: string
  ref: string
  commit: string
  manifests: string[]
  status: RepoStatus
  message: string
  code_scan: CodeScanState
}

export interface GraphNode {
  id: string
  type: 'repo' | 'library'
  risk: RiskLevel | null
  drifted: boolean
}

export interface GraphEdge {
  source: string
  target: string
  version: string
  raw_spec: string
}

export interface ReportGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface DriftVersion {
  repo: string
  version: string
  raw_spec: string
  file: string
}

export interface BreakdownItem {
  signal: string
  points: number
}

export interface ChangelogEntry {
  version: string
  line: string
  url: string | null
}

export interface Vulnerability {
  id: string
  summary: string
  affects: string
}

export interface ImportMapEntry {
  repo: string
  files: number | null
  symbols: string[]
}

export interface CodeHit {
  repo: string
  file: string
  line: number | null
  snippet: string
  rule: string
  /** Backend wording, shown verbatim: "deprecated", "renamed", "removed", ... */
  status: string
  replacement: string
  tier: number | null
  rule_status: string
}

export interface CodeUsage {
  import_map: ImportMapEntry[]
  hits: CodeHit[]
  note: string | null
}

export interface DriftEvidence {
  changelog: ChangelogEntry[]
  vulnerabilities: Vulnerability[]
  code_usage: CodeUsage
}

export interface Explanation {
  text: string
  source: 'ai' | 'template'
}

export interface Drift {
  id: string
  library: string
  ecosystem: string
  versions: DriftVersion[]
  gap: Gap
  risk: RiskLevel
  score: number
  breakdown: BreakdownItem[]
  /** Heuristic 0 to 1. Not measured accuracy. `null` when the backend omits it. */
  confidence: number | null
  signals_missing: string[]
  evidence: DriftEvidence
  explanation: Explanation | null
  recommendation: string
}

export interface SkippedDependency {
  repo: string
  library: string
  raw_spec: string
  reason: string
}

export interface Report {
  meta: ReportMeta
  summary: ReportSummary
  repos: RepoInfo[]
  graph: ReportGraph
  drifts: Drift[]
  skipped: SkippedDependency[]
  warnings: string[]
}

export interface Health {
  status: string
  /** True when the answer came from mock mode rather than a backend. */
  mock: boolean
}
