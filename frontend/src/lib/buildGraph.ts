import type { DependencyDrift } from '../api/scanTypes'
import { driftMeta, isDrifted } from './classify'

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 44
export const ROW_GAP = 16
export const COLUMN_GAP = 300

const ROW_PITCH = NODE_HEIGHT + ROW_GAP
const PACKAGE_X = NODE_WIDTH + COLUMN_GAP

export const GRAPH_VIEWS = ['drifted', 'shared', 'all'] as const
export type GraphView = (typeof GRAPH_VIEWS)[number]

export const GRAPH_VIEW_LABELS: Record<GraphView, string> = {
  drifted: 'Drifted packages',
  shared: 'All shared packages',
  all: 'Every package',
}

export interface LayoutNode {
  id: string
  kind: 'repo' | 'package'
  label: string
  ecosystem: string
  /** Drift classification of a package node; empty for repositories. */
  drift: string
  /** Used by two or more repositories. */
  shared: boolean
  x: number
  y: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  declared_range: string
  resolved_version: string | null
}

export interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  height: number
  totalPackages: number
  hiddenPackages: number
}

export const repoNodeId = (name: string) => `repo:${name}`

function inView(row: DependencyDrift, view: GraphView): boolean {
  if (view === 'all') return true
  if (view === 'shared') return row.present_in_repos.length > 1
  return isDrifted(row.drift_disparity)
}

/** The most useful default: drifted packages if there are any, else shared ones. */
export function defaultGraphView(rows: readonly DependencyDrift[]): GraphView {
  if (rows.some((row) => isDrifted(row.drift_disparity))) return 'drifted'
  return rows.some((row) => row.present_in_repos.length > 1) ? 'shared' : 'all'
}

/**
 * Deterministic two-column layout built only from the drift matrix:
 * repositories on the left, packages on the right, one row each, so nodes can
 * never overlap. Every edge is a declaration the backend reported; no
 * service-to-service links are inferred.
 */
export function buildGraph(
  rows: readonly DependencyDrift[],
  repoOrder: readonly string[],
  view: GraphView,
): GraphLayout {
  const visible = rows
    .filter((row) => inView(row, view))
    .sort(
      (a, b) =>
        driftMeta(b.drift_disparity).rank - driftMeta(a.drift_disparity).rank ||
        b.present_in_repos.length - a.present_in_repos.length ||
        a.dependency_name.localeCompare(b.dependency_name),
    )

  const edges: LayoutEdge[] = []
  const connected = new Set<string>()
  for (const row of visible) {
    for (const [repo, declaration] of Object.entries(row.declarations_by_repo)) {
      connected.add(repo)
      edges.push({
        id: `${repo}->${row.id}`,
        source: repoNodeId(repo),
        target: row.id,
        declared_range: declaration.declared_range,
        resolved_version: declaration.resolved_version,
      })
    }
  }

  const repos = [
    ...repoOrder.filter((name) => connected.has(name)),
    ...[...connected].filter((name) => !repoOrder.includes(name)),
  ]

  const rowCount = Math.max(repos.length, visible.length, 1)
  const height = rowCount * ROW_PITCH - ROW_GAP
  const columnTop = (count: number) => (height - (count * ROW_PITCH - ROW_GAP)) / 2
  const repoTop = columnTop(repos.length)
  const packageTop = columnTop(visible.length)

  const nodes: LayoutNode[] = [
    ...repos.map((name, index) => ({
      id: repoNodeId(name),
      kind: 'repo' as const,
      label: name,
      ecosystem: '',
      drift: '',
      shared: false,
      x: 0,
      y: repoTop + index * ROW_PITCH,
    })),
    ...visible.map((row, index) => ({
      id: row.id,
      kind: 'package' as const,
      label: row.dependency_name,
      ecosystem: row.ecosystem,
      drift: row.drift_disparity,
      shared: row.present_in_repos.length > 1,
      x: PACKAGE_X,
      y: packageTop + index * ROW_PITCH,
    })),
  ]

  return { nodes, edges, height, totalPackages: rows.length, hiddenPackages: rows.length - visible.length }
}
