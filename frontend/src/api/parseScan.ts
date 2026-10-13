import type {
  ChangelogEvidence,
  CodeImpactItem,
  ContractAnalysisEntry,
  ContractFinding,
  DependencyDrift,
  GraphSummary,
  RepoDeclaration,
  RepositorySummary,
  ScanAccepted,
  ScanMetrics,
  ScanProgress,
  ScanRecord,
  ScanResult,
} from './scanTypes'

/** Thrown when a response is too far from the contract to show honestly. */
export class ScanShapeError extends Error {
  constructor(path: string) {
    super(`Response does not match the scan contract at "${path}"`)
    this.name = 'ScanShapeError'
  }
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** Text for values that may arrive as a string, number or boolean. */
function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function counts(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null
  const result: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    const count = num(raw)
    if (count !== null) result[key] = count
  }
  return result
}

function parseProgress(raw: unknown): ScanProgress | null {
  if (!isRecord(raw)) return null
  return { stage: str(raw.stage), percentage: num(raw.percentage), current_action: str(raw.current_action) }
}

function parseRepository(raw: Rec): RepositorySummary {
  return {
    name: str(raw.name),
    url: strOrNull(raw.url),
    manifest_count: num(raw.manifest_count),
    total_dependencies: num(raw.total_dependencies),
  }
}

function parseMetrics(raw: unknown): ScanMetrics | null {
  if (!isRecord(raw)) return null
  return {
    total_unique_dependencies: num(raw.total_unique_dependencies),
    shared_dependencies_count: num(raw.shared_dependencies_count),
    drift_count: num(raw.drift_count),
    in_sync_count: num(raw.in_sync_count),
    severity_counts: counts(raw.severity_counts),
    compatibility_risk_counts: counts(raw.compatibility_risk_counts),
  }
}

function parseDeclaration(raw: Rec): RepoDeclaration {
  return {
    declared_range: str(raw.declared_range),
    resolved_version: strOrNull(raw.resolved_version),
    dep_type: str(raw.dep_type),
    source_file: str(raw.source_file),
  }
}

function parseEvidence(raw: unknown): ChangelogEvidence | null {
  if (!isRecord(raw)) return null
  const evidence: ChangelogEvidence = {
    source_url: strOrNull(raw.source_url),
    cited_excerpt: str(raw.cited_excerpt).trim(),
    verified_breaking: raw.verified_breaking === true,
    notes: str(raw.notes).trim(),
  }
  const empty = !evidence.source_url && !evidence.cited_excerpt && !evidence.notes && !evidence.verified_breaking
  return empty ? null : evidence
}

function parseDrift(raw: Rec, index: number): DependencyDrift {
  const name = str(raw.dependency_name)
  // A row without a package name cannot be identified, so the parse fails
  // instead of showing an anonymous or silently dropped dependency.
  if (!name) throw new ScanShapeError(`result.drift_matrix[${index}].dependency_name`)
  const ecosystem = str(raw.ecosystem)

  const declarations: Record<string, RepoDeclaration> = {}
  if (isRecord(raw.declarations_by_repo)) {
    for (const [repo, declaration] of Object.entries(raw.declarations_by_repo)) {
      if (isRecord(declaration)) declarations[repo] = parseDeclaration(declaration)
    }
  }
  const present = strings(raw.present_in_repos)

  return {
    id: `${ecosystem}:${name}`,
    dependency_name: name,
    ecosystem,
    drift_disparity: str(raw.drift_disparity),
    compatibility_risk: str(raw.compatibility_risk),
    declarations_by_repo: declarations,
    present_in_repos: present.length > 0 ? present : Object.keys(declarations),
    missing_in_repos: strings(raw.missing_in_repos),
    recommended_version: strOrNull(raw.recommended_version),
    evidence: parseEvidence(raw.evidence),
  }
}

function parseGraphSummary(raw: unknown): GraphSummary | null {
  if (!isRecord(raw)) return null
  return {
    total_nodes: num(raw.total_nodes),
    total_edges: num(raw.total_edges),
    density: num(raw.density),
    highest_drift_nodes: strings(raw.highest_drift_nodes),
  }
}

