import '@xyflow/react/dist/base.css'

import { Handle, Panel, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react'
import { FolderGit2, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { memo, useCallback, useId, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { DependencyDrift } from '../../api/scanTypes'
import { useReducedMotion } from '../../hooks/useReducedMotion'
import {
  buildGraph,
  defaultGraphView,
  GRAPH_VIEW_LABELS,
  GRAPH_VIEWS,
  NODE_HEIGHT,
  NODE_WIDTH,
  repoNodeId,
  type GraphView,
} from '../../lib/buildGraph'
import { driftMeta, isDrifted, TONE_STYLES } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { driftIcon } from '../common/Badges'

type NodeData = {
  label: string
  /** Repository label chosen by the user, when it differs from the name. */
  sublabel: string
  drift: string
  shared: boolean
  selected: boolean
  dimmed: boolean
}

type RepoFlowNode = Node<NodeData, 'repo'>
type PackageFlowNode = Node<NodeData, 'package'>
type FlowNode = RepoFlowNode | PackageFlowNode
type FlowEdge = Edge<{ declared_range: string; resolved_version: string | null }>

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
      <span className="min-w-0">
        <span className="block truncate font-medium leading-tight">{data.sublabel || data.label}</span>
        {data.sublabel && <span className="block truncate font-mono text-[0.625rem] text-muted-foreground">{data.label}</span>}
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} className={HANDLE} />
    </div>
  )
})

