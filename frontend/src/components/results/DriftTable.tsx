import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { memo, useCallback, type KeyboardEvent } from 'react'
import type { Drift } from '../../api/types'
import { useKeyboardNav } from '../../hooks/useKeyboardNav'
import { cx } from '../../lib/cx'
import type { SortKey } from '../../lib/filterSort'
import { LOW_CONFIDENCE_THRESHOLD } from '../../lib/formatters'
import { RiskBadge } from '../common/RiskBadge'
import { EcosystemTag, Tag, VersionChip } from '../common/Tags'
import { Tooltip } from '../common/Tooltip'
import { CONFIDENCE_HINT, ConfidenceMeter } from '../detail/ConfidenceMeter'

const VISIBLE_VERSIONS = 3

/** Natural direction of each sort, used for aria-sort. */
const NATURAL_ORDER: Record<SortKey, 'ascending' | 'descending'> = {
  risk: 'descending',
  score: 'descending',
  library: 'ascending',
  projects: 'descending',
}

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  active: SortKey
  reversed: boolean
  onSort: (key: SortKey) => void
  className?: string
}

function SortHeader({ label, sortKey, active, reversed, onSort, className }: SortHeaderProps) {
  const isActive = active === sortKey
  const natural = NATURAL_ORDER[sortKey]
  const direction = !isActive ? 'none' : reversed ? (natural === 'ascending' ? 'descending' : 'ascending') : natural
  const Icon = direction === 'none' ? ChevronsUpDown : direction === 'ascending' ? ArrowUp : ArrowDown
  return (
    <th scope="col" aria-sort={direction} className={cx('px-4 py-3 text-left font-normal', className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cx(
          'inline-flex items-center gap-1 rounded-sm font-mono text-xs uppercase transition-colors hover:text-foreground',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {label}
        <Icon aria-hidden="true" className="size-3.5" />
      </button>
    </th>
  )
}

function PlainHeader({ label, hint, className }: { label: string; hint?: string; className?: string }) {
  return (
    <th scope="col" className={cx('px-4 py-3 text-left font-mono text-xs font-normal uppercase text-muted-foreground', className)}>
      {hint ? (
        <Tooltip label={hint} focusable>
          <span className="underline decoration-dotted underline-offset-4">{label}</span>
        </Tooltip>
      ) : (
        label
      )}
    </th>
  )
}

interface DriftRowProps {
  drift: Drift
  index: number
  active: boolean
  selected: boolean
  onSelect: (id: string) => void
  onFocusRow: (index: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  registerRow: (index: number) => (element: HTMLElement | null) => void
}

const DriftRow = memo(function DriftRow({
  drift,
  index,
  active,
  selected,
  onSelect,
  onFocusRow,
  onKeyDown,
  registerRow,
}: DriftRowProps) {
  const visible = drift.versions.slice(0, VISIBLE_VERSIONS)
  const hidden = drift.versions.slice(VISIBLE_VERSIONS)
  const lowConfidence = drift.confidence !== null && drift.confidence < LOW_CONFIDENCE_THRESHOLD

  return (
    <tr
      ref={registerRow(index)}
      tabIndex={active ? 0 : -1}
      aria-selected={selected}
      aria-rowindex={index + 2}
      onClick={() => onSelect(drift.id)}
      onFocus={() => onFocusRow(index)}
      onKeyDown={onKeyDown}
      className={cx(
        'cursor-pointer border-t border-border transition-colors hover:bg-secondary/60 focus-visible:-outline-offset-2',
        selected && 'bg-secondary',
      )}
    >
      <th scope="row" className="px-4 py-4 text-left align-top font-medium">
        <span className="break-all">{drift.library}</span>
      </th>
      <td className="px-4 py-4 align-top">
        <EcosystemTag ecosystem={drift.ecosystem} />
      </td>
      <td className="px-4 py-4 align-top">
        {drift.versions.length === 0 ? (
          <span className="text-sm text-muted-foreground">Not available</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {visible.map((entry) => (
              <VersionChip key={`${entry.repo}:${entry.file}`} repo={entry.repo} version={entry.version} />
            ))}
            {hidden.length > 0 && (
              <Tooltip
                focusable
                label={hidden.map((entry) => `${entry.repo} ${entry.version}`).join(', ')}
              >
                <span className="rounded-sm bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
                  +{hidden.length} more
                </span>
              </Tooltip>
            )}
          </span>
        )}
      </td>
      <td className="px-4 py-4 align-top font-mono text-xs">{drift.gap}</td>
      <td className="px-4 py-4 align-top">
        <RiskBadge level={drift.risk} />
      </td>
      <td className="px-4 py-4 text-right align-top font-mono tabular-nums">{drift.score}</td>
      <td className="px-4 py-4 align-top">
        <span className="flex flex-col items-start gap-1.5">
          <ConfidenceMeter confidence={drift.confidence} />
          {lowConfidence && <Tag tone="warning">Low confidence</Tag>}
        </span>
      </td>
    </tr>
  )
})

interface DriftTableProps {
  drifts: Drift[]
  selectedId: string | null
  onSelect: (id: string) => void
  sort: SortKey
  reversed: boolean
  onSort: (key: SortKey) => void
}

export function DriftTable({ drifts, selectedId, onSelect, sort, reversed, onSort }: DriftTableProps) {
  const activate = useCallback(
    (index: number) => {
      const drift = drifts[index]
      if (drift) onSelect(drift.id)
    },
    [drifts, onSelect],
  )
  const nav = useKeyboardNav(drifts.length, activate)

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table
        role="grid"
        aria-label="Drifted libraries"
        aria-rowcount={drifts.length + 1}
        aria-describedby="drift-table-help"
        className="w-full min-w-[56rem] border-collapse text-sm"
      >
        <caption id="drift-table-help" className="sr-only">
          Use the up and down arrow keys to move between rows, Home and End to jump to the first or last
          row, and Enter or Space to open the details.
        </caption>
        <thead>
          <tr aria-rowindex={1}>
            <SortHeader label="Library" sortKey="library" active={sort} reversed={reversed} onSort={onSort} />
            <PlainHeader label="Ecosystem" />
            <SortHeader label="Versions by project" sortKey="projects" active={sort} reversed={reversed} onSort={onSort} />
            <PlainHeader label="Gap" />
            <SortHeader label="Risk" sortKey="risk" active={sort} reversed={reversed} onSort={onSort} />
            <SortHeader label="Score" sortKey="score" active={sort} reversed={reversed} onSort={onSort} className="text-right" />
            <PlainHeader label="Confidence" hint={CONFIDENCE_HINT} />
          </tr>
        </thead>
        <tbody>
          {drifts.length === 0 ? (
            <tr>
              <td colSpan={7} className="border-t border-border px-4 py-12 text-center text-muted-foreground">
                No drifts match these filters
              </td>
            </tr>
          ) : (
            drifts.map((drift, index) => (
              <DriftRow
                key={drift.id}
                drift={drift}
                index={index}
                active={index === nav.activeIndex}
                selected={drift.id === selectedId}
                onSelect={onSelect}
                onFocusRow={nav.setActiveIndex}
                onKeyDown={nav.onKeyDown}
                registerRow={nav.registerRow}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}
