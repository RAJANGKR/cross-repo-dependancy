import type { Drift, Report, ReportSource } from '../api/types'
import {
  codeUsageNoteSentence,
  ecosystemLabel,
  formatConfidence,
  formatDateTime,
  formatPoints,
  hitSentence,
  isCandidateHit,
  missingSignalSentence,
  TIER_LABELS,
} from './formatters'

export const SOURCE_LABELS: Record<ReportSource, string> = {
  live: 'Live',
  cache: 'Cached',
  demo: 'Demo data',
}

export const LIMITATIONS: readonly string[] = [
  'Direct dependencies only. Transitive dependencies are not checked.',
  'Public GitHub repos only. Use paste mode for private projects, without the code scan.',
  'Reads only what is pushed. Unpushed work is invisible.',
  'The scan finds changed names, not silent behavior changes.',
  'Risk is a signal, not a guarantee.',
]

export const SCAN_LIMITS =
  'Finds changed names, not silent behavior changes. Knows only what the rule pack or validated changelog lists. Cannot see unpushed or indirect code. Cannot confirm runtime failure.'

/** Collapses API text onto one line so it cannot break the document structure. */
function inline(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function code(text: string): string {
  return `\`${inline(text).replace(/`/g, "'")}\``
}

function driftSection(drift: Drift): string[] {
  const lines: string[] = [
    `## ${inline(drift.library)}`,
    '',
    `- Ecosystem: ${ecosystemLabel(drift.ecosystem)}`,
    `- Risk: ${drift.risk}`,
    `- Score: ${drift.score}`,
    `- Confidence: ${formatConfidence(drift.confidence)} (heuristic, lower when evidence is missing)`,
    `- Gap: ${drift.gap}`,
    '',
    '### Versions by project',
    '',
  ]
  if (drift.versions.length === 0) lines.push('- Not available')
  for (const entry of drift.versions) {
    const spec = entry.raw_spec ? `, spec ${code(entry.raw_spec)}` : ''
    const file = entry.file ? `, ${inline(entry.file)}` : ''
    lines.push(`- ${inline(entry.repo)}: ${code(entry.version)}${spec}${file}`)
  }

  lines.push('', '### Points breakdown', '')
  if (drift.breakdown.length === 0) lines.push('- Not available')
  for (const item of drift.breakdown) {
    lines.push(`- ${inline(item.signal)}: ${formatPoints(item.points)}`)
  }

  const { code_usage: usage, changelog, vulnerabilities } = drift.evidence
  lines.push('', '### Evidence', '', '**Code usage**', '')
  if (usage.import_map.length === 0 && usage.hits.length === 0) lines.push('- None found')
  for (const entry of usage.import_map) {
    const files = entry.files === null ? 'files not counted' : `${entry.files} files`
    const symbols = entry.symbols.length > 0 ? `, symbols: ${entry.symbols.map(inline).join(', ')}` : ''
    lines.push(`- [${TIER_LABELS[1]}, Tier 1] ${inline(entry.repo)}: ${files}${symbols}`)
  }
  for (const hit of usage.hits) {
    const tier = isCandidateHit(hit) ? 3 : 2
    const location = `${inline(hit.file)}${hit.line === null ? '' : `:${hit.line}`}`
    lines.push(
      `- [${TIER_LABELS[tier]}, Tier ${tier}] ${inline(hit.repo)} ${location}: ${inline(hitSentence(hit))}`,
    )
  }
  if (usage.note) lines.push(`- Note: ${inline(codeUsageNoteSentence(usage.note))}`)

  lines.push('', '**Changelog**', '')
  if (changelog.length === 0) lines.push('- None found')
  for (const entry of changelog) {
    lines.push(`- ${inline(entry.version) || 'Unknown version'}: ${inline(entry.line)}`)
  }

  lines.push('', '**Vulnerabilities**', '')
  if (vulnerabilities.length === 0) lines.push('- None found')
  for (const item of vulnerabilities) {
    const affects = item.affects ? ` (affects ${inline(item.affects)})` : ''
    lines.push(`- ${inline(item.id)}: ${inline(item.summary)}${affects}`)
  }

  lines.push('', '### Missing signals', '')
  if (drift.signals_missing.length === 0) lines.push('- None')
  for (const key of drift.signals_missing) lines.push(`- ${missingSignalSentence(key)}`)

  if (drift.explanation) {
    const label = drift.explanation.source === 'ai' ? 'AI explanation' : 'Generated from rules'
    lines.push('', `### Explanation (${label})`, '', inline(drift.explanation.text))
  }

  lines.push('', '### Recommendation', '', inline(drift.recommendation) || 'Not available', '')
  return lines
}

/**
 * Builds the Markdown report. `drifts` is passed separately so the export
 * follows the order currently shown on screen.
 */
export function buildMarkdown(report: Report, drifts: readonly Drift[]): string {
  const { meta, summary } = report
  const lines: string[] = []
  if (meta.source === 'demo') lines.push('> Demo data, not a live scan', '')

  lines.push(
    '# DriftLock report',
    '',
    `- Data source: ${SOURCE_LABELS[meta.source]}`,
    `- Generated: ${formatDateTime(meta.generated_at)}`,
    '',
    '## Summary',
    '',
    `- Projects: ${summary.repos}`,
    `- Dependencies: ${summary.dependencies}`,
    `- Drifts found: ${summary.drifts}`,
    `- By risk: Critical ${summary.by_risk.Critical}, High ${summary.by_risk.High}, Medium ${summary.by_risk.Medium}, Low ${summary.by_risk.Low}`,
    '',
  )

  if (drifts.length === 0) lines.push('No drift found among direct dependencies.', '')
  for (const drift of drifts) lines.push(...driftSection(drift))

  lines.push('## Skipped dependencies', '', 'These were not scored.', '')
  if (report.skipped.length === 0) lines.push('- None')
  for (const item of report.skipped) {
    lines.push(
      `- ${inline(item.library)} in ${inline(item.repo)} (${code(item.raw_spec)}): ${inline(item.reason)}`,
    )
  }

  lines.push('', '## Limitations', '')
  for (const item of LIMITATIONS) lines.push(`- ${item}`)
  lines.push(`- Scan limits: ${SCAN_LIMITS}`, '')

  return lines.join('\n')
}

export function exportFileName(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `driftlock-report-${year}-${month}-${day}.md`
}

/** Triggers a client-side download. Nothing is uploaded. */
export function downloadMarkdown(markdown: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