const PackageNode = memo(function PackageNode({ data }: NodeProps<PackageFlowNode>) {
  const meta = driftMeta(data.drift)
  const drifted = isDrifted(data.drift)
  const style = TONE_STYLES[meta.tone]
  const Icon = driftIcon(data.drift)
  return (
    <div
      className={cx(
        NODE_BASE,
        drifted ? cx(style.border, style.tint) : 'border-border',
        // Packages used by a single repository get a dashed outline.
        !data.shared && 'border-dashed',
        data.selected && 'ring-2 ring-foreground',
        data.dimmed && 'opacity-30',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className={HANDLE} />
      <Icon aria-hidden="true" className={cx('size-4 shrink-0', style.text)} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{data.label}</span>
      <span className={cx('shrink-0 text-[0.6875rem] font-medium', style.text)}>
        {drifted ? meta.label : data.shared ? 'Shared' : 'Single'}
      </span>
    </div>
  )
})

const NODE_TYPES = { repo: RepoNode, package: PackageNode }

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
  repo: string
  declared: string
  resolved: string | null
}

interface DependencyGraphProps {
  rows: readonly DependencyDrift[]
  repos: readonly string[]
  repoLabel: (name: string) => string
  selectedId: string | null
  /** Repository the table is filtered to, or null. */
  repo: string | null
  /** Use most of the viewport height (full-screen mode). */
  tall?: boolean
  onSelectPackage: (id: string) => void
  onToggleRepo: (name: string) => void
}

export default function DependencyGraph({
  rows,
  repos,
  repoLabel,
  selectedId,
  repo,
  tall = false,
  onSelectPackage,
  onToggleRepo,
}: DependencyGraphProps) {
  const [legend, setLegend] = useState(true)
  const [view, setView] = useState<GraphView>(() => defaultGraphView(rows))
  const [hovered, setHovered] = useState<string | null>(null)
  const [edgeTip, setEdgeTip] = useState<EdgeTip | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const viewId = useId()
  const summaryId = useId()

  // Layout depends only on the data and the chosen view, never on hover or selection.
  const layout = useMemo(() => buildGraph(rows, repos, view), [rows, repos, view])

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

  const selectedRepoNode = repo === null ? null : repoNodeId(repo)

  const nodes = useMemo<FlowNode[]>(
    () =>
      layout.nodes.map((node) => {
        const related = hovered === null || node.id === hovered || (neighbors.get(hovered)?.has(node.id) ?? false)
        const label = node.kind === 'repo' ? repoLabel(node.label) : ''
        const data: NodeData = {
          label: node.label,
          sublabel: label !== node.label ? label : '',
          drift: node.drift,
          shared: node.shared,
          selected: node.kind === 'package' ? node.id === selectedId : node.id === selectedRepoNode,
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
    [layout.nodes, hovered, neighbors, selectedId, selectedRepoNode, repoLabel],
  )

  const edges = useMemo<FlowEdge[]>(
    () =>
      layout.edges.map((edge) => {
        const touchesHover = hovered !== null && (edge.source === hovered || edge.target === hovered)
        const touchesSelection = edge.target === selectedId || edge.source === selectedRepoNode
        const emphasized = touchesHover || (hovered === null && touchesSelection)
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          data: { declared_range: edge.declared_range, resolved_version: edge.resolved_version },
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
    [layout.edges, hovered, selectedId, selectedRepoNode],
  )

  const onNodeClick = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      if (node.type === 'package') onSelectPackage(node.id)
      else onToggleRepo(node.data.label)
    },
    [onSelectPackage, onToggleRepo],
  )

  const showEdgeTip = useCallback((event: MouseEvent, edge: FlowEdge) => {
    const bounds = containerRef.current?.getBoundingClientRect()
    if (!bounds) return
    setEdgeTip({
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      repo: edge.source.replace(/^repo:/, ''),
      declared: edge.data?.declared_range ?? '',
      resolved: edge.data?.resolved_version ?? null,
    })
  }, [])

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-6 py-12 text-center text-muted-foreground">
        No dependency relationships were returned, so there is no graph to draw.
      </p>
    )
  }

  const height = tall ? 'calc(100vh - 14rem)' : Math.min(640, Math.max(320, layout.height + 96))

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Repositories on the left, packages on the right. Each line is a dependency one repository declares.
          Dashed packages are used by a single repository. Select a package for its details, or a repository
          to filter the table.
        </p>
        <div className="flex items-end gap-4">
          <label className="inline-flex cursor-pointer items-center gap-2 pb-2.5 text-sm">
            <input type="checkbox" role="switch" checked={legend} onChange={(event) => setLegend(event.target.checked)} className="size-4 accent-foreground" />
            Legend
          </label>
          <div>
          <label htmlFor={viewId} className="block font-mono text-xs uppercase text-muted-foreground">
            Show
          </label>
          <select
            id={viewId}
            value={view}
            onChange={(event) => {
              const next = GRAPH_VIEWS.find((option) => option === event.target.value)
              if (next) setView(next)
            }}
            className="mt-1.5 h-10 rounded-full border border-input bg-card px-4 text-sm"
          >
            {GRAPH_VIEWS.map((option) => (
              <option key={option} value={option}>
                {GRAPH_VIEW_LABELS[option]}
              </option>
            ))}
          </select>
          </div>
        </div>
      </div>

      {layout.nodes.length === 0 || layout.edges.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-6 py-12 text-center text-muted-foreground">
          No packages fall into this view. Choose another option under Show.
        </p>
      ) : (
        <div
          ref={containerRef}
          role="region"
          aria-label="Dependency graph"
          aria-describedby={summaryId}
          className="relative overflow-hidden rounded-lg border border-border bg-background"
          style={{ height }}
        >
          <ReactFlow<FlowNode, FlowEdge>
            key={view}
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

          {legend && (
            <ul aria-label="Legend" className="pointer-events-none absolute right-3 top-3 z-10 space-y-1 rounded-md border border-border bg-card/95 p-2.5 text-xs shadow-nav">
              <li className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 rounded-sm border border-risk-high bg-risk-high-tint" />Major drift</li>
              <li className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 rounded-sm border border-risk-medium bg-risk-medium-tint" />Minor drift</li>
              <li className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 rounded-sm border border-border" />Shared, no drift</li>
              <li className="flex items-center gap-2"><span aria-hidden="true" className="h-3 w-5 rounded-sm border border-dashed border-foreground/50" />One repository</li>
            </ul>
          )}
          {edgeTip && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 rounded-sm bg-foreground px-2.5 py-1.5 text-xs text-background shadow-pop"
              style={{ left: edgeTip.x + 12, top: edgeTip.y + 12 }}
            >
              <p className="font-medium">{repoLabel(edgeTip.repo)}</p>
              <p>
                Declared <span className="font-mono">{edgeTip.declared || 'not provided'}</span>
              </p>
              <p>
                Resolved <span className="font-mono">{edgeTip.resolved ?? 'not resolved'}</span>
              </p>
            </div>
          )}
        </div>
      )}

      {layout.hiddenPackages > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {layout.hiddenPackages} of {layout.totalPackages} packages are not in this view.
        </p>
      )}

      {/* Text alternative. The comparison table carries the same information. */}
      <div id={summaryId} className="sr-only">
        <p>Graph summary. The comparison table lists the same information.</p>
        <ul>
          {rows
            .filter((row) => layout.nodes.some((node) => node.id === row.id))
            .map((row) => (
              <li key={row.id}>
                {row.dependency_name}, {driftMeta(row.drift_disparity).label}:{' '}
                {Object.entries(row.declarations_by_repo)
                  .map(([name, declaration]) => `${name} declares ${declaration.declared_range}`)
                  .join(', ')}
              </li>
            ))}
        </ul>
      </div>
    </div>
  )
}
