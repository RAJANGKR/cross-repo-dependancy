import { ArrowRight, ExternalLink, Maximize2, Minimize2 } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { ScanResult } from '../../api/scanTypes'
import { driftMeta, isDrifted, riskMeta, TONE_STYLES } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { formatDateTime, NOT_AVAILABLE, safeHttpsUrl } from '../../lib/formatters'
import { computeKpis, ecosystemBreakdown, priorityDrifts, repoHealth } from '../../lib/insights'
import { activeReview, useStore } from '../../lib/localStore'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { Button } from '../common/Button'
import { Switch } from '../common/Controls'
import { EcosystemTag } from '../common/Tags'
import type { View } from './Shell'

const PANEL = 'rounded-lg border border-border bg-card'
const PANEL_TITLE = 'font-mono text-xs uppercase text-muted-foreground'
const GRADE_TONE = { A: 'low', B: 'low', C: 'medium', D: 'high', F: 'critical' } as const

/** A horizontal bar whose meaning is given in words, never by color alone. */
function MiniBar({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground" style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </span>
      <span className="w-10 shrink-0 text-right font-mono tabular-nums">{text}</span>
    </div>
  )
}

export interface CommandCenterProps {
  result: ScanResult
  repos: readonly string[]
  repoLabel: (name: string) => string
  /** The dependency graph; `tall` asks for the full-screen size. */
  renderGraph: (tall: boolean) => ReactNode
  onOpen: (id: string) => void
  /** Navigate to a view, optionally with a drift-table preset. */
  onGo: (view: View, preset?: 'drifted' | 'vulnerable') => void
  onCompare: (repo: string) => void
}

