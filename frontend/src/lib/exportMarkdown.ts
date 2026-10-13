import type { DependencyDrift, ScanRecord } from '../api/scanTypes'
import { contractMeta, driftMeta, riskMeta } from './classify'
import { ecosystemLabel, formatDateTime, formatDuration, humanizeCode } from './formatters'
import { computeOverview } from './overview'

export type DataSource = 'live' | 'demo'

export const SOURCE_LABELS: Record<DataSource, string> = { live: 'Live scan', demo: 'Demo data' }

export const LIMITATIONS: readonly string[] = [
  'Direct dependencies from manifests and lockfiles only. Transitive dependencies are not compared.',
  'Public GitHub repositories only, 2 to 10 per scan. Private projects can be pasted, without a code scan.',
  'npm, Python and Maven manifests are supported: package.json, package-lock.json, requirements.txt, pyproject.toml, poetry.lock and pom.xml.',
  'Only pushed code is read. The code scan finds changed names, not silent behavior changes, and cannot confirm a runtime failure.',
  'A major version gap is not a confirmed break. Compatibility risk is only as strong as the release notes behind it.',
  'Missing evidence is not proof of safety. "No issue identified" means nothing was found in what was available.',
  'AI-written interpretation is labeled as such and is never used to decide a classification on its own.',
]

/** Collapses API text onto one line so it cannot break the document structure. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function code(text: string): string {
  return `\`${inline(text).replace(/`/g, "'")}\``
}

function dependencySection(row: DependencyDrift): string[] {
  const lines: string[] = [
    `### ${inline(row.dependency_name)}`,
    '',
    `- Ecosystem: ${ecosystemLabel(row.ecosystem)}`,
    `- Drift: ${driftMeta(row.drift_disparity).label}`,
    `- Compatibility risk: ${riskMeta(row.compatibility_risk).label}`,
    `- Recommended version: ${row.recommended_version ? code(row.recommended_version) : 'Not provided'}`,
    '',
    '| Repository | Declared range | Resolved version | Source file |',
    '| --- | --- | --- | --- |',
  ]
  for (const [repo, declaration] of Object.entries(row.declarations_by_repo)) {
    const resolved = declaration.resolved_version ? code(declaration.resolved_version) : 'Not resolved'
    lines.push(
      `| ${inline(repo)} | ${code(declaration.declared_range || 'unknown')} | ${resolved} | ${inline(declaration.source_file) || 'Unknown'} |`,
    )
  }
  for (const repo of row.missing_in_repos) lines.push(`| ${inline(repo)} | Not declared | | |`)

  const { evidence } = row
  lines.push('')
  if (!evidence) {
    lines.push('Release evidence: none available. This is not proof of compatibility.')
  } else {
    if (evidence.cited_excerpt) lines.push(`Release note excerpt: "${inline(evidence.cited_excerpt)}"`)
    else lines.push('Release note excerpt: none retrieved.')
    if (evidence.source_url) lines.push(`Source: ${inline(evidence.source_url)}`)
    if (evidence.notes) lines.push(`AI interpretation: ${inline(evidence.notes)}`)
  }
  lines.push('')
  return lines
}

/**
 * Builds the Markdown report. `rows` is passed separately so the export
 * follows the order currently shown on screen.
 */
export function buildMarkdown(record: ScanRecord, rows: readonly DependencyDrift[], source: DataSource): string {
  const result = record.result
  const lines: string[] = []
  if (source === 'demo') lines.push('> Demo data, not a live scan', '')

  lines.push(
    '# DriftLock scan report',
    '',
    `- Data source: ${SOURCE_LABELS[source]}`,
    `- Scan id: ${inline(record.scan_id)}`,
    `- Completed: ${formatDateTime(record.completed_at)}`,
    `- Duration: ${formatDuration(record.duration_seconds)}`,
    '',
  )
  if (!result) {
    lines.push('No result is available for this scan.', '')
    return lines.join('\n')
  }

  const overview = computeOverview(result)
  lines.push('## Overview', '')
  for (const metric of overview.metrics) {
    lines.push(`- ${metric.label}: ${metric.value === null ? 'Not available' : metric.value}`)
  }
  if (overview.derived) lines.push('', 'Counts were tallied from the rows returned, not from a backend summary.')

  lines.push('', '## Repositories', '')
  if (result.scanned_repositories.length === 0) lines.push('- Not provided by the backend')
  for (const repo of result.scanned_repositories) {
    const manifests = repo.manifest_count === null ? 'manifests not reported' : `${repo.manifest_count} manifests`
    const deps = repo.total_dependencies === null ? 'dependencies not reported' : `${repo.total_dependencies} dependencies`
    lines.push(`- ${inline(repo.name)}: ${manifests}, ${deps}`)
  }

  lines.push('', '## Warnings', '')
  if (result.warnings.length === 0 && result.skipped_items.length === 0) lines.push('- None reported')
  for (const warning of result.warnings) lines.push(`- ${inline(warning)}`)
  for (const item of result.skipped_items) lines.push(`- Skipped: ${inline(item)}`)

  lines.push('', '## Dependencies', '')
  if (rows.length === 0) lines.push('No dependencies to list.', '')
  for (const row of rows) lines.push(...dependencySection(row))

  if (result.contract_analysis) {
    lines.push('## API contract analysis', '')
    for (const entry of result.contract_analysis) {
      const pair = entry.consumer_repo ? `${entry.provider_repo} to ${entry.consumer_repo}` : entry.provider_repo
      lines.push(`- ${inline(pair) || 'Unknown repository'}: ${contractMeta(entry.status).label}`)
      for (const finding of entry.findings) {
        lines.push(
          `  - ${humanizeCode(finding.change_type) || 'Change'}: ${inline(finding.method)} ${code(finding.path || 'unknown path')}`,
        )
      }
    }
    lines.push('')
  }

  if (result.code_impact) {
    lines.push('## Code impact', '')
    if (result.code_impact.length === 0) lines.push('- No call sites reported')
    for (const item of result.code_impact) {
      const location = `${inline(item.file)}${item.line === null ? '' : `:${item.line}`}`
      lines.push(`- ${inline(item.repository)} ${location}: ${inline(item.impact) || 'No assessment provided'}`)
    }
    lines.push('')
  }

  lines.push('## Limitations', '')
  for (const item of LIMITATIONS) lines.push(`- ${item}`)
  lines.push('')
  return lines.join('\n')
}

/** Plain-text summary of one dependency, for the clipboard. */
export function dependencySummaryText(row: DependencyDrift): string {
  const lines = [
    `${row.dependency_name} (${ecosystemLabel(row.ecosystem)})`,
    `Drift: ${driftMeta(row.drift_disparity).label}`,
    `Compatibility risk: ${riskMeta(row.compatibility_risk).label}`,
  ]
  for (const [repo, declaration] of Object.entries(row.declarations_by_repo)) {
    lines.push(
      `${repo}: declared ${declaration.declared_range || 'unknown'}, resolved ${declaration.resolved_version ?? 'not resolved'}`,
    )
  }
  if (row.recommended_version) lines.push(`Recommended version: ${row.recommended_version}`)
  if (row.evidence?.cited_excerpt) lines.push(`Release note excerpt: "${row.evidence.cited_excerpt}"`)
  if (row.evidence?.source_url) lines.push(`Source: ${row.evidence.source_url}`)
  return lines.join('\n')
}

export function exportFileName(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `driftlock-report-${year}-${month}-${day}.md`
}

/** Triggers a client-side download. Nothing is uploaded. */
export function downloadText(text: string, fileName: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
