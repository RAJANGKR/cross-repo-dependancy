import type { DependencyDrift } from '../api/scanTypes'
import { driftMeta, riskMeta } from './classify'

export const SORT_KEYS = ['drift', 'risk', 'name', 'ecosystem'] as const
export type SortKey = (typeof SORT_KEYS)[number]

export const SORT_LABELS: Record<SortKey, string> = {
  drift: 'Drift, largest first',
  risk: 'Compatibility risk, highest first',
  name: 'Package name, A to Z',
  ecosystem: 'Ecosystem',
}

export interface DriftFilters {
  query: string
  /** Empty means all. */
  ecosystems: string[]
  /** Drift classifications. Empty means all. */
  drifts: string[]
  /** Compatibility risks. Empty means all. */
  risks: string[]
  sort: SortKey
  reversed: boolean
}

export const DEFAULT_FILTERS: DriftFilters = {
  query: '',
  ecosystems: [],
  drifts: [],
  risks: [],
  sort: 'drift',
  reversed: false,
}

export function hasActiveFilters(filters: DriftFilters, repo: string | null): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.ecosystems.length > 0 ||
    filters.drifts.length > 0 ||
    filters.risks.length > 0 ||
    repo !== null
  )
}

const byName = (a: DependencyDrift, b: DependencyDrift) =>
  a.dependency_name.localeCompare(b.dependency_name, undefined, { sensitivity: 'base' })
const byDrift = (a: DependencyDrift, b: DependencyDrift) =>
  driftMeta(b.drift_disparity).rank - driftMeta(a.drift_disparity).rank
const byRisk = (a: DependencyDrift, b: DependencyDrift) =>
  riskMeta(b.compatibility_risk).rank - riskMeta(a.compatibility_risk).rank

const COMPARATORS: Record<SortKey, (a: DependencyDrift, b: DependencyDrift) => number> = {
  drift: (a, b) => byDrift(a, b) || byRisk(a, b),
  risk: (a, b) => byRisk(a, b) || byDrift(a, b),
  name: byName,
  ecosystem: (a, b) => a.ecosystem.localeCompare(b.ecosystem),
}

export function sortDrifts(rows: readonly DependencyDrift[], sort: SortKey, reversed = false): DependencyDrift[] {
  const compare = COMPARATORS[sort]
  const sorted = [...rows].sort((a, b) => compare(a, b) || byName(a, b) || a.id.localeCompare(b.id))
  return reversed ? sorted.reverse() : sorted
}

/** Applies search, ecosystem, drift, risk and repository filters, then sorts. */
export function filterDrifts(
  rows: readonly DependencyDrift[],
  filters: DriftFilters,
  repo: string | null = null,
): DependencyDrift[] {
  const query = filters.query.trim().toLowerCase()
  const matching = rows.filter((row) => {
    if (filters.ecosystems.length > 0 && !filters.ecosystems.includes(row.ecosystem)) return false
    if (filters.drifts.length > 0 && !filters.drifts.includes(row.drift_disparity)) return false
    if (filters.risks.length > 0 && !filters.risks.includes(row.compatibility_risk)) return false
    if (repo !== null && !(repo in row.declarations_by_repo)) return false
    return query === '' || row.dependency_name.toLowerCase().includes(query)
  })
  return sortDrifts(matching, filters.sort, filters.reversed)
}

/** Distinct values of a field in first-seen order, for building filter chips. */
export function valuesIn(
  rows: readonly DependencyDrift[],
  key: 'ecosystem' | 'drift_disparity' | 'compatibility_risk',
): string[] {
  return [...new Set(rows.map((row) => row[key]).filter((value) => value !== ''))]
}

// ---- URL query string ------------------------------------------------------

const OWNED_PARAMS = ['q', 'eco', 'drift', 'risk', 'sort', 'selected'] as const

export interface UrlViewState {
  filters: DriftFilters
  selected: string | null
}

function listParam(params: URLSearchParams, key: string): string[] {
  return (params.get(key) ?? '').split(',').filter((value) => value !== '')
}

export function viewStateFromSearch(search: string): UrlViewState {
  const params = new URLSearchParams(search)
  const rawSort = params.get('sort') ?? ''
  const reversed = rawSort.startsWith('-')
  const sortName = reversed ? rawSort.slice(1) : rawSort
  const sort = SORT_KEYS.find((key) => key === sortName)

  return {
    filters: {
      query: params.get('q') ?? '',
      ecosystems: listParam(params, 'eco'),
      drifts: listParam(params, 'drift'),
      risks: listParam(params, 'risk'),
      sort: sort ?? DEFAULT_FILTERS.sort,
      reversed: sort !== undefined && reversed,
    },
    selected: params.get('selected') || null,
  }
}

/** Writes the view state into a query string, keeping unrelated params intact. */
export function viewStateToSearch(state: UrlViewState, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch)
  for (const key of OWNED_PARAMS) params.delete(key)

  const { filters, selected } = state
  if (filters.query.trim() !== '') params.set('q', filters.query.trim())
  if (filters.ecosystems.length > 0) params.set('eco', filters.ecosystems.join(','))
  if (filters.drifts.length > 0) params.set('drift', filters.drifts.join(','))
  if (filters.risks.length > 0) params.set('risk', filters.risks.join(','))
  if (filters.sort !== DEFAULT_FILTERS.sort || filters.reversed) {
    params.set('sort', `${filters.reversed ? '-' : ''}${filters.sort}`)
  }
  if (selected) params.set('selected', selected)

  const text = params.toString()
  return text ? `?${text}` : ''
}
