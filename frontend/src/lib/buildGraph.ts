import type { ReportGraph, RiskLevel } from '../api/types'
import { ecosystemOfId, libraryLabel } from './formatters'
import { RISK_RANK } from './risk'

export const NODE_WIDTH = 220
export const NODE_HEIGHT = 44
export const ROW_GAP = 16
export const COLUMN_GAP = 300
/** Above this many library nodes the full view gets a density note. */
export const LARGE_GRAPH_THRESHOLD = 60

const ROW_PITCH = NODE_HEIGHT + ROW_GAP
const LIBRARY_X = NODE_WIDTH + COLUMN_GAP

export interface LayoutNode {
  id: string
  kind: 'repo' | 'library'
  label: string
  ecosystem: string
  risk: RiskLevel | null
  drifted: boolean
  x: number
  y: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
  version: string
  raw_spec: string
}

export interface GraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  height: number
  /** Library nodes in the report, drifted or not. */
  totalLibraries: number
  /** Library nodes left out of this layout. */
  hiddenLibraries: number
}

/**
 * Deterministic two-column layout: projects on the left, libraries on the
 * right, one row each, so nodes can never overlap. By default only drifted
 * libraries and the projects that use them are included.
 */
export function buildGraph(graph: ReportGraph, options: { showAll: boolean }): GraphLayout {
  const libraries = graph.nodes.filter((node) => node.type === 'library')
  const visibleLibraries = libraries
    .filter((node) => options.showAll || node.drifted)
    .sort(
      (a, b) =>
        Number(b.drifted) - Number(a.drifted) ||
        (b.risk ? RISK_RANK[b.risk] : -1) - (a.risk ? RISK_RANK[a.risk] : -1) ||
        a.id.localeCompare(b.id),
    )
  const libraryIds = new Set(visibleLibraries.map((node) => node.id))

  const repoIds = new Set(
    graph.nodes.filter((node) => node.type === 'repo').map((node) => node.id),
  )
  const seenEdges = new Set<string>()
  const edges: LayoutEdge[] = []
  for (const edge of graph.edges) {
    const id = `${edge.source}->${edge.target}`
    if (!repoIds.has(edge.source) || !libraryIds.has(edge.target) || seenEdges.has(id)) continue
    seenEdges.add(id)
    edges.push({ id, ...edge })
  }

  const connectedRepos = new Set(edges.map((edge) => edge.source))
  const visibleRepos = graph.nodes.filter(
    (node) => node.type === 'repo' && connectedRepos.has(node.id),
  )

  const rows = Math.max(visibleRepos.length, visibleLibraries.length, 1)
  const height = rows * ROW_PITCH - ROW_GAP
  const columnTop = (count: number) => (height - (count * ROW_PITCH - ROW_GAP)) / 2

  const repoTop = columnTop(visibleRepos.length)
  const libraryTop = columnTop(visibleLibraries.length)

  const nodes: LayoutNode[] = [
    ...visibleRepos.map((node, index) => ({
      id: node.id,
      kind: 'repo' as const,
      label: node.id,
      ecosystem: '',
      risk: null,
      drifted: false,
      x: 0,
      y: repoTop + index * ROW_PITCH,
    })),
    ...visibleLibraries.map((node, index) => ({
      id: node.id,
      kind: 'library' as const,
      label: libraryLabel(node.id),
      ecosystem: ecosystemOfId(node.id),
      risk: node.drifted ? node.risk : null,
      drifted: node.drifted,
      x: LIBRARY_X,
      y: libraryTop + index * ROW_PITCH,
    })),
  ]

  return {
    nodes,
    edges,
    height,
    totalLibraries: libraries.length,
    hiddenLibraries: libraries.length - visibleLibraries.length,
  }
}
