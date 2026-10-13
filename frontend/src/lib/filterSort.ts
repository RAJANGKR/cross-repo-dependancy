import { RISK_LEVELS, type Drift, type RiskLevel } from '../api/types'
import { RISK_RANK } from './risk'

export const SORT_KEYS = ['risk', 'score', 'library', 'projects'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export const SORT_LABELS: Record<SortKey, string> = {
  risk: 'Risk, Critical first',
  score: 'Score, high to low',
  library: 'Library, A to Z',
  projects: 'Projects affected, most first',
}

export interface DriftFilters {
  /** Empty means all levels. */
  risks: RiskLevel[]
  /** Empty means all ecosystems. */
  ecosystems: string[]
  query: string
  sort: SortKey
  /** Reverses the order of the chosen sort. */
  reversed: boolean
}

export const DEFAULT_FILTERS: DriftFilters = {
  risks: [],
  ecosystems: [],
  query: '',
  sort: 'risk',
  reversed: false,
}

export function hasActiveFilters(filters: DriftFilters, project: string | null): boolean {
  return (
    filters.risks.length > 0 ||
    filters.ecosystems.length > 0 ||
    filters.query.trim() !== '' ||
    project !== null
  )
}

function projectCount(drift: Drift): number {
  return new Set(drift.versions.map((entry) => entry.repo)).size
}

const COMPARATORS: Record<SortKey, (a: Drift, b: Drift) => number> = {
  risk: (a, b) => RISK_RANK[b.risk] - RISK_RANK[a.risk] || b.score - a.score,
  score: (a, b) => b.score - a.score || RISK_RANK[b.risk] - RISK_RANK[a.risk],
  library: (a, b) => a.library.localeCompare(b.library, undefined, { sensitivity: 'base' }),
  projects: (a, b) => projectCount(b) - projectCount(a) || b.score - a.score,
}

export function sortDrifts(drifts: readonly Drift[], sort: SortKey, reversed = false): Drift[] {
  const compare = COMPARATORS[sort]
  const sorted = [...drifts].sort(
    (a, b) => compare(a, b) || a.library.localeCompare(b.library) || a.id.localeCompare(b.id),
  )
  return reversed ? sorted.reverse() : sorted
}

/** Applies risk, ecosystem, search and project filters, then sorts. */
export function filterDrifts(
  drifts: readonly Drift[],
  filters: DriftFilters,
  project: string | null = null,
): Drift[] {
  const query = filters.query.trim().toLowerCase()
  const matching = drifts.filter((drift) => {
    if (filters.risks.length > 0 && !filters.risks.includes(drift.risk)) return false
    if (filters.ecosystems.length > 0 && !filters.ecosystems.includes(drift.ecosystem)) return false
    if (project !== null && !drift.versions.some((entry) => entry.repo === project)) return false
    if (query === '') return true
    return (
      drift.library.toLowerCase().includes(query) ||
      drift.versions.some((entry) => entry.repo.toLowerCase().includes(query))
    )
  })
  return sortDrifts(matching, filters.sort, filters.reversed)
}

/** Ecosystems present in the data, in first-seen order. */
export function ecosystemsIn(drifts: readonly Drift[]): string[] {
  return [...new Set(drifts.map((drift) => drift.ecosystem).filter((eco) => eco !== ''))]
}

// ---- URL query string ------------------------------------------------------
// Only filter values and the selected drift id go into the URL. Pasted manifest
// content never does.

const OWNED_PARAMS = ['risk', 'eco', 'q', 'sort', 'selected'] as const

export interface UrlViewState {
  filters: DriftFilters
  selected: string | null
}

export function viewStateFromSearch(search: string): UrlViewState {
  const params = new URLSearchParams(search)
  const risks = (params.get('risk') ?? '')
    .split(',')
    .filter((value): value is RiskLevel => (RISK_LEVELS as readonly string[]).includes(value))
  const ecosystems = (params.get('eco') ?? '').split(',').filter((value) => value !== '')
  const rawSort = params.get('sort') ?? ''
  const reversed = rawSort.startsWith('-')
  const sortName = reversed ? rawSort.slice(1) : rawSort
  const sort = (SORT_KEYS as readonly string[]).includes(sortName)
    ? (sortName as SortKey)
    : DEFAULT_FILTERS.sort

  return {
    filters: {
      risks,
      ecosystems,
      query: params.get('q') ?? '',
      sort,
      reversed: (SORT_KEYS as readonly string[]).includes(sortName) && reversed,
    },
    selected: params.get('selected') || null,
  }
}

/** Writes the view state into a query string, keeping unrelated params intact. */
export function viewStateToSearch(state: UrlViewState, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch)
  for (const key of OWNED_PARAMS) params.delete(key)

  const { filters, selected } = state
  if (filters.risks.length > 0) params.set('risk', filters.risks.join(','))
  if (filters.ecosystems.length > 0) params.set('eco', filters.ecosystems.join(','))
  if (filters.query.trim() !== '') params.set('q', filters.query.trim())
  if (filters.sort !== DEFAULT_FILTERS.sort || filters.reversed) {
    params.set('sort', `${filters.reversed ? '-' : ''}${filters.sort}`)
  }
  if (selected) params.set('selected', selected)

  const text = params.toString()
  return text ? `?${text}` : ''
}
