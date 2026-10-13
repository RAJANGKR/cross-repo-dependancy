import type { DependencyDrift, ScanResult } from '../api/scanTypes'
import { driftMeta, isCompatibilityFinding, isDrifted, riskMeta } from './classify'
import { ecosystemLabel } from './formatters'
import { activeReview, type HistoryEntry, type Review } from './localStore'
import type { ScanTarget } from './targets'

// ---- Fix lines ---------------------------------------------------------------

/**
 * The manifest line that sets `recommended_version` in one repository.
 * It uses only the version the backend recommended; nothing is invented.
 * Returns null when there is no recommendation or the file type is unknown.
 */
export function fixLine(row: DependencyDrift, repo: string): string | null {
  const declaration = row.declarations_by_repo[repo]
  const version = row.recommended_version
  if (!declaration || !version) return null
  const file = declaration.source_file.split('/').pop()?.toLowerCase() ?? ''
  // An exact version is pinned; a recommended range is written as the backend gave it.
  const exact = /^[0-9]/.test(version)
  const python = `${row.dependency_name}${exact ? '==' : ''}${version}`
  if (file === 'package.json') return `"${row.dependency_name}": "${version}"`
  if (file === 'pyproject.toml') return `"${python}",`
  if (file === 'pom.xml') {
    if (!exact) return null
    const [group, artifact] = row.dependency_name.split(':')
    return `<dependency>\n  <groupId>${group}</groupId>\n  <artifactId>${artifact ?? ''}</artifactId>\n  <version>${version}</version>\n</dependency>`
  }
  if (file.includes('requirements')) return python
  return null
}

/** True when a repository already resolves to, or pins, the recommended version. */
export function alreadyOnRecommended(row: DependencyDrift, repo: string): boolean {
  const declaration = row.declarations_by_repo[repo]
  const version = row.recommended_version
  if (!declaration || !version) return false
  return declaration.resolved_version === version || declaration.declared_range.replace(/^[=\s]+/, '') === version
}

export interface RepoFix {
  repo: string
  file: string
  line: string
}

export function fixesFor(row: DependencyDrift): RepoFix[] {
  return Object.keys(row.declarations_by_repo).flatMap((repo) => {
    const line = alreadyOnRecommended(row, repo) ? null : fixLine(row, repo)
    return line ? [{ repo, file: row.declarations_by_repo[repo]?.source_file ?? '', line }] : []
  })
}

export const fixKey = (row: DependencyDrift, repo: string) => `${row.id}@${repo}`

export function prDescription(row: DependencyDrift, repoLabel: (name: string) => string): string {
  const lines = [
    `## Align ${row.dependency_name}${row.recommended_version ? ` on ${row.recommended_version}` : ''}`,
    '',
    `- Drift: ${driftMeta(row.drift_disparity).label}`,
    `- Compatibility risk: ${riskMeta(row.compatibility_risk).label}`,
    '',
    '| Repository | Declared | Resolved |',
    '| --- | --- | --- |',
    ...Object.entries(row.declarations_by_repo).map(
      ([repo, d]) => `| ${repoLabel(repo)} | \`${d.declared_range}\` | ${d.resolved_version ? `\`${d.resolved_version}\`` : 'not resolved'} |`,
    ),
  ]
  if (row.evidence?.cited_excerpt) lines.push('', `Release notes: "${row.evidence.cited_excerpt}"`)
  if (row.evidence?.source_url?.startsWith('https://')) lines.push(`Source: ${row.evidence.source_url}`)
  for (const vulnerability of row.vulnerabilities) {
    lines.push(`Known vulnerability in ${repoLabel(vulnerability.affects_repo)}: ${vulnerability.id}`)
  }
  lines.push('', 'Found by DriftLock. Risk is a signal, not a guarantee: run the test suite before merging.')
  return lines.join('\n')
}

export interface FixPlanGroup {
  repo: string
  items: Array<{ row: DependencyDrift; fix: RepoFix }>
}

/** Fixes grouped by repository, lowest compatibility risk first within each. */
export function fixPlan(rows: readonly DependencyDrift[], repos: readonly string[]): FixPlanGroup[] {
  const drifted = rows
    .filter((row) => isDrifted(row.drift_disparity))
    .sort((a, b) => riskMeta(a.compatibility_risk).rank - riskMeta(b.compatibility_risk).rank || (a.score ?? 0) - (b.score ?? 0))
  return repos
    .map((repo) => ({
      repo,
      items: drifted.flatMap((row) => fixesFor(row).filter((fix) => fix.repo === repo).map((fix) => ({ row, fix }))),
    }))
    .filter((group) => group.items.length > 0)
}

export function fixPlanText(plan: readonly FixPlanGroup[], repoLabel: (name: string) => string): string {
  return plan
    .map((group) =>
      [`## ${repoLabel(group.repo)}`, ...group.items.map(({ row, fix }) => `- [ ] ${fix.file}: ${fix.line.replace(/\n\s*/g, ' ')}  (${riskMeta(row.compatibility_risk).label})`)].join('\n'),
    )
    .join('\n\n')
}

// ---- Repository health -------------------------------------------------------

export interface RepoHealth {
  repo: string
  score: number
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  drifted: number
  findings: number
  vulnerabilities: number
}

/**
 * Health grade for one repository. Start at 100 and subtract, for each drifted
 * package the repository declares: 25 if confirmed breaking, 15 if suspected,
 * 8 if the impact is unknown, 3 otherwise; and 10 for each known vulnerability
 * in a version it uses. Grades: A 90+, B 75+, C 60+, D 40+, F below 40.
 * These weights are a display heuristic, not a measurement.
 */
