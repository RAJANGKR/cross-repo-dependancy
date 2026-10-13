import { Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useDebouncedValue } from '../../hooks/useUi'
import { driftMeta, riskMeta, type ClassMeta } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { hasActiveFilters, SORT_KEYS, SORT_LABELS, type DriftFilters } from '../../lib/filterSort'
import { ecosystemLabel } from '../../lib/formatters'
import { Button } from '../common/Button'

const SEARCH_DEBOUNCE_MS = 200

const CHIP = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors [&_svg]:size-3.5'
const CHIP_OFF = 'border-border bg-card text-foreground/70 hover:border-foreground/40 hover:text-foreground'
const CHIP_ON = 'border-foreground bg-foreground text-background'

function toggle(list: readonly string[], item: string): string[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item]
}

interface ChipGroupProps {
  label: string
  values: string[]
  selected: string[]
  labelOf: (value: string) => string
  onToggle: (value: string) => void
}

function ChipGroup({ label, values, selected, labelOf, onToggle }: ChipGroupProps) {
  if (values.length === 0) return null
  return (
    <div role="group" aria-label={`Filter by ${label.toLowerCase()}`} className="flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className="font-mono text-xs uppercase text-muted-foreground">
        {label}
      </span>
      {values.map((value) => {
        const on = selected.includes(value)
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(value)}
            className={cx(CHIP, on ? CHIP_ON : CHIP_OFF)}
          >
            {labelOf(value)}
          </button>
        )
      })}
    </div>
  )
}

/** Known classifications first in severity order, then anything unrecognized. */
function ordered(values: string[], meta: (value: string) => ClassMeta): string[] {
  return [...values].sort((a, b) => meta(b).rank - meta(a).rank)
}

interface FiltersProps {
  filters: DriftFilters
  onChange: (filters: DriftFilters) => void
  ecosystems: string[]
  drifts: string[]
  risks: string[]
  /** Repository picked from the graph, or null. */
  repo: string | null
  repoLabel: (name: string) => string
  onClearRepo: () => void
  onClearAll: () => void
  shown: number
  total: number
}

export function Filters({
  filters,
  onChange,
  ecosystems,
  drifts,
  risks,
  repo,
  repoLabel,
  onClearRepo,
  onClearAll,
  shown,
  total,
}: FiltersProps) {
  const searchId = useId()
  const sortId = useId()

  // The box updates at once; the filter (and the URL) follow after a short pause.
  const [text, setText] = useState(filters.query)
  const debounced = useDebouncedValue(text, SEARCH_DEBOUNCE_MS)
  const applied = useRef(filters.query)
  const latest = useRef({ filters, onChange })
  useEffect(() => {
    latest.current = { filters, onChange }
  })

  useEffect(() => {
    if (debounced === applied.current) return
    applied.current = debounced
    latest.current.onChange({ ...latest.current.filters, query: debounced })
  }, [debounced])

  useEffect(() => {
    if (filters.query === applied.current) return
    applied.current = filters.query
    setText(filters.query)
  }, [filters.query])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="min-w-56 flex-1">
          <label htmlFor={searchId} className="block font-mono text-xs uppercase text-muted-foreground">
            Search packages
          </label>
          <div className="relative mt-1.5">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              id={searchId}
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Package name"
              autoComplete="off"
              spellCheck={false}
              className="h-10 w-full rounded-full border border-input bg-card pl-9 pr-4 text-sm placeholder:text-muted-foreground/70"
            />
          </div>
        </div>
        <div>
          <label htmlFor={sortId} className="block font-mono text-xs uppercase text-muted-foreground">
            Sort by
          </label>
          <select
            id={sortId}
            value={filters.sort}
            onChange={(event) => {
              const sort = SORT_KEYS.find((key) => key === event.target.value)
              if (sort) onChange({ ...filters, sort, reversed: false })
            }}
            className="mt-1.5 h-10 rounded-full border border-input bg-card px-4 text-sm"
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <ChipGroup
          label="Drift"
          values={ordered(drifts, driftMeta)}
          selected={filters.drifts}
          labelOf={(value) => driftMeta(value).label}
          onToggle={(value) => onChange({ ...filters, drifts: toggle(filters.drifts, value) })}
        />
        <ChipGroup
          label="Risk"
          values={ordered(risks, riskMeta)}
          selected={filters.risks}
          labelOf={(value) => riskMeta(value).label}
          onToggle={(value) => onChange({ ...filters, risks: toggle(filters.risks, value) })}
        />
        <ChipGroup
          label="Ecosystem"
          values={ecosystems}
          selected={filters.ecosystems}
          labelOf={ecosystemLabel}
          onToggle={(value) => onChange({ ...filters, ecosystems: toggle(filters.ecosystems, value) })}
        />
        {repo !== null && (
          <span className={cx(CHIP, 'border-foreground/40 bg-secondary pr-1')}>
            Repository: {repoLabel(repo)}
            <button
              type="button"
              onClick={onClearRepo}
              aria-label={`Remove repository filter ${repoLabel(repo)}`}
              className="rounded-full p-1 hover:bg-foreground/10"
            >
              <X aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <p role="status" className="text-sm text-muted-foreground">
          Showing <span className="tabular-nums text-foreground">{shown}</span> of{' '}
          <span className="tabular-nums text-foreground">{total}</span> packages
        </p>
        {hasActiveFilters(filters, repo) && (
          <Button size="sm" variant="ghost" onClick={onClearAll}>
            <X aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
