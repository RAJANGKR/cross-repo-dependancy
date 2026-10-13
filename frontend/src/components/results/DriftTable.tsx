import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { memo, useCallback, type KeyboardEvent } from 'react'
import type { DependencyDrift, RepoDeclaration } from '../../api/scanTypes'
import { useKeyboardNav } from '../../hooks/useKeyboardNav'
import { cx } from '../../lib/cx'
import type { SortKey } from '../../lib/filterSort'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { EcosystemTag } from '../common/Tags'

/** Natural direction of each sort, used for aria-sort. */
const NATURAL_ORDER: Record<SortKey, 'ascending' | 'descending'> = {
  drift: 'descending',
  risk: 'descending',
  name: 'ascending',
  ecosystem: 'ascending',
}

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  active: SortKey
  reversed: boolean
  onSort: (key: SortKey) => void
}

function SortHeader({ label, sortKey, active, reversed, onSort }: SortHeaderProps) {
  const isActive = active === sortKey
  const natural = NATURAL_ORDER[sortKey]
  const direction = !isActive ? 'none' : reversed ? (natural === 'ascending' ? 'descending' : 'ascending') : natural
  const Icon = direction === 'none' ? ChevronsUpDown : direction === 'ascending' ? ArrowUp : ArrowDown
  return (
    <th scope="col" aria-sort={direction} className="px-4 py-3 text-left align-bottom font-normal">
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

/** One repository's view of a package. Declared and resolved are never merged. */
function DeclarationCell({ declaration }: { declaration: RepoDeclaration | undefined }) {
  if (!declaration) {
    return <span className="text-sm text-muted-foreground">Not declared</span>
  }
  return (
    <dl className="space-y-1 text-xs">
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">Declared</dt>
        <dd className="break-all font-mono">{declaration.declared_range || 'Not provided'}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">Resolved</dt>
        <dd className={cx('break-all', declaration.resolved_version ? 'font-mono tabular-nums' : 'text-muted-foreground')}>
          {declaration.resolved_version ?? 'Not resolved'}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="w-16 shrink-0 text-muted-foreground">Source</dt>
        <dd className="break-all text-muted-foreground">
          {declaration.source_file || 'Not provided'}
          {declaration.dep_type && declaration.dep_type !== 'runtime' && ` (${declaration.dep_type})`}
        </dd>
      </div>
    </dl>
  )
}

interface DriftRowProps {
  row: DependencyDrift
  repos: readonly string[]
  index: number
  active: boolean
  selected: boolean
  onSelect: (id: string) => void
  onFocusRow: (index: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  registerRow: (index: number) => (element: HTMLElement | null) => void
}

const DriftRow = memo(function DriftRow({
  row,
  repos,
  index,
  active,
  selected,
  onSelect,
  onFocusRow,
  onKeyDown,
  registerRow,
}: DriftRowProps) {
  return (
    <tr
      ref={registerRow(index)}
      tabIndex={active ? 0 : -1}
      aria-selected={selected}
      aria-rowindex={index + 2}
      onClick={() => onSelect(row.id)}
      onFocus={() => onFocusRow(index)}
      onKeyDown={onKeyDown}
      className={cx(
        'cursor-pointer border-t border-border transition-colors hover:bg-secondary/60 focus-visible:-outline-offset-2',
        selected && 'bg-secondary',
      )}
    >
      <th scope="row" className="px-4 py-4 text-left align-top font-medium">
        <span className="break-all">{row.dependency_name}</span>
        <span className="mt-1.5 block">
          <EcosystemTag ecosystem={row.ecosystem} />
        </span>
      </th>
      {repos.map((repo) => (
        <td key={repo} className="px-4 py-4 align-top">
          <DeclarationCell declaration={row.declarations_by_repo[repo]} />
        </td>
      ))}
      <td className="px-4 py-4 align-top">
        <DriftBadge value={row.drift_disparity} />
      </td>
      <td className="px-4 py-4 align-top">
        <RiskBadge value={row.compatibility_risk} />
      </td>
    </tr>
  )
})

interface DriftTableProps {
  rows: DependencyDrift[]
  /** Repository names, one column each. */
  repos: readonly string[]
  repoLabel: (name: string) => string
  selectedId: string | null
  onSelect: (id: string) => void
  sort: SortKey
  reversed: boolean
  onSort: (key: SortKey) => void
}

export function DriftTable({ rows, repos, repoLabel, selectedId, onSelect, sort, reversed, onSort }: DriftTableProps) {
  const activate = useCallback(
    (index: number) => {
      const row = rows[index]
      if (row) onSelect(row.id)
    },
    [rows, onSelect],
  )
  const nav = useKeyboardNav(rows.length, activate)

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table
        role="grid"
        aria-label="Dependency comparison across repositories"
        aria-rowcount={rows.length + 1}
        className="w-full min-w-[64rem] border-collapse text-sm"
      >
        <caption className="sr-only">
          One row per package. Use the up and down arrow keys to move between rows, Home and End to jump to the
          first or last row, and Enter or Space to open the details.
        </caption>
        <thead>
          <tr aria-rowindex={1}>
            <SortHeader label="Package" sortKey="name" active={sort} reversed={reversed} onSort={onSort} />
            {repos.map((repo) => {
              const label = repoLabel(repo)
              return (
                <th key={repo} scope="col" className="px-4 py-3 text-left align-bottom font-normal">
                  <span className="block text-sm font-medium">{label}</span>
                  {label !== repo && <span className="block font-mono text-xs text-muted-foreground">{repo}</span>}
                </th>
              )
            })}
            <SortHeader label="Drift" sortKey="drift" active={sort} reversed={reversed} onSort={onSort} />
            <SortHeader label="Compatibility risk" sortKey="risk" active={sort} reversed={reversed} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={repos.length + 3} className="border-t border-border px-4 py-12 text-center text-muted-foreground">
                No packages match these filters
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <DriftRow
                key={row.id}
                row={row}
                repos={repos}
                index={index}
                active={index === nav.activeIndex}
                selected={row.id === selectedId}
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
