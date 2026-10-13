import { Search, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { RISK_LEVELS, type RiskLevel } from '../../api/types'
import { useDebouncedValue } from '../../hooks/useUi'
import { cx } from '../../lib/cx'
import { hasActiveFilters, SORT_KEYS, SORT_LABELS, type DriftFilters, type SortKey } from '../../lib/filterSort'
import { ecosystemLabel } from '../../lib/formatters'
import { RISK_STYLES } from '../../lib/risk'
import { Button } from '../common/Button'
import { RISK_ICONS } from '../common/RiskBadge'

const SEARCH_DEBOUNCE_MS = 200

const CHIP =
  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors [&_svg]:size-3.5'
const CHIP_OFF = 'border-border bg-card text-foreground/70 hover:border-foreground/40 hover:text-foreground'
const CHIP_ON = 'border-foreground bg-foreground text-background'

function toggle<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((value) => value !== item) : [...list, item]
}

interface FiltersProps {
  filters: DriftFilters
  onChange: (filters: DriftFilters) => void
  ecosystems: string[]
  /** Project picked from the graph, or null. */
  project: string | null
  onClearProject: () => void
  onClearAll: () => void
  shown: number
  total: number
}

export function Filters({ filters, onChange, ecosystems, project, onClearProject, onClearAll, shown, total }: FiltersProps) {
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
            Search
          </label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id={searchId}
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Library or project name"
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
            {SORT_KEYS.map((key: SortKey) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div role="group" aria-label="Filter by risk" className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className="font-mono text-xs uppercase text-muted-foreground">
            Risk
          </span>
          {RISK_LEVELS.map((level: RiskLevel) => {
            const Icon = RISK_ICONS[level]
            const on = filters.risks.includes(level)
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ ...filters, risks: toggle(filters.risks, level) })}
                className={cx(CHIP, on ? CHIP_ON : CHIP_OFF)}
              >
                <Icon aria-hidden="true" className={on ? undefined : RISK_STYLES[level].text} />
                {level}
              </button>
            )
          })}
        </div>

        {ecosystems.length > 0 && (
          <div role="group" aria-label="Filter by ecosystem" className="flex flex-wrap items-center gap-2">
            <span aria-hidden="true" className="font-mono text-xs uppercase text-muted-foreground">
              Ecosystem
            </span>
            {ecosystems.map((ecosystem) => {
              const on = filters.ecosystems.includes(ecosystem)
              return (
                <button
                  key={ecosystem}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange({ ...filters, ecosystems: toggle(filters.ecosystems, ecosystem) })}
                  className={cx(CHIP, on ? CHIP_ON : CHIP_OFF)}
                >
                  {ecosystemLabel(ecosystem)}
                </button>
              )
            })}
          </div>
        )}

        {project !== null && (
          <span className={cx(CHIP, 'border-foreground/40 bg-secondary pr-1')}>
            Project: {project}
            <button
              type="button"
              onClick={onClearProject}
              aria-label={`Remove project filter ${project}`}
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
          <span className="tabular-nums text-foreground">{total}</span> drifts
        </p>
        {hasActiveFilters(filters, project) && (
          <Button size="sm" variant="ghost" onClick={onClearAll}>
            <X aria-hidden="true" />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