export function repoHealth(rows: readonly DependencyDrift[], repo: string): RepoHealth {
  const mine = rows.filter((row) => repo in row.declarations_by_repo && isDrifted(row.drift_disparity))
  const penalty: Record<string, number> = { CONFIRMED_BREAKING: 25, SUSPECTED_BREAKING: 15, UNKNOWN_IMPACT: 8 }
  const vulnerabilities = rows.reduce((sum, row) => sum + row.vulnerabilities.filter((item) => item.affects_repo === repo).length, 0)
  const lost = mine.reduce((sum, row) => sum + (penalty[row.compatibility_risk] ?? 3), 0) + vulnerabilities * 10
  const score = Math.max(0, 100 - lost)
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F'
  return {
    repo,
    score,
    grade,
    drifted: mine.length,
    findings: mine.filter((row) => isCompatibilityFinding(row.compatibility_risk)).length,
    vulnerabilities,
  }
}

// ---- KPIs --------------------------------------------------------------------

export interface Kpis {
  activeDrifts: number
  sharedLibraries: number
  /** null when the scan carries no vulnerability lookup at all. */
  vulnerableVersions: number | null
  pendingReview: number
}

export function needsReview(row: DependencyDrift, reviews: Record<string, Review>, now = Date.now()): boolean {
  return isDrifted(row.drift_disparity) && activeReview(reviews[row.id], now) === null
}

export function computeKpis(result: ScanResult, reviews: Record<string, Review>, now = Date.now()): Kpis {
  const rows = result.drift_matrix
  const osv = result.data_sources.find((source) => source.name === 'OSV')
  const looked = rows.some((row) => row.vulnerabilities.length > 0) || (osv !== undefined && osv.status !== 'not_used' && osv.status !== 'failed')
  return {
    activeDrifts: rows.filter((row) => isDrifted(row.drift_disparity)).length,
    sharedLibraries: rows.filter((row) => row.present_in_repos.length > 1).length,
    vulnerableVersions: looked ? new Set(rows.flatMap((row) => row.vulnerabilities.map((item) => `${row.id}@${item.affects_repo}`))).size : null,
    pendingReview: rows.filter((row) => needsReview(row, reviews, now)).length,
  }
}

/** Drifted packages ordered for attention: risk, then score, then how many repositories use them. */
export function priorityDrifts(rows: readonly DependencyDrift[]): DependencyDrift[] {
  return rows
    .filter((row) => isDrifted(row.drift_disparity))
    .sort(
      (a, b) =>
        riskMeta(b.compatibility_risk).rank - riskMeta(a.compatibility_risk).rank ||
        (b.score ?? -1) - (a.score ?? -1) ||
        b.present_in_repos.length - a.present_in_repos.length ||
        a.dependency_name.localeCompare(b.dependency_name),
    )
}

export function ecosystemBreakdown(rows: readonly DependencyDrift[]): Array<{ ecosystem: string; label: string; total: number; drifted: number }> {
  const map = new Map<string, { total: number; drifted: number }>()
  for (const row of rows) {
    const entry = map.get(row.ecosystem) ?? { total: 0, drifted: 0 }
    entry.total += 1
    if (isDrifted(row.drift_disparity)) entry.drifted += 1
    map.set(row.ecosystem, entry)
  }
  return [...map.entries()].map(([ecosystem, counts]) => ({ ecosystem, label: ecosystemLabel(ecosystem), ...counts }))
}

// ---- Scan history ------------------------------------------------------------

/** A history entry. Pasted targets keep their name only: content is never stored. */
export function toHistoryEntry(id: string, source: 'live' | 'demo', targets: readonly ScanTarget[], result: ScanResult, at = new Date()): HistoryEntry {
  const rows = result.drift_matrix
  return {
    id,
    at: at.toISOString(),
    source,
    targets: targets.map(({ kind, label, name, url, ref }) => ({ kind, label, name, url, ref })),
    drifted: rows.filter((row) => isDrifted(row.drift_disparity)).length,
    major: rows.filter((row) => row.drift_disparity === 'MAJOR_DRIFT').length,
    findings: rows.filter((row) => isCompatibilityFinding(row.compatibility_risk)).length,
    drifts: Object.fromEntries(rows.filter((row) => isDrifted(row.drift_disparity)).map((row) => [row.id, `${row.drift_disparity}|${row.compatibility_risk}`])),
  }
}

export interface ScanDiff {
  /** Drift ids present now and not before. */
  added: string[]
  resolved: string[]
  /** Same package, different drift or risk classification. */
  changed: string[]
}

export function diffScans(previous: HistoryEntry, current: HistoryEntry): ScanDiff {
  const before = previous.drifts
  const after = current.drifts
  return {
    added: Object.keys(after).filter((id) => !(id in before)).sort(),
    resolved: Object.keys(before).filter((id) => !(id in after)).sort(),
    changed: Object.keys(after).filter((id) => id in before && before[id] !== after[id]).sort(),
  }
}

/** A short message for a team channel, built from the highest-risk drifts. It is copied, never sent. */
export function teamMessage(rows: readonly DependencyDrift[], limit = 5): string {
  const top = priorityDrifts(rows).slice(0, limit)
  if (top.length === 0) return 'DriftLock scan: no dependency drift found across the scanned repositories.'
  return [
    `DriftLock scan: ${priorityDrifts(rows).length} drifted packages. Highest priority:`,
    ...top.map((row) => {
      const versions = Object.entries(row.declarations_by_repo).map(([repo, d]) => `${repo} ${d.resolved_version ?? d.declared_range}`).join(', ')
      return `- ${row.dependency_name}: ${driftMeta(row.drift_disparity).label}, ${riskMeta(row.compatibility_risk).label} (${versions})`
    }),
    'Risk is a signal, not a guarantee.',
  ].join('\n')
}