function parseFinding(raw: Rec, fallbackSpec: string): ContractFinding {
  return {
    change_type: str(raw.change_type) || str(raw.type),
    path: str(raw.path),
    method: str(raw.method).toUpperCase(),
    previous_value: text(raw.previous_value ?? raw.previous),
    new_value: text(raw.new_value ?? raw.current ?? raw.new),
    spec_file: str(raw.spec_file) || fallbackSpec,
    json_pointer: str(raw.json_pointer) || str(raw.pointer),
    severity: str(raw.severity),
    impact: str(raw.impact),
  }
}

function parseContractAnalysis(raw: unknown): ContractAnalysisEntry[] | null {
  if (!Array.isArray(raw)) return null
  return records(raw).map((entry) => {
    const specFile = str(entry.spec_file)
    return {
      provider_repo: str(entry.provider_repo) || str(entry.repository),
      consumer_repo: str(entry.consumer_repo),
      status: str(entry.status),
      spec_file: specFile,
      message: str(entry.message),
      findings: records(entry.findings).map((finding) => parseFinding(finding, specFile)),
    }
  })
}

function parseCodeImpact(raw: unknown): CodeImpactItem[] | null {
  if (!Array.isArray(raw)) return null
  return records(raw).map((item) => ({
    repository: str(item.repository) || str(item.repo),
    file: str(item.file),
    line: num(item.line),
    snippet: str(item.snippet),
    related_change: str(item.related_change),
    dependency_name: str(item.dependency_name),
    impact: str(item.impact),
    confidence: text(item.confidence),
    limitations: str(item.limitations),
  }))
}

function parseSkipped(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (typeof item === 'string') return item
      if (!isRecord(item)) return ''
      const subject = str(item.name) || str(item.file) || str(item.source_file)
      const reason = str(item.reason) || str(item.message)
      return [subject, reason].filter(Boolean).join(': ')
    })
    .filter((item) => item !== '')
}

function parseResult(raw: unknown): ScanResult | null {
  if (!isRecord(raw)) return null
  const matrix = raw.drift_matrix
  if (matrix !== undefined && !Array.isArray(matrix)) throw new ScanShapeError('result.drift_matrix')
  const rows = records(matrix)
  if (Array.isArray(matrix) && rows.length !== matrix.length) throw new ScanShapeError('result.drift_matrix[]')

  return {
    scanned_repositories: records(raw.scanned_repositories).map(parseRepository),
    summary: parseMetrics(raw.summary),
    drift_matrix: rows.map(parseDrift),
    graph_summary: parseGraphSummary(raw.graph_summary),
    warnings: strings(raw.warnings),
    skipped_items: parseSkipped(raw.skipped_items),
    contract_analysis: parseContractAnalysis(raw.contract_analysis),
    code_impact: parseCodeImpact(raw.code_impact),
  }
}

/** Parses the body of `POST /api/v1/scans` (202 Accepted). */
export function parseScanAccepted(body: unknown): ScanAccepted {
  if (!isRecord(body)) throw new ScanShapeError('(root)')
  const scanId = str(body.scan_id)
  if (!scanId) throw new ScanShapeError('scan_id')
  return { scan_id: scanId, status: str(body.status) || 'QUEUED', poll_url: strOrNull(body.poll_url) }
}

/** Parses the body of `GET /api/v1/scans/{scan_id}`. */
export function parseScanRecord(body: unknown): ScanRecord {
  if (!isRecord(body)) throw new ScanShapeError('(root)')
  const scanId = str(body.scan_id)
  const status = str(body.status)
  if (!scanId) throw new ScanShapeError('scan_id')
  if (!status) throw new ScanShapeError('status')

  const error = isRecord(body.error)
    ? { error_code: str(body.error.error_code) || str(body.error.code), message: str(body.error.message) }
    : null

  return {
    scan_id: scanId,
    status,
    created_at: strOrNull(body.created_at),
    updated_at: strOrNull(body.updated_at),
    completed_at: strOrNull(body.completed_at),
    duration_seconds: num(body.duration_seconds),
    progress: parseProgress(body.progress),
    result: parseResult(body.result),
    error,
  }
}
