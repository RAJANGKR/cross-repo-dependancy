import { Check, Copy, Download, Upload } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { DependencyDrift, ScanResult } from '../../api/scanTypes'
import { isDrifted, riskMeta } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { downloadText } from '../../lib/exportMarkdown'
import { formatDateTime } from '../../lib/formatters'
import { diffScans, fixKey, fixPlan, fixPlanText, prDescription } from '../../lib/insights'
import { activeReview, clearStore, DEFAULT_SETTINGS, getStore, log, sanitize, setReview, setStore, updateStore, useStore, type HistoryEntry, type ReviewStatus } from '../../lib/localStore'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { Button } from '../common/Button'
import { ConfirmButton, Switch, useCopy, useToast } from '../common/Controls'
import { setSetting, VIEW_META, VIEWS } from './Shell'

const PANEL = 'rounded-lg border border-border bg-card'
const LOCAL = 'Saved in this browser only.'

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="font-display text-3xl tracking-tight lg:text-4xl">{title}</h1>
      {children && <p className="mt-2 max-w-3xl text-muted-foreground">{children}</p>}
    </div>
  )
}

interface ListProps {
  rows: readonly DependencyDrift[]
  repoLabel: (name: string) => string
  onOpen: (id: string) => void
}

// ---- Review queue ------------------------------------------------------------

const REVIEW_FILTERS = ['pending', 'accepted', 'dismissed', 'snoozed'] as const
type ReviewFilter = (typeof REVIEW_FILTERS)[number]

