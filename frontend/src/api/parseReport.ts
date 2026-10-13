import {
  GAPS,
  REPORT_SOURCES,
  RISK_LEVELS,
  type BreakdownItem,
  type ChangelogEntry,
  type CodeHit,
  type CodeUsage,
  type Drift,
  type DriftVersion,
  type Explanation,
  type Gap,
  type GraphEdge,
  type GraphNode,
  type ImportMapEntry,
  type RepoInfo,
  type Report,
  type ReportSource,
  type RiskLevel,
  type SkippedDependency,
  type Vulnerability,
} from './types'

/** Thrown when a response does not match the contract closely enough to render. */
export class ReportShapeError extends Error {
  constructor(path: string) {
    super(`Response does not match the expected report shape at "${path}"`)
    this.name = 'ReportShapeError'
  }
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === 'string')
}

function records(value: unknown): Rec[] {
  return list(value).filter(isRecord)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function parseRepo(raw: Rec): RepoInfo {
  const status = oneOf(raw.status, ['ok', 'no_manifest', 'error'] as const)
  const message = str(raw.message)
  return {
    name: str(raw.name),
    origin: raw.origin === 'pasted' ? 'pasted' : 'github',
    url: str(raw.url),
    ref: str(raw.ref),
    commit: str(raw.commit),
    manifests: strings(raw.manifests),
    // An unknown status is surfaced as an error so the project is never silently dropped.
    status: status ?? 'error',
    message: status ? message : message || `Unknown status "${str(raw.status)}"`,
    code_scan: raw.code_scan === 'ran' ? 'ran' : 'unavailable',
  }
}

function parseNode(raw: Rec): GraphNode {
  return {
    id: str(raw.id),
    type: raw.type === 'repo' ? 'repo' : 'library',
    risk: oneOf<RiskLevel>(raw.risk, RISK_LEVELS),
    drifted: raw.drifted === true,
  }
}

function parseEdge(raw: Rec): GraphEdge {
  return {
    source: str(raw.source),
    target: str(raw.target),
    version: str(raw.version),
    raw_spec: str(raw.raw_spec),
  }
}

function parseVersion(raw: Rec): DriftVersion {
  return {
    repo: str(raw.repo),
    version: str(raw.version),
    raw_spec: str(raw.raw_spec),
    file: str(raw.file),
  }
}

function parseBreakdown(raw: Rec): BreakdownItem {
  return { signal: str(raw.signal), points: num(raw.points) ?? 0 }
}

function parseChangelog(raw: Rec): ChangelogEntry {
  return { version: str(raw.version), line: str(raw.line), url: str(raw.url) || null }
}

function parseVulnerability(raw: Rec): Vulnerability {
  return { id: str(raw.id), summary: str(raw.summary), affects: str(raw.affects) }
}

function parseImportMap(raw: Rec): ImportMapEntry {
  return { repo: str(raw.repo), files: num(raw.files), symbols: strings(raw.symbols) }
}

function parseHit(raw: Rec): CodeHit {
  return {
    repo: str(raw.repo),
    file: str(raw.file),
    line: num(raw.line),
    snippet: str(raw.snippet),
    rule: str(raw.rule),
    status: str(raw.status),
    replacement: str(raw.replacement),
    tier: num(raw.tier),
    rule_status: str(raw.rule_status),
  }
}

function parseCodeUsage(raw: unknown): CodeUsage {
  const usage = isRecord(raw) ? raw : {}
  return {
    import_map: records(usage.import_map).map(parseImportMap),
    hits: records(usage.hits).map(parseHit),
    note: str(usage.note) || null,
  }
}

function parseExplanation(raw: unknown): Explanation | null {
  if (!isRecord(raw)) return null
  const text = str(raw.text).trim()
  if (!text) return null
  return { text, source: raw.source === 'ai' ? 'ai' : 'template' }
}

function parseDrift(raw: Rec, index: number): Drift {
  const path = `drifts[${index}]`
  const id = str(raw.id)
  const library = str(raw.library)
  const risk = oneOf<RiskLevel>(raw.risk, RISK_LEVELS)
  const score = num(raw.score)
  // Identity, risk and score are the core of a result. Guessing any of them
  // would misreport the analysis, so a drift without them fails the whole parse.
  if (!id) throw new ReportShapeError(`${path}.id`)
  if (!library) throw new ReportShapeError(`${path}.library`)
  if (!risk) throw new ReportShapeError(`${path}.risk`)
  if (score === null) throw new ReportShapeError(`${path}.score`)

  const evidence = isRecord(raw.evidence) ? raw.evidence : {}
  return {
    id,
    library,
    ecosystem: str(raw.ecosystem),
    versions: records(raw.versions).map(parseVersion),
    gap: oneOf<Gap>(raw.gap, GAPS) ?? 'unknown',
    risk,
    score,
    breakdown: records(raw.breakdown).map(parseBreakdown),
    confidence: num(raw.confidence),
    signals_missing: strings(raw.signals_missing),
    evidence: {
      changelog: records(evidence.changelog).map(parseChangelog),
      vulnerabilities: records(evidence.vulnerabilities).map(parseVulnerability),
      code_usage: parseCodeUsage(evidence.code_usage),
    },
    explanation: parseExplanation(raw.explanation),
    recommendation: str(raw.recommendation),
  }
}

function parseSkipped(raw: Rec): SkippedDependency {
  return {
    repo: str(raw.repo),
    library: str(raw.library),
    raw_spec: str(raw.raw_spec),
    reason: str(raw.reason),
  }
}

/**
 * Validates an unknown response body against the report contract and returns a
 * fully defaulted `Report`. Throws `ReportShapeError` when the structure is too
 * far off to show honestly; tolerates missing optional fields everywhere else.
 */
export function parseReport(body: unknown): Report {
  if (!isRecord(body)) throw new ReportShapeError('(root)')

  const meta = body.meta
  if (!isRecord(meta)) throw new ReportShapeError('meta')
  const source = oneOf<ReportSource>(meta.source, REPORT_SOURCES)
  if (!source) throw new ReportShapeError('meta.source')

  const summary = body.summary
  if (!isRecord(summary)) throw new ReportShapeError('summary')
  if (!Array.isArray(body.repos)) throw new ReportShapeError('repos')
  if (!Array.isArray(body.drifts)) throw new ReportShapeError('drifts')
  const graph = body.graph
  if (!isRecord(graph)) throw new ReportShapeError('graph')

  const drifts = records(body.drifts).map(parseDrift)
  if (drifts.length !== body.drifts.length) throw new ReportShapeError('drifts[]')

  const byRisk = isRecord(summary.by_risk) ? summary.by_risk : {}
  const countByRisk = (level: RiskLevel): number =>
    num(byRisk[level]) ?? drifts.filter((drift) => drift.risk === level).length

  return {
    meta: {
      source,
      generated_at: str(meta.generated_at) || null,
      duration_ms: num(meta.duration_ms),
      github_rate_limit_remaining: num(meta.github_rate_limit_remaining),
    },
    summary: {
      repos: num(summary.repos) ?? body.repos.length,
      dependencies: num(summary.dependencies) ?? 0,
      drifts: num(summary.drifts) ?? drifts.length,
      by_risk: {
        Low: countByRisk('Low'),
        Medium: countByRisk('Medium'),
        High: countByRisk('High'),
        Critical: countByRisk('Critical'),
      },
    },
    repos: records(body.repos).map(parseRepo),
    graph: {
      nodes: records(graph.nodes)
        .map(parseNode)
        .filter((node) => node.id !== ''),
      edges: records(graph.edges)
        .map(parseEdge)
        .filter((edge) => edge.source !== '' && edge.target !== ''),
    },
    drifts,
    skipped: records(body.skipped).map(parseSkipped),
    warnings: strings(body.warnings),
  }
}
