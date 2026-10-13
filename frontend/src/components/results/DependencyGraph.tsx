import '@xyflow/react/dist/base.css'

import {
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import { FolderGit2, Maximize, Package, ZoomIn, ZoomOut } from 'lucide-react'
import { memo, useCallback, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { Drift, ReportGraph, RiskLevel } from '../../api/types'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import {
  buildGraph,
  LARGE_GRAPH_THRESHOLD,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutEdge,
} from '../../lib/buildGraph'
import { cx } from '../../lib/cx'
import { ecosystemLabel } from '../../lib/formatters'
import { RISK_STYLES } from '../../lib/risk'
import { RISK_ICONS } from '../common/RiskBadge'

type NodeData = {
  label: string
  ecosystem: string
  risk: RiskLevel | null
  drifted: boolean
  /** Selected drift, or the project the table is filtered to. */
  selected: boolean
  dimmed: boolean
}

type RepoFlowNode = Node<NodeData, 'repo'>
type LibraryFlowNode = Node<NodeData, 'library'>
type FlowNode = RepoFlowNode | LibraryFlowNode
type FlowEdge = Edge<Pick<LayoutEdge, 'version' | 'raw_spec'>>

const NODE_BASE =
  'flex h-full w-full cursor-pointer items-center gap-2 rounded-md border bg-card px-3 text-sm transition-opacity duration-200'
const HANDLE = '!h-px !w-px !min-w-0 !border-0 !bg-transparent'

const RepoNode = memo(function RepoNode({ data }: NodeProps<RepoFlowNode>) {
  return (
    <div
      className={cx(
        NODE_BASE,
        data.selected ? 'border-foreground ring-2 ring-foreground' : 'border-foreground/30',
        data.dimmed && 'opacity-30',
      )}
    >
      <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium">{data.label}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />
    </div>
  )
})

const LibraryNode = memo(function LibraryNode({ data }: NodeProps<LibraryFlowNode>) {
  const style = data.risk ? RISK_STYLES[data.risk] : null
  const Icon = data.risk ? RISK_ICONS[data.risk] : Package
  return (
    <div
      className={cx(
        NODE_BASE,
        style ? cx(style.border, style.tint) : 'border-border',
        data.selected && 'ring-2 ring-foreground',
        data.dimmed && 'opacity-30',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={HANDLE} />
      <Icon aria-hidden="true" className={cx('size-4 shrink-0', style ? style.text : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{data.label}</span>
      {data.risk && <span className={cx('shrink-0 text-xs font-medium', style?.text)}>{data.risk}</span>}
      {!data.risk && data.ecosystem && (
        <span className="shrink-0 font-mono text-[0.625rem] uppercase text-muted-foreground">
          {ecosystemLabel(data.ecosystem)}
        </span>
      )}
    </div>
  )
})

const NODE_TYPES = { repo: RepoNode, library: LibraryNode }

const CONTROL =
  'flex size-8 items-center justify-center bg-card text-foreground/70 transition-colors hover:bg-secondary hover:text-foreground'

function GraphControls() {
  const flow = useReactFlow()
  const reduced = useReducedMotion()
  const duration = reduced ? 0 : 200
  return (
    <Panel position="bottom-left">
      <div
        role="group"
        aria-label="Graph view controls"
        className="flex divide-x divide-border overflow-hidden rounded-md border border-border shadow-nav"
      >
        <button type="button" aria-label="Zoom in" className={CONTROL} onClick={() => void flow.zoomIn({ duration })}>
          <ZoomIn aria-hidden="true" className="size-4" />
        </button>
        <button type="button" aria-label="Zoom out" className={CONTROL} onClick={() => void flow.zoomOut({ duration })}>
          <ZoomOut aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Fit graph to view"
          className={CONTROL}
          onClick={() => void flow.fitView({ duration, padding: 0.12 })}
        >
          <Maximize aria-hidden="true" className="size-4" />
        </button>
      </div>
    </Panel>
  )
}

interface EdgeTip {
  x: number
  y: number
  source: string
  target: string
  version: string
  raw_spec: string
}

interface DependencyGraphProps {
  graph: ReportGraph
  drifts: readonly Drift[]
  selectedId: string | null
  /** Project the table is filtered to, or null. */
  project: string | null
  onSelectLibrary: (id: string) => void
  onToggleProject: (name: string) => void
}

export default function DependencyGraph({
  graph,
  drifts,
  selectedId,
  project,
  onSelectLibrary,
  onToggleProject,
}: DependencyGraphProps) {
  const [showAll, setShowAll] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [edgeTip, setEdgeTip] = useState<EdgeTip | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const toggleId = useId()
  const summaryId = useId()

  // Layout depends only on the data and the toggle, never on hover or selection.
  const layout = useMemo(() => buildGraph(graph, { showAll }), [graph, showAll])

  const neighbors = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const edge of layout.edges) {
      if (!map.has(edge.source)) map.set(edge.source, new Set())
      if (!map.has(edge.target)) map.set(edge.target, new Set())
      map.get(edge.source)?.add(edge.target)
      map.get(edge.target)?.add(edge.source)
    }
    return map
  }, [layout.edges])

  const nodes = useMemo<FlowNode[]>(
    () =>
      layout.nodes.map((node) => {
        const related = hovered === null || node.id === hovered || (neighbors.get(hovered)?.has(node.id) ?? false)
        const data: NodeData = {
          label: node.label,
          ecosystem: node.ecosystem,
          risk: node.risk,
          drifted: node.drifted,
          selected: node.kind === 'library' ? node.id === selectedId : node.id === project,
          dimmed: !related,
        }
        return {
          id: node.id,
          type: node.kind,
          position: { x: node.x, y: node.y },
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          data,
          draggable: false,
          selectable: false,
          connectable: false,
        } as FlowNode
      }),
    [layout.nodes, hovered, neighbors, selectedId, project],
  )

  const edges = useMemo<FlowEdge[]>(
    () =>
      layout.edges.map((edge) => {
        const touchesHover = hovered !== null && (edge.source === hovered || edge.target === hovered)
        const touchesSelection = edge.target === selectedId || edge.source === project
        const emphasized = touchesHover || (hovered === null && touchesSelection)
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          data: { version: edge.version, raw_spec: edge.raw_spec },
          focusable: false,
          selectable: false,
          style: {
            stroke: emphasized ? 'var(--color-foreground)' : 'var(--color-border)',
            strokeWidth: emphasized ? 1.75 : 1.25,
            opacity: hovered !== null && !touchesHover ? 0.25 : 1,
            transition: 'opacity 200ms, stroke 200ms',
          },
        }
      }),
    [layout.edges, hovered, selectedId, project],
  )

  const onNodeClick = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      if (node.type === 'library') {
        if (node.data.drifted) onSelectLibrary(node.id)
      } else {
        onToggleProject(node.id)
      }
    },
    [onSelectLibrary, onToggleProject],
  )

  const showEdgeTip = useCallback((event: MouseEvent, edge: FlowEdge) => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds) return
    setEdgeTip({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      source: edge.source,
      target: edge.target,
      version: edge.data?.version ?? '',
      raw_spec: edge.data?.raw_spec ?? '',
    })
  }, [])

  const height = Math.min(640, Math.max(320, layout.height + 96))

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Projects on the left, libraries on the right. Select a library for its evidence, or a project to
          filter the table.
        </p>
        <label htmlFor={toggleId} className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            id={toggleId}
            type="checkbox"
            role="switch"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
            className="size-4 accent-foreground"
          />
          Show all dependencies
        </label>
      </div>
      {layout.totalLibraries > LARGE_GRAPH_THRESHOLD && (
        <p className="mb-3 text-sm text-muted-foreground">
          This result has {layout.totalLibraries} libraries. Showing all of them makes the graph dense, so only
          drifted libraries are shown by default.
        </p>
      )}

      <div
        ref={containerRef}
        role="region"
        aria-label="Dependency graph"
        aria-describedby={summaryId}
        className="relative overflow-hidden rounded-lg border border-border bg-background"
        style={{ height }}
      >
        <ReactFlow<FlowNode, FlowEdge>
          key={showAll ? 'all' : 'drifted'}
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.25}
          maxZoom={1.75}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          preventScrolling={false}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={(_event, node) => setHovered(node.id)}
          onNodeMouseLeave={() => setHovered(null)}
          onEdgeMouseEnter={showEdgeTip}
          onEdgeMouseMove={showEdgeTip}
          onEdgeMouseLeave={() => setEdgeTip(null)}
        >
          <GraphControls />
        </ReactFlow>

        {edgeTip && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 rounded-sm bg-foreground px-2.5 py-1.5 text-xs text-background shadow-pop"
            style={{ left: edgeTip.x + 12, top: edgeTip.y + 12 }}
          >
            <p className="font-medium">
              {edgeTip.source} uses version <span className="font-mono">{edgeTip.version || 'unknown'}</span>
            </p>
            <p className="font-mono opacity-80">spec {edgeTip.raw_spec || 'not available'}</p>
          </div>
        )}
      </div>

      {/* Text alternative. The drift table below carries the same information. */}
      <div id={summaryId} className="sr-only">
        <p>Graph summary. The drift table below lists the same information.</p>
        <ul>
          {drifts.map((drift) => (
            <li key={drift.id}>
              {drift.library}, {drift.risk} risk:{' '}
              {drift.versions.map((entry) => `${entry.repo} uses ${entry.version}`).join(', ')}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
