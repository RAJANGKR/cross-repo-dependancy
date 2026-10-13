import { Check, ChevronLeft, ChevronRight, Clock, Copy, ExternalLink, Link2, RotateCcw, ShieldAlert, Sparkles, X } from 'lucide-react'
import { useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { CodeImpactItem, DependencyDrift } from '../../api/scanTypes'
import { driftMeta, riskMeta, severityTone } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { dependencySummaryText } from '../../lib/exportMarkdown'
import { safeHttpsUrl } from '../../lib/formatters'
import { alreadyOnRecommended, fixKey, fixLine, prDescription } from '../../lib/insights'
import { activeReview, log, setReview, updateStore, useStore, type Review } from '../../lib/localStore'
import { nextStepFor, registryUrl } from '../../lib/nextStep'
import { DriftBadge, RiskBadge, ToneBadge } from '../common/Badges'
import { Button } from '../common/Button'
import { useCopy, useToast } from '../common/Controls'
import { Dialog } from '../common/Dialog'
import { CodeBlock, ReleaseEvidenceBody } from '../common/Evidence'
import { EcosystemTag } from '../common/Tags'
import { CodeImpactList } from '../results/CodeImpact'

const TABS = ['Overview', 'Evidence', 'Versions', 'Fix', 'Notes'] as const
type Tab = (typeof TABS)[number]

/** Plain sentences for the backend's `signals_missing` keys. */
const SIGNAL_TEXT: Record<string, string> = {
  registry: 'The package registry could not be read, so declared ranges were not resolved',
  lockfile: 'At least one repository has no lockfile pin for this package',
  resolved_version: 'A version in use could not be determined',
  range_overlap: 'It is unknown whether the declared ranges overlap',
  changelog: 'No release notes were retrieved for these versions',
  vulnerabilities: 'Known vulnerabilities could not be looked up',
  code_scan: 'The code scan did not cover every repository that uses this package',
  import_mapping: 'Import mapping is unavailable for this package, so usage was not located',
  tier3_only: 'Only unverified candidate rules matched',
}

const DAY = 86_400_000

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-5 first:border-t-0 first:pt-0">
      <h3 className="font-mono text-xs uppercase text-muted-foreground">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** Confidence is a heuristic about available evidence. It is never called accuracy. */
export function ConfidenceMeter({ value }: { value: number }) {
  const clamped = Math.min(1, Math.max(0, value))
  return (
    <span className="inline-flex items-center gap-2" title="How much evidence was available. Lower when signals are missing. Not accuracy.">
      <span role="meter" aria-label="Confidence" aria-valuemin={0} aria-valuemax={1} aria-valuenow={clamped} className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-foreground" style={{ width: `${clamped * 100}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums">{clamped.toFixed(2)}</span>
    </span>
  )
}

const NAV_BUTTON = 'rounded-full p-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent'

interface DetailPanelProps {
  row: DependencyDrift
  repos: readonly string[]
  repoLabel: (name: string) => string
  codeImpact: CodeImpactItem[] | null
  position: { index: number; total: number } | null
  /** Executive view hides source-code evidence. */
  executive: boolean
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

export function DetailPanel({ row, repos, repoLabel, codeImpact, position, executive, onPrevious, onNext, onClose }: DetailPanelProps) {
  const titleId = useId()
  const baseId = useId()
  const [tab, setTab] = useState<Tab>('Overview')
  const { reviews, fixesDone } = useStore()
  const copy = useCopy()
  const toast = useToast()
  const drift = driftMeta(row.drift_disparity)
  const risk = riskMeta(row.compatibility_risk)
  const review = activeReview(reviews[row.id])
  const registry = registryUrl(row)
  const notesUrl = safeHttpsUrl(row.evidence?.source_url ?? null)
  const related = codeImpact?.filter((item) => item.dependency_name === row.dependency_name) ?? null
  const names = [...new Set([...repos, ...Object.keys(row.declarations_by_repo), ...row.missing_in_repos])]
  const step = nextStepFor(row)

  const decide = (change: Partial<Review>, text: string) => {
    const previous = reviews[row.id]
    setReview(row.id, change)
    log('review', `${row.dependency_name}: ${text}`)
    toast(`${row.dependency_name}: ${text}`, () => setReview(row.id, previous ?? null))
  }

  const onTabKey = (event: KeyboardEvent) => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!offset) return
    event.preventDefault()
    const next = TABS[(TABS.indexOf(tab) + offset + TABS.length) % TABS.length] ?? 'Overview'
    setTab(next)
    document.getElementById(`${baseId}-${next}`)?.focus()
  }

  return (
    <Dialog
      variant="side"
      labelledBy={titleId}
      onClose={onClose}
      header={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <EcosystemTag ecosystem={row.ecosystem} />
            {position && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {position.index + 1} of {position.total}
              </span>
            )}
            {review && <ToneBadge label={`Review: ${review.status}`} tone="neutral" prefix="Status" />}
          </div>
          <h2 id={titleId} className="mt-2 break-all font-display text-3xl tracking-tight">
            {row.dependency_name}
          </h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <DriftBadge value={row.drift_disparity} />
            <RiskBadge value={row.compatibility_risk} />
            {row.score !== null && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                Score {row.score}
                {row.risk_level ? `, ${row.risk_level}` : ''}
              </span>
            )}
          </div>
          <div role="tablist" aria-label="Detail sections" onKeyDown={onTabKey} className="-mb-5 mt-4 flex gap-1 overflow-x-auto">
            {TABS.map((name) => (
              <button
                key={name}
                id={`${baseId}-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={`${baseId}-panel`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
                className={cx('border-b-2 px-3 py-2 font-mono text-xs uppercase transition-colors', tab === name ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {name}
              </button>
            ))}
          </div>
        </>
      }
      toolbar={
        <>
          <button type="button" onClick={onPrevious} disabled={!position || position.index === 0} aria-label="Previous package" title="Previous package (K)" className={NAV_BUTTON}>
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <button type="button" onClick={onNext} disabled={!position || position.index >= position.total - 1} aria-label="Next package" title="Next package (J)" className={NAV_BUTTON}>
            <ChevronRight aria-hidden="true" className="size-5" />
          </button>
        </>
      }
      footer={
        <>
          <Button onClick={() => void copy(dependencySummaryText(row), 'Summary')}>
            <Copy aria-hidden="true" />
            Copy summary
          </Button>
          <Button onClick={() => void copy(window.location.href, 'Link to this drift')}>
            <Link2 aria-hidden="true" />
            Copy link
          </Button>
          {notesUrl && (
            <a href={notesUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm text-foreground/70 hover:bg-foreground/5 hover:text-foreground">
              <ExternalLink aria-hidden="true" className="size-4" />
              Open release notes
            </a>
          )}
          {registry && (
            <a href={registry.url} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm text-foreground/70 hover:bg-foreground/5 hover:text-foreground">
              <ExternalLink aria-hidden="true" className="size-4" />
              {registry.label}
            </a>
          )}
        </>
      }
    >
      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${tab}`}>
        {tab === 'Overview' && (
          <>
            <Block title="What these classifications mean">
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="font-medium">Drift: {drift.label}</dt>
                  <dd className="mt-0.5 text-muted-foreground">{drift.description}</dd>
                </div>
                <div>
                  <dt className="font-medium">Compatibility risk: {risk.label}</dt>
                  <dd className="mt-0.5 text-muted-foreground">{risk.description}</dd>
                </div>
              </dl>
            </Block>
            {row.explanation && (
              <Block title={row.explanation.source === 'ai' ? 'AI explanation' : 'Generated from rules'}>
                <p className="flex gap-2 leading-relaxed">
                  {row.explanation.source === 'ai' && <Sparkles aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />}
                  {row.explanation.text}
                </p>
              </Block>
            )}
            {row.breakdown.length > 0 && (
              <Block title="Why this score">
                <ul className="space-y-1.5 text-sm">
                  {row.breakdown.map((item) => (
                    <li key={item.signal} className="flex items-center gap-3">
                      <span className="flex-1">{item.signal}</span>
                      <span aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <span className={cx('block h-full rounded-full', item.points < 0 ? 'bg-success' : 'bg-foreground')} style={{ width: `${Math.min(100, Math.abs(item.points) * 2)}%` }} />
                      </span>
                      <span className="w-10 text-right font-mono tabular-nums">{item.points > 0 ? `+${item.points}` : item.points}</span>
                    </li>
                  ))}
                  <li className="flex items-center gap-3 border-t border-border pt-1.5 font-medium">
                    <span className="flex-1">Score, from 0 to 100</span>
                    <span className="font-mono tabular-nums">{row.score ?? 'Not available'}</span>
                  </li>
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">Weights are untuned estimates. The classifications above are the primary signal.</p>
              </Block>
            )}
            {(row.confidence !== null || row.signals_missing.length > 0) && (
              <Block title="Confidence and missing signals">
                {row.confidence !== null && <ConfidenceMeter value={row.confidence} />}
                {row.signals_missing.length > 0 ? (
                  <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                    {row.signals_missing.map((key) => (
                      <li key={key}>{SIGNAL_TEXT[key] ?? `The "${key.replace(/_/g, ' ')}" signal was not available`}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">Every signal was available for this package.</p>
                )}
              </Block>
            )}
            {row.vulnerabilities.length > 0 && (
              <Block title={`Known vulnerabilities (${row.vulnerabilities.length})`}>
                <ul className="space-y-3 text-sm">
                  {row.vulnerabilities.map((item) => (
                    <li key={`${item.id}:${item.affects_repo}`} className="flex gap-2">
                      <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-risk-critical" />
                      <span>
                        {/^[A-Za-z0-9._-]+$/.test(item.id) ? (
                          <a href={`https://osv.dev/vulnerability/${item.id}`} target="_blank" rel="noreferrer" className="font-mono text-xs underline decoration-foreground/30 underline-offset-4">
                            {item.id}
                          </a>
                        ) : (
                          <span className="font-mono text-xs">{item.id}</span>
                        )}
                        <span className="block">{item.summary || 'No summary provided'}</span>
                        <span className="block text-muted-foreground">
                          Affects {repoLabel(item.affects_repo)}
                          {item.fixed_in ? `. Fixed in ${item.fixed_in}` : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </Block>
            )}
            {step && (
              <Block title="Suggested next step">
                <p className="leading-relaxed">{step}</p>
                <p className="mt-2 text-xs text-muted-foreground">Generated from rules, based on the classifications above.</p>
              </Block>
            )}
          </>
        )}

        {tab === 'Evidence' && (
          <>
            <Block title="Release evidence">
              <ReleaseEvidenceBody evidence={row.evidence} />
            </Block>
            <Block title={`Code impact${related ? ` (${related.length})` : ''}`}>
              {executive ? (
                <p className="text-sm text-muted-foreground">Source-code evidence is hidden in Executive view. Switch to Technical to see it.</p>
              ) : related === null ? (
                <p className="text-sm text-muted-foreground">No code scan ran for this scan, so no source locations are shown.</p>
              ) : related.length === 0 ? (
                <p className="text-sm text-muted-foreground">No usages of this package were located in the scanned source.</p>
              ) : (
                <CodeImpactList items={related} repoLabel={repoLabel} />
              )}
            </Block>
          </>
        )}

        {tab === 'Versions' && (
          <Block title="Versions by repository">
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[32rem] border-collapse text-sm">
                <thead>
                  <tr className="text-left font-mono text-xs uppercase text-muted-foreground">
                    {['Repository', 'Declared range', 'Resolved version', 'Source'].map((heading) => (
                      <th key={heading} scope="col" className="px-3 py-2 font-normal">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {names.map((name) => {
                    const declaration = row.declarations_by_repo[name]
                    return (
                      <tr key={name} className="border-t border-border align-top">
                        <th scope="row" className="px-3 py-2.5 text-left font-medium">
                          {repoLabel(name)}
                          {repoLabel(name) !== name && <span className="block font-mono text-xs font-normal text-muted-foreground">{name}</span>}
                        </th>
                        {declaration ? (
                          <>
                            <td className="break-all px-3 py-2.5 font-mono text-xs">{declaration.declared_range || 'Not provided'}</td>
                            <td className={cx('break-all px-3 py-2.5', declaration.resolved_version ? 'font-mono text-xs tabular-nums' : 'text-muted-foreground')}>
                              {declaration.resolved_version ?? 'Not resolved, no lockfile entry'}
                            </td>
                            <td className="break-all px-3 py-2.5 text-xs text-muted-foreground">
                              {declaration.source_file || 'Not provided'}
                              {declaration.dep_type && <span className="block">{declaration.dep_type} dependency</span>}
                            </td>
                          </>
                        ) : (
                          <td colSpan={3} className="px-3 py-2.5 text-muted-foreground">
                            Not declared in this repository
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Declared range is what the manifest allows. Resolved version is what the lockfile actually pins.</p>
          </Block>
        )}

        {tab === 'Fix' && (
          <Block title="Align on the recommended version">
            {!row.recommended_version ? (
              <p className="text-sm text-muted-foreground">The backend did not recommend a version for this package, so no fix line can be offered.</p>
            ) : (
              <>
                <p className="text-sm">
                  Recommended version: <span className="font-mono">{row.recommended_version}</span>
                </p>
                <ul className="mt-4 space-y-4">
                  {Object.keys(row.declarations_by_repo).map((repo) => {
                    const line = fixLine(row, repo)
                    const done = fixesDone.includes(fixKey(row, repo))
                    return (
                      <li key={repo}>
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {repoLabel(repo)}
                          <span className="font-mono text-xs font-normal text-muted-foreground">{row.declarations_by_repo[repo]?.source_file}</span>
                        </p>
                        {alreadyOnRecommended(row, repo) ? (
                          <p className="mt-1 flex items-center gap-1.5 text-sm text-success">
                            <Check aria-hidden="true" className="size-4" />
                            Already on the recommended version
                          </p>
                        ) : line ? (
                          <>
                            <div className="mt-1.5">
                              <CodeBlock code={line} label={`Copy fix for ${repoLabel(repo)}`} />
                            </div>
                            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={done}
                                onChange={() => updateStore((store) => ({ ...store, fixesDone: done ? store.fixesDone.filter((key) => key !== fixKey(row, repo)) : [...store.fixesDone, fixKey(row, repo)] }))}
                                className="size-4 accent-foreground"
                              />
                              Mark fix as done
                            </label>
                          </>
                        ) : (
                          <p className="mt-1 text-sm text-muted-foreground">No fix line is available for this file type.</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
                <p className="mt-4 text-xs text-muted-foreground">Each line pins the recommended version exactly. Adjust the range operator to your team's convention.</p>
              </>
            )}
            <Button className="mt-4" onClick={() => void copy(prDescription(row, repoLabel), 'PR description')}>
              <Copy aria-hidden="true" />
              Copy as PR description
            </Button>
          </Block>
        )}

        {tab === 'Notes' && <ReviewControls key={row.id} row={row} review={reviews[row.id]} active={review} onDecide={decide} />}
      </div>
    </Dialog>
  )
}

interface ReviewControlsProps {
  row: DependencyDrift
  review: Review | undefined
  active: Review | null
  onDecide: (change: Partial<Review>, text: string) => void
}

/** Review decisions for one drift. Saved in this browser only. */
export function ReviewControls({ row, review, active, onDecide }: ReviewControlsProps) {
  const [reason, setReason] = useState(review?.reason ?? '')
  const [note, setNote] = useState(review?.note ?? '')
  const [assignee, setAssignee] = useState(review?.assignee ?? '')
  const baseId = useId()
  const field = 'mt-1 w-full rounded-md border border-input bg-card px-3 py-2 text-sm'
  const snooze = (days: number) => onDecide({ status: 'snoozed', until: new Date(Date.now() + days * DAY).toISOString() }, `snoozed for ${days === 1 ? '1 day' : '1 week'}`)

  return (
    <Block title="Review, saved in this browser">
      <p className="text-sm">
        Status:{' '}
        {active ? (
          <ToneBadge label={active.status} tone={severityTone(active.status === 'dismissed' ? 'LOW' : 'MEDIUM')} prefix="Review" />
        ) : (
          <span className="text-muted-foreground">Pending review</span>
        )}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onDecide({ status: 'accepted', until: null }, 'accepted for fixing')}>
          <Check aria-hidden="true" />
          Accept
        </Button>
        <Button size="sm" disabled={reason.trim() === ''} title={reason.trim() === '' ? 'Give a reason below first' : undefined} onClick={() => onDecide({ status: 'dismissed', reason: reason.trim(), until: null }, 'dismissed')}>
          <X aria-hidden="true" />
          Dismiss
        </Button>
        <Button size="sm" onClick={() => snooze(1)}>
          <Clock aria-hidden="true" />
          Snooze 1 day
        </Button>
        <Button size="sm" onClick={() => snooze(7)}>
          <Clock aria-hidden="true" />
          Snooze 1 week
        </Button>
        <Button size="sm" variant="ghost" disabled={!review} title={review ? undefined : 'No decision to undo'} onClick={() => setReview(row.id, null)}>
          <RotateCcw aria-hidden="true" />
          Reset to pending
        </Button>
      </div>
      <label htmlFor={`${baseId}-reason`} className="mt-5 block text-xs text-muted-foreground">
        Reason for dismissing
      </label>
      <input id={`${baseId}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: services are deployed separately" className={field} />
      <label htmlFor={`${baseId}-assignee`} className="mt-4 block text-xs text-muted-foreground">
        Assign to
      </label>
      <input id={`${baseId}-assignee`} value={assignee} onChange={(event) => setAssignee(event.target.value)} onBlur={() => assignee !== (review?.assignee ?? '') && setReview(row.id, { status: review?.status ?? 'accepted', assignee })} placeholder="Name or handle" className={field} />
      <label htmlFor={`${baseId}-note`} className="mt-4 block text-xs text-muted-foreground">
        Note
      </label>
      <textarea id={`${baseId}-note`} rows={3} value={note} onChange={(event) => setNote(event.target.value)} className={field} />
      <Button size="sm" className="mt-2" disabled={note === (review?.note ?? '')} onClick={() => onDecide({ status: review?.status ?? 'accepted', note }, 'note saved')}>
        Add note
      </Button>
    </Block>
  )
}
