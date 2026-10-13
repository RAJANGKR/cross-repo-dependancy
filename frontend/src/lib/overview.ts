import type { DependencyDrift, RepositorySummary, ScanResult } from '../api/scanTypes'
import { driftMeta, type Tone } from './classify'

export interface Metric {
  key: string
  label: string
  /** `null` means the backend did not provide this number. Never shown as 0. */
  value: number | null
  note?: string
}

export interface DistributionSlice {
  key: string
  label: string
  count: number
  tone: Tone
}

export interface Overview {
  metrics: Metric[]
  /** Drift classification counts, or null when no breakdown is available. */
  distribution: DistributionSlice[] | null
  /** True when counts were tallied from the returned rows, not a backend summary. */
  derived: boolean
  /** Repositories the backend listed with zero manifests. */
  incompleteRepos: RepositorySummary[]
  hasWarnings: boolean
}

function tally(rows: readonly DependencyDrift[], key: 'drift_disparity' | 'compatibility_risk'): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row[key]] = (counts[row[key]] ?? 0) + 1
  return counts
}

const DISTRIBUTION_ORDER = ['MAJOR_DRIFT', 'MINOR_DRIFT', 'INFO', 'IN_SYNC']

/**
 * Builds the overview numbers from the scan result. The backend summary is
 * used when present. Without one, counts are tallied from the drift matrix and
 * flagged as derived. A number the data cannot support stays `null`.
 */
export function computeOverview(result: ScanResult): Overview {
  const { summary, drift_matrix: rows } = result
  const canDerive = rows.length > 0
  const severity = summary?.severity_counts ?? (canDerive ? tally(rows, 'drift_disparity') : null)
  const risk = summary?.compatibility_risk_counts ?? (canDerive ? tally(rows, 'compatibility_risk') : null)
  const derived =
    canDerive && (summary?.severity_counts == null || summary?.compatibility_risk_counts == null)

  const fromSeverity = (key: string): number | null => (severity ? (severity[key] ?? 0) : null)
  const incompleteRepos = result.scanned_repositories.filter((repo) => repo.manifest_count === 0)
  const warningCount = result.warnings.length + result.skipped_items.length

  const metrics: Metric[] = [
    {
      key: 'repos',
      label: 'Repositories scanned',
      value: result.scanned_repositories.length > 0 ? result.scanned_repositories.length : null,
    },
    {
      key: 'dependencies',
      label: 'Dependencies analyzed',
      value: summary?.total_unique_dependencies ?? null,
      note: 'Unique packages',
    },
    { key: 'in-sync', label: 'In sync', value: summary?.in_sync_count ?? fromSeverity('IN_SYNC') },
    { key: 'minor', label: 'Minor drift', value: fromSeverity('MINOR_DRIFT') },
    { key: 'major', label: 'Major drift', value: fromSeverity('MAJOR_DRIFT') },
    { key: 'single', label: 'Not compared', value: fromSeverity('INFO'), note: 'Single repository or unresolved' },
    {
      key: 'findings',
      label: 'Compatibility findings',
      value: risk ? (risk.CONFIRMED_BREAKING ?? 0) + (risk.SUSPECTED_BREAKING ?? 0) : null,
      note: 'Confirmed or suspected breaking',
    },
    {
      key: 'warnings',
      label: 'Warnings',
      value: warningCount,
      note:
        incompleteRepos.length > 0
          ? `${incompleteRepos.length} of ${result.scanned_repositories.length} repositories not fully analyzed`
          : undefined,
    },
  ]

  const distribution = severity
    ? [...new Set([...DISTRIBUTION_ORDER, ...Object.keys(severity)])]
        .map((key) => {
          const meta = driftMeta(key)
          return { key, label: meta.label, count: severity[key] ?? 0, tone: meta.tone }
        })
        .filter((slice) => slice.count > 0 || DISTRIBUTION_ORDER.includes(slice.key))
    : null

  return {
    metrics,
    distribution,
    derived,
    incompleteRepos,
    hasWarnings: warningCount > 0 || incompleteRepos.length > 0,
  }
}

/** Repository names in display order: the backend's list first, then any others seen in rows. */
export function repoNamesOf(result: ScanResult): string[] {
  const names = result.scanned_repositories.map((repo) => repo.name).filter((name) => name !== '')
  for (const row of result.drift_matrix) {
    for (const name of Object.keys(row.declarations_by_repo)) {
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}