export function CommandCenter({ result, repos, repoLabel, renderGraph, onOpen, onGo, onCompare }: CommandCenterProps) {
  const { reviews, activity } = useStore()
  const rows = result.drift_matrix
  const [fullscreen, setFullscreen] = useState(false)
  const [sort, setSort] = useState<'priority' | 'score' | 'name'>('priority')
  const [showReviewed, setShowReviewed] = useState(false)
  const kpis = useMemo(() => computeKpis(result, reviews), [result, reviews])

  const priority = useMemo(() => {
    const list = priorityDrifts(rows).filter((row) => showReviewed || activeReview(reviews[row.id]) === null)
    if (sort === 'score') list.sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
    if (sort === 'name') list.sort((a, b) => a.dependency_name.localeCompare(b.dependency_name))
    return list
  }, [rows, reviews, sort, showReviewed])

  const health = useMemo(() => repos.map((repo) => repoHealth(rows, repo)), [rows, repos])
  const ecosystems = useMemo(() => ecosystemBreakdown(rows), [rows])
  const heat = useMemo(() => priorityDrifts(rows).slice(0, 8), [rows])
  const urlOf = (repo: string) => safeHttpsUrl(result.scanned_repositories.find((item) => item.name === repo)?.url ?? null)

  const cards: Array<{ label: string; value: number | null; note: string; go: () => void }> = [
    { label: 'Active drifts', value: kpis.activeDrifts, note: 'Packages on different versions', go: () => onGo('drifts', 'drifted') },
    { label: 'Shared libraries', value: kpis.sharedLibraries, note: 'Used by two or more repositories', go: () => onGo('drifts') },
    { label: 'Vulnerable versions', value: kpis.vulnerableVersions, note: 'Versions in use with a known advisory', go: () => onGo('drifts', 'vulnerable') },
    { label: 'Pending review', value: kpis.pendingReview, note: 'Drifts with no decision yet', go: () => onGo('review') },
  ]

  return (
    <div className="space-y-6">
      <ul className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border xl:grid-cols-4">
        {cards.map((card) => (
          <li key={card.label}>
            <button type="button" onClick={card.go} className="group flex h-full w-full flex-col bg-card p-5 text-left transition-colors hover:bg-secondary">
              <span className="font-display text-4xl tabular-nums tracking-tight lg:text-5xl">
                {card.value === null ? <span className="font-sans text-base font-normal tracking-normal text-muted-foreground">{NOT_AVAILABLE}</span> : card.value}
              </span>
              <span className="mt-2 flex items-center gap-1 text-sm font-medium">
                {card.label}
                <ArrowRight aria-hidden="true" className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </span>
              <span className="text-xs text-muted-foreground">{card.note}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="cc-graph" className={cx(PANEL, fullscreen ? 'fixed inset-3 z-40 overflow-auto p-4 shadow-pop' : 'p-4')}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 id="cc-graph" className={PANEL_TITLE}>
              Dependency graph
            </h2>
            <Button size="sm" variant="ghost" onClick={() => setFullscreen(!fullscreen)}>
              {fullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
              {fullscreen ? 'Exit full screen' : 'Open full-screen graph'}
            </Button>
          </div>
          {renderGraph(fullscreen)}
        </section>

        <section aria-labelledby="cc-priority" className={cx(PANEL, 'flex max-h-[44rem] flex-col')}>
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <h2 id="cc-priority" className={cx(PANEL_TITLE, 'flex-1')}>
              Priority drifts ({priority.length})
            </h2>
            <label className="text-xs text-muted-foreground">
              <span className="sr-only">Sort priority drifts by</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-8 rounded-full border border-input bg-card px-2 text-xs text-foreground">
                <option value="priority">Risk first</option>
                <option value="score">Score first</option>
                <option value="name">Name</option>
              </select>
            </label>
            <Switch checked={showReviewed} onChange={setShowReviewed} label="Show reviewed" />
          </div>
          {priority.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {rows.some((row) => isDrifted(row.drift_disparity)) ? 'Every drift has a review decision. Turn on Show reviewed to see them.' : 'No package differs between repositories.'}
            </p>
          ) : (
            <ul className="divide-y divide-border overflow-y-auto">
              {priority.map((row) => {
                const review = activeReview(reviews[row.id])
                return (
                  <li key={row.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-medium">{row.dependency_name}</span>
                      <EcosystemTag ecosystem={row.ecosystem} />
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <DriftBadge value={row.drift_disparity} />
                      <RiskBadge value={row.compatibility_risk} />
                    </div>
                    {row.score !== null && <MiniBar label="Score" value={row.score} max={100} text={String(row.score)} />}
                    {row.confidence !== null && <MiniBar label="Confidence" value={row.confidence} max={1} text={row.confidence.toFixed(2)} />}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">{review ? `Review: ${review.status}` : 'Pending review'}</span>
                      <Button size="sm" onClick={() => onOpen(row.id)}>
                        Review drift
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="cc-health">
        <h2 id="cc-health" className={cx(PANEL_TITLE, 'mb-3')}>
          Repository health
        </h2>
        <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-4">
          {health.map((item) => {
            const tone = TONE_STYLES[GRADE_TONE[item.grade]]
            const url = urlOf(item.repo)
            return (
              <li key={item.repo} className="flex flex-col gap-3 bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{repoLabel(item.repo)}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">{item.repo}</p>
                  </div>
                  <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-md font-display text-xl', tone.tint, tone.text)} title={`Health score ${item.score} of 100`}>
                    <span className="sr-only">Grade </span>
                    {item.grade}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {item.drifted} drifted, {item.findings} breaking findings, {item.vulnerabilities} vulnerabilities
                </p>
                <div className="mt-auto flex flex-wrap gap-2">
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-full border border-foreground/20 px-3 text-xs hover:border-foreground">
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                      Open repo
                    </a>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => onCompare(item.repo)}>
                    Compare
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          Grade: 100 minus 25 per confirmed break, 15 per suspected, 8 per unknown impact, 3 per other drift and 10 per known vulnerability. A is 90 or more, F is under 40. A display heuristic, not a measurement.
        </p>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="cc-heat" className={cx(PANEL, 'overflow-x-auto p-4')}>
          <h2 id="cc-heat" className={cx(PANEL_TITLE, 'mb-3')}>
            Top offenders by repository
          </h2>
          {heat.length === 0 ? (
            <p className="text-sm text-muted-foreground">No drifted packages to compare.</p>
          ) : (
            <table className="w-full min-w-[28rem] border-collapse text-xs">
              <thead>
                <tr>
                  <th scope="col" className="py-1.5 pr-3 text-left font-normal text-muted-foreground">
                    Package
                  </th>
                  {repos.map((repo) => (
                    <th key={repo} scope="col" className="px-2 py-1.5 text-left font-normal text-muted-foreground">
                      {repoLabel(repo)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {heat.map((row) => {
                  const tone = TONE_STYLES[driftMeta(row.drift_disparity).tone]
                  return (
                    <tr key={row.id} className="border-t border-border">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        <button type="button" onClick={() => onOpen(row.id)} className="break-all text-left font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
                          {row.dependency_name}
                        </button>
                        <span className="block text-muted-foreground">{riskMeta(row.compatibility_risk).label}</span>
                      </th>
                      {repos.map((repo) => {
                        const declaration = row.declarations_by_repo[repo]
                        return (
                          <td key={repo} className="px-1 py-1.5">
                            {declaration ? (
                              <span className={cx('block rounded-sm px-2 py-1 font-mono', tone.tint)}>{declaration.resolved_version ?? declaration.declared_range}</span>
                            ) : (
                              <span className="block px-2 py-1 text-muted-foreground">Not used</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        <div className="space-y-6">
          <section aria-labelledby="cc-eco" className={cx(PANEL, 'p-4')}>
            <h2 id="cc-eco" className={cx(PANEL_TITLE, 'mb-3')}>
              Ecosystem breakdown
            </h2>
            {ecosystems.length === 0 ? (
              <p className="text-sm text-muted-foreground">No packages were returned.</p>
            ) : (
              <ul className="space-y-2">
                {ecosystems.map((item) => (
                  <li key={item.ecosystem}>
                    <MiniBar label={item.label} value={item.drifted} max={Math.max(1, item.total)} text={`${item.drifted}/${item.total}`} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-muted-foreground">Drifted packages out of all packages, per ecosystem.</p>
          </section>
          <section aria-labelledby="cc-feed" className={cx(PANEL, 'p-4')}>
            <div className="mb-3 flex items-center justify-between">
              <h2 id="cc-feed" className={PANEL_TITLE}>
                Activity, saved in this browser
              </h2>
              <Button size="sm" variant="ghost" onClick={() => onGo('activity')}>
                Open activity
              </Button>
            </div>
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {activity.slice(0, 5).map((event, index) => (
                  <li key={`${event.at}:${index}`}>
                    {event.text}
                    <span className="block text-xs text-muted-foreground">{formatDateTime(event.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