export function ReviewQueue({ rows, onOpen }: ListProps) {
  const { reviews } = useStore()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState<ReviewFilter>('pending')
  const drifted = useMemo(() => rows.filter((row) => isDrifted(row.drift_disparity)), [rows])
  const statusOf = (row: DependencyDrift): ReviewFilter => activeReview(reviews[row.id])?.status ?? 'pending'
  const shown = drifted.filter((row) => statusOf(row) === filter)

  const bulk = (status: ReviewStatus, reason = '') => {
    const before = getStore().reviews
    for (const row of shown) setReview(row.id, { status, reason, until: null })
    log('review', `${shown.length} drifts ${status} in bulk`)
    toast(`${shown.length} drifts ${status}`, () => updateStore((store) => ({ ...store, reviews: before })))
  }

  const importDecisions = async (file: File) => {
    try {
      const data: unknown = JSON.parse(await file.text())
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('shape')
      const before = getStore().reviews
      updateStore((store) => ({ ...store, reviews: { ...store.reviews, ...(data as typeof store.reviews) } }))
      toast('Decisions imported', () => updateStore((store) => ({ ...store, reviews: before })))
    } catch {
      toast('That file is not a DriftLock decisions export')
    }
  }

  return (
    <div>
      <Heading title="Review queue">Decide what to do about each drift. {LOCAL}</Heading>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter by review status" className="flex flex-wrap gap-2">
          {REVIEW_FILTERS.map((name) => (
            <button key={name} type="button" aria-pressed={filter === name} onClick={() => setFilter(name)} className={cx('h-8 rounded-full border px-3 text-xs capitalize transition-colors', filter === name ? 'border-foreground bg-foreground text-background' : 'border-border bg-card hover:border-foreground/40')}>
              {name} ({drifted.filter((row) => statusOf(row) === name).length})
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <ConfirmButton size="sm" disabled={shown.length === 0 || filter === 'accepted'} confirmLabel={`Accept ${shown.length} drifts`} onConfirm={() => bulk('accepted')}>
            Bulk accept
          </ConfirmButton>
          <ConfirmButton size="sm" disabled={shown.length === 0 || filter === 'dismissed'} confirmLabel={`Dismiss ${shown.length} drifts`} onConfirm={() => bulk('dismissed', 'Dismissed in bulk')}>
            Bulk dismiss
          </ConfirmButton>
          <Button size="sm" variant="ghost" onClick={() => downloadText(JSON.stringify(reviews, null, 2), 'driftlock-decisions.json', 'application/json')}>
            <Download aria-hidden="true" />
            Export decisions
          </Button>
          <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
            <Upload aria-hidden="true" />
            Import decisions
          </Button>
          <input ref={fileRef} type="file" accept="application/json" className="sr-only" aria-label="Decisions file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importDecisions(file); event.target.value = '' }} />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={cx(PANEL, 'p-8 text-muted-foreground')}>No drifts are {filter === 'pending' ? 'waiting for review' : filter}.</p>
      ) : (
        <ul className={cx(PANEL, 'divide-y divide-border')}>
          {shown.map((row) => {
            const review = reviews[row.id]
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-medium">{row.dependency_name}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <DriftBadge value={row.drift_disparity} />
                    <RiskBadge value={row.compatibility_risk} />
                  </div>
                  {review && filter !== 'pending' && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[review.reason && `Reason: ${review.reason}`, review.assignee && `Assigned to ${review.assignee}`, review.note && `Note: ${review.note}`, review.until && filter === 'snoozed' && `Until ${formatDateTime(review.until)}`].filter(Boolean).join('. ')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {filter !== 'accepted' && (
                    <Button size="sm" onClick={() => { const before = reviews[row.id]; setReview(row.id, { status: 'accepted', until: null }); toast(`${row.dependency_name} accepted`, () => setReview(row.id, before ?? null)) }}>
                      <Check aria-hidden="true" />
                      Accept
                    </Button>
                  )}
                  {filter !== 'pending' && (
                    <Button size="sm" variant="ghost" onClick={() => { const before = reviews[row.id]; setReview(row.id, null); toast(`${row.dependency_name} moved back to pending`, () => setReview(row.id, before ?? null)) }}>
                      Undo
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => onOpen(row.id)}>
                    Dismiss, snooze, assign or add note
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ---- Fix plans ---------------------------------------------------------------

export function FixPlans({ rows, repos, repoLabel, onOpen }: ListProps & { repos: readonly string[] }) {
  const { fixesDone } = useStore()
  const copy = useCopy()
  const plan = useMemo(() => fixPlan(rows, repos), [rows, repos])
  const total = plan.reduce((sum, group) => sum + group.items.length, 0)
  const done = plan.reduce((sum, group) => sum + group.items.filter(({ row, fix }) => fixesDone.includes(fixKey(row, fix.repo))).length, 0)
  const toggle = (key: string) => {
    updateStore((store) => ({ ...store, fixesDone: store.fixesDone.includes(key) ? store.fixesDone.filter((item) => item !== key) : [...store.fixesDone, key] }))
    log('fix', `Fix ${fixesDone.includes(key) ? 'reopened' : 'marked done'}: ${key}`)
  }

  return (
    <div>
      <Heading title="Fix plans">One version line per repository, using only the version the scan recommended. Lowest risk first. Progress is {LOCAL.toLowerCase()}</Heading>
      {total === 0 ? (
        <p className={cx(PANEL, 'p-8 text-muted-foreground')}>No fix lines are available. Either nothing has drifted, or the scan did not recommend a version.</p>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-4">
            <div className="min-w-48 flex-1">
              <div role="progressbar" aria-label="Fixes done" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground" style={{ width: `${(done / total) * 100}%` }} />
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {done} of {total} fixes marked done
              </p>
            </div>
            <Button onClick={() => void copy(fixPlanText(plan, repoLabel), 'All fixes')}>
              <Copy aria-hidden="true" />
              Copy all fixes
            </Button>
          </div>
          <div className="space-y-5">
            {plan.map((group) => (
              <section key={group.repo} aria-label={repoLabel(group.repo)} className={PANEL}>
                <h2 className="border-b border-border px-4 py-3 font-medium">
                  {repoLabel(group.repo)} <span className="font-mono text-xs font-normal text-muted-foreground">{group.items.length} fixes</span>
                </h2>
                <ul className="divide-y divide-border">
                  {group.items.map(({ row, fix }) => {
                    const key = fixKey(row, fix.repo)
                    const isDone = fixesDone.includes(key)
                    return (
                      <li key={key} className="space-y-2 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cx('break-all font-medium', isDone && 'text-muted-foreground line-through')}>{row.dependency_name}</span>
                          <RiskBadge value={row.compatibility_risk} />
                          <span className="font-mono text-xs text-muted-foreground">{fix.file}</span>
                        </div>
                        <pre className="overflow-x-auto rounded-md bg-secondary p-3 font-mono text-xs">{fix.line}</pre>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" onClick={() => void copy(fix.line, `Fix for ${row.dependency_name}`)}>
                            <Copy aria-hidden="true" />
                            Copy fix
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void copy(prDescription(row, repoLabel), 'PR description')}>
                            Copy as PR description
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onOpen(row.id)}>
                            Open evidence
                          </Button>
                          <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm">
                            <input type="checkbox" checked={isDone} onChange={() => toggle(key)} className="size-4 accent-foreground" />
                            Mark fix as done
                          </label>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---- Activity ----------------------------------------------------------------

export function ActivityView({ onRunAgain }: { onRunAgain: (entry: HistoryEntry) => void }) {
  const { activity, history } = useStore()
  const [query, setQuery] = useState('')
  const [type, setType] = useState('all')
  const [compare, setCompare] = useState<string | null>(null)
  const events = activity.filter((event) => (type === 'all' || event.type === type) && event.text.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div>
      <Heading title="Activity">Scans and decisions made in this browser. {LOCAL}</Heading>
      <section aria-label="Scan history" className={cx(PANEL, 'mb-6')}>
        <h2 className="border-b border-border px-4 py-3 font-mono text-xs uppercase text-muted-foreground">Scan history, last {history.length}</h2>
        {history.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {history.map((entry, index) => {
              const previous = history[index + 1]
              const diff = compare === entry.id && previous ? diffScans(previous, entry) : null
              return (
                <li key={entry.id} className="p-4 text-sm">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{entry.targets.map((target) => target.label).join(', ')}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(entry.at)}. {entry.drifted} drifted, {entry.major} major, {entry.findings} breaking findings{entry.source === 'demo' ? '. Demo data' : ''}
                      </span>
                    </span>
                    <Button size="sm" disabled={entry.source === 'demo' || entry.targets.every((target) => target.kind === 'pasted')} title="Restores the repository links in the form" onClick={() => onRunAgain(entry)}>
                      Open scan
                    </Button>
                    <Button size="sm" variant="ghost" disabled={!previous} title={previous ? undefined : 'There is no earlier scan to compare with'} onClick={() => setCompare(compare === entry.id ? null : entry.id)}>
                      Compare with previous
                    </Button>
                  </div>
                  {diff && (
                    <dl className="mt-3 grid gap-2 rounded-md bg-secondary p-3 text-xs sm:grid-cols-3">
                      {([['New drifts', diff.added], ['Resolved since', diff.resolved], ['Classification changed', diff.changed]] as const).map(([label, ids]) => (
                        <div key={label}>
                          <dt className="text-muted-foreground">
                            {label} ({ids.length})
                          </dt>
                          <dd className="mt-0.5 break-all font-mono">{ids.length > 0 ? ids.join(', ') : 'None'}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="min-w-48 flex-1 text-xs text-muted-foreground">
          Search events
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className="mt-1 block h-10 w-full rounded-full border border-input bg-card px-4 text-sm text-foreground" />
        </label>
        <label className="text-xs text-muted-foreground">
          Filter by type
          <select value={type} onChange={(event) => setType(event.target.value)} className="mt-1 block h-10 rounded-full border border-input bg-card px-4 text-sm text-foreground">
            {['all', 'scan', 'review', 'fix', 'export', 'settings'].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <ConfirmButton size="sm" disabled={activity.length === 0} confirmLabel={`Clear ${activity.length} log entries`} onConfirm={() => updateStore((store) => ({ ...store, activity: [] }))}>
          Clear log
        </ConfirmButton>
      </div>
      {events.length === 0 ? (
        <p className={cx(PANEL, 'p-6 text-sm text-muted-foreground')}>No events match.</p>
      ) : (
        <ul className={cx(PANEL, 'divide-y divide-border')}>
          {events.map((event, index) => (
            <li key={`${event.at}:${index}`} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2.5 text-sm">
              <span className="w-16 font-mono text-[0.625rem] uppercase text-muted-foreground">{event.type}</span>
              <span className="min-w-0 flex-1 break-words">{event.text}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(event.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- Repository comparison -----------------------------------------------------

export function RepoCompare({ result, repos, repoLabel, initial, onOpen }: { result: ScanResult; repos: readonly string[]; repoLabel: (name: string) => string; initial: string | null; onOpen: (id: string) => void }) {
  const [left, setLeft] = useState(initial ?? repos[0] ?? '')
  const [right, setRight] = useState(repos.find((repo) => repo !== (initial ?? repos[0])) ?? '')
  const [showManifests, setShowManifests] = useState(false)
  const shared = result.drift_matrix.filter((row) => left in row.declarations_by_repo && right in row.declarations_by_repo)
  const select = (label: string, value: string, set: (value: string) => void) => (
    <label className="text-xs text-muted-foreground">
      {label}
      <select value={value} onChange={(event) => set(event.target.value)} className="mt-1 block h-10 rounded-full border border-input bg-card px-4 text-sm text-foreground">
        {repos.map((repo) => (
          <option key={repo} value={repo}>
            {repoLabel(repo)}
          </option>
        ))}
      </select>
    </label>
  )
  if (repos.length < 2) return null
  return (
    <section aria-labelledby="compare-title" className="mt-10">
      <h2 id="compare-title" className="font-display text-2xl tracking-tight">
        Compare two repositories
      </h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        {select('First repository', left, setLeft)}
        {select('Second repository', right, setRight)}
        <Switch checked={showManifests} onChange={setShowManifests} label="Show manifests" />
      </div>
      {showManifests && (
        <ul className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          {[left, right].map((repo) => {
            const detail = result.repository_details.find((item) => item.name === repo)
            return (
              <li key={repo} className={cx(PANEL, 'p-3')}>
                <p className="font-medium">{repoLabel(repo)}</p>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {detail ? (detail.manifests.length > 0 ? detail.manifests.join(', ') : 'No manifests read') : 'Manifest paths were not reported by the backend'}
                </p>
                {detail?.ref && <p className="mt-1 font-mono text-xs text-muted-foreground">{detail.ref}{detail.commit ? ` at ${detail.commit.slice(0, 7)}` : ''}</p>}
              </li>
            )
          })}
        </ul>
      )}
      {left === right ? (
        <p className="mt-3 text-sm text-muted-foreground">Choose two different repositories.</p>
      ) : shared.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">These two repositories share no packages.</p>
      ) : (
        <div className={cx(PANEL, 'mt-3 overflow-x-auto')}>
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="text-left font-mono text-xs uppercase text-muted-foreground">
                {['Shared package', repoLabel(left), repoLabel(right), 'Drift'].map((heading) => (
                  <th key={heading} scope="col" className="px-4 py-2 font-normal">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shared.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    <button type="button" onClick={() => onOpen(row.id)} className="break-all text-left underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
                      {row.dependency_name}
                    </button>
                  </th>
                  {[left, right].map((repo) => {
                    const declaration = row.declarations_by_repo[repo]
                    return (
                      <td key={repo} className="px-4 py-2 font-mono text-xs">
                        {declaration?.resolved_version ?? declaration?.declared_range}
                      </td>
                    )
                  })}
                  <td className="px-4 py-2">
                    <DriftBadge value={row.drift_disparity} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---- Settings ----------------------------------------------------------------

const RISKS = ['CONFIRMED_BREAKING', 'SUSPECTED_BREAKING', 'UNKNOWN_IMPACT']

export function SettingsView({ onRestartTour }: { onRestartTour: () => void }) {
  const store = useStore()
  const { settings } = store
  const toast = useToast()
  const row = 'flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0'
  const choice = <K extends 'theme' | 'density' | 'defaultView'>(key: K, options: readonly string[], labels?: (value: string) => string) => (
    <select value={settings[key]} aria-label={key} onChange={(event) => { setSetting(key, event.target.value as never); log('settings', `${key} set to ${event.target.value}`) }} className="h-9 rounded-full border border-input bg-card px-3 text-sm">
      {options.map((option) => (
        <option key={option} value={option}>
          {labels ? labels(option) : option}
        </option>
      ))}
    </select>
  )

  return (
    <div className="max-w-3xl">
      <Heading title="Settings">{LOCAL} Nothing here is sent to the backend.</Heading>
      <div className={PANEL}>
        <div className={row}>
          <span>Theme</span>
          {choice('theme', ['light', 'dark', 'system'])}
        </div>
        <div className={row}>
          <span>Table density</span>
          {choice('density', ['comfortable', 'compact'])}
        </div>
        <div className={row}>
          <span>Default view</span>
          {choice('defaultView', VIEWS, (value) => VIEW_META[value as keyof typeof VIEW_META]?.label ?? value)}
        </div>
        <div className={row}>
          <span>
            Risk levels that count as critical
            <span className="block text-xs text-muted-foreground">Used for notifications.</span>
          </span>
          <span role="group" aria-label="Critical risk levels" className="flex flex-wrap gap-2">
            {RISKS.map((risk) => {
              const on = settings.criticalRisks.includes(risk)
              return (
                <button key={risk} type="button" aria-pressed={on} onClick={() => setSetting('criticalRisks', on ? settings.criticalRisks.filter((item) => item !== risk) : [...settings.criticalRisks, risk])} className={cx('h-8 rounded-full border px-3 text-xs transition-colors', on ? 'border-foreground bg-foreground text-background' : 'border-border hover:border-foreground/40')}>
                  {riskMeta(risk).label}
                </button>
              )
            })}
          </span>
        </div>
        <div className={row}>
          <Switch checked={settings.notifications} onChange={(value) => setSetting('notifications', value)} label="Notifications" />
          <Button size="sm" variant="ghost" onClick={onRestartTour}>
            Restart tour
          </Button>
        </div>
        <div className={row}>
          <span>
            Local data
            <span className="block text-xs text-muted-foreground">
              {Object.keys(store.reviews).length} review decisions, {store.fixesDone.length} fixes marked done, {store.history.length} scans in history, {store.views.length} saved views, {store.activity.length} log entries
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => downloadText(JSON.stringify(store, null, 2), 'driftlock-local-data.json', 'application/json')}>
              <Download aria-hidden="true" />
              Export all local data
            </Button>
            <ConfirmButton
              size="sm"
              confirmLabel={`Delete ${Object.keys(store.reviews).length} decisions, ${store.history.length} scans, ${store.views.length} views and all settings`}
              onConfirm={() => {
                const before = getStore()
                clearStore()
                toast('Local data cleared', () => setStore(sanitize(before)))
              }}
            >
              Clear local data
            </ConfirmButton>
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Defaults: {DEFAULT_SETTINGS.theme} theme, {DEFAULT_SETTINGS.density} density. Pasted manifest content is never saved.</p>
    </div>
  )
}
