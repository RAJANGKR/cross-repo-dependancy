import { ArrowLeft, ArrowRight, CircleCheck, CircleHelp, CircleX, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import {
  analyzeRollout,
  rolloutErrorMessage,
  type AnalyzeRollout,
  type AnalyzedRef,
  type RolloutContractChange,
  type RolloutEvidence,
  type RolloutRequest,
  type RolloutResult,
  type RolloutState,
} from '../../api/rolloutClient'
import { isCancelled } from '../../api/errors'
import { changedFieldLabel, evidenceBadge, TONE_STYLES, type Tone } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { humanizeCode, plural } from '../../lib/formatters'
import { conciseReason, rolloutChangeLines } from '../../lib/rollout'
import { AuthButton } from '../common/AuthButton'
import { ToneBadge } from '../common/Badges'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { BusyButton } from '../common/Controls'
import { Disclosure } from '../common/Disclosure'
import { Wordmark } from '../common/Tags'

const FIELD = 'h-10 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/70'

/**
 * The three outcomes differ by colour, icon and word, so none relies on colour
 * alone. Compatible is the only one with a positive tone. Unknown is neutral:
 * it is neither good nor bad news, and it is never styled like compatible.
 */
const STATUS: Record<string, { label: string; tone: Tone; icon: LucideIcon; meaning: string }> = {
  COMPATIBLE: { label: 'Compatible', tone: 'low', icon: CircleCheck, meaning: 'The evidence supports this state, within the changes that are checked.' },
  INCOMPATIBLE: { label: 'Incompatible', tone: 'critical', icon: CircleX, meaning: 'A problem is demonstrated by the specification and the consumer code.' },
  UNKNOWN: { label: 'Unknown', tone: 'neutral', icon: CircleHelp, meaning: 'The evidence does not settle this state either way. It is not treated as compatible.' },
}

const RECOMMENDATION: Record<string, { label: string; tone: Tone }> = {
  PROVIDER_FIRST: { label: 'Deploy the provider first', tone: 'low' },
  CONSUMER_FIRST: { label: 'Deploy the consumer first', tone: 'low' },
  EITHER: { label: 'Either order', tone: 'low' },
  NEITHER: { label: 'Neither order', tone: 'critical' },
  UNRESOLVED: { label: 'Unresolved', tone: 'neutral' },
}

const statusOf = (value: string) =>
  STATUS[value] ?? { label: value || 'Not reported', tone: 'neutral' as Tone, icon: CircleHelp, meaning: 'A status this page does not recognize, shown as the backend sent it.' }
const recommendationOf = (value: string) => RECOMMENDATION[value] ?? { label: value || 'Not reported', tone: 'neutral' as Tone }

/** Real public repositories, offered so the form can be tried. Nothing is analyzed until the button is pressed. */
export const SAMPLE_REQUEST: RolloutRequest = {
  provider: { url: 'https://github.com/swagger-api/swagger-petstore', current_ref: 'swagger-petstore-v3-1.0.5', proposed_ref: 'swagger-petstore-v3-1.0.27' },
  consumer: { url: 'https://github.com/Sslonikq/petstore-aqa-framework', current_ref: 'main', proposed_ref: 'main' },
}

const EMPTY: RolloutRequest = {
  provider: { url: '', current_ref: '', proposed_ref: '' },
  consumer: { url: '', current_ref: '', proposed_ref: '' },
}

type Side = 'provider' | 'consumer'
type FieldName = 'url' | 'current_ref' | 'proposed_ref'

const FIELDS: Record<Side, { title: string; fields: { name: FieldName; label: string; tag: string; placeholder: string }[] }> = {
  provider: {
    title: 'Provider',
    fields: [
      { name: 'url', label: 'Provider GitHub URL', tag: '', placeholder: 'https://github.com/owner/provider-api' },
      { name: 'current_ref', label: 'Provider deployed ref', tag: 'P0', placeholder: 'v1.4.0' },
      { name: 'proposed_ref', label: 'Provider proposed ref', tag: 'P1', placeholder: 'v2.0.0' },
    ],
  },
  consumer: {
    title: 'Consumer',
    fields: [
      { name: 'url', label: 'Consumer GitHub URL', tag: '', placeholder: 'https://github.com/owner/consumer-app' },
      { name: 'current_ref', label: 'Consumer deployed ref', tag: 'C0', placeholder: 'main' },
      { name: 'proposed_ref', label: 'Consumer proposed ref', tag: 'C1', placeholder: 'feature/use-v2' },
    ],
  },
}

/** What is missing or malformed in the form, by field; empty when it can be sent. */
export function validateRollout(form: RolloutRequest): Record<string, string> {
  const problems: Record<string, string> = {}
  for (const side of ['provider', 'consumer'] as const) {
    const url = form[side].url.trim()
    if (!url) problems[`${side}.url`] = 'Enter a GitHub repository URL.'
    else if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(url)) problems[`${side}.url`] = 'Use the form https://github.com/owner/repository, without /tree/.'
    if (!form[side].current_ref.trim()) problems[`${side}.current_ref`] = 'Enter the branch, tag or commit that is deployed now.'
    if (!form[side].proposed_ref.trim()) problems[`${side}.proposed_ref`] = 'Enter the branch, tag or commit you want to release.'
  }
  return problems
}

function sourceLocation(file: string, line: number | null): string {
  if (!file) return ''
  return line === null ? file : `${file}:${line}`
}

function StatusBadge({ status }: { status: string }) {
  const meta = statusOf(status)
  const style = TONE_STYLES[meta.tone]
  const Icon = meta.icon
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', style.tint, style.text)}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">Status: </span>
      {meta.label}
    </span>
  )
}

function EvidenceItem({ item }: { item: RolloutEvidence }) {
  const badge = evidenceBadge(item.evidence_tier, item.usage)
  const field = changedFieldLabel(item.field, item.field_in)
  const source = sourceLocation(item.file, item.line)
  return (
    <li className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.verdict} />
        <ToneBadge label={badge.label} tone={badge.tone} prefix="Evidence" />
      </div>
      <p className="mt-2 break-all font-mono text-xs">
        <span className="text-muted-foreground">{humanizeCode(item.change_type)}: </span>
        {item.method && `${item.method} `}
        {item.path}
        {field && <span className="font-medium"> ({field})</span>}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{item.explanation}</p>
      {source && (
        <p className="mt-2 break-all font-mono text-xs">
          <span className="text-muted-foreground">Consumer source: </span>
          {source}
        </p>
      )}
      {item.snippet && <code className="mt-1 block break-all font-mono text-xs text-foreground">{item.snippet}</code>}
    </li>
  )
}

/**
 * One rollout order: its status and one sentence of why. The pairing of refs,
 * the backend's full reasoning, every piece of evidence with its source line
 * and everything that could not be established are in "View evidence".
 */
function StateCard({ state, refs, recommended }: { state: RolloutState; refs: AnalyzedRef[]; recommended?: boolean }) {
  const meta = statusOf(state.status)
  const style = TONE_STYLES[meta.tone]
  const refText = (label: string) => {
    const found = refs.find((ref) => ref.label === label)
    return found ? `${label} (${found.ref})` : label
  }
  return (
    <section aria-label={state.title} className={cx('flex flex-col overflow-hidden rounded-lg border bg-card', recommended ? style.border : 'border-border')}>
      <header className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-display text-xl tracking-tight">{state.title}</h3>
          <StatusBadge status={state.status} />
          {recommended && <span className="text-xs font-medium text-muted-foreground">Recommended order</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{state.description}</p>
        <p className="mt-3 text-sm">{conciseReason(state)}</p>
        {state.status === 'UNKNOWN' && <p className="mt-1 text-xs text-muted-foreground">An unknown order is not treated as compatible.</p>}
      </header>

      <div className="border-t border-border px-5 py-3">
        <Disclosure label={state.evidence.length > 0 ? `View evidence (${state.evidence.length})` : 'View evidence'}>
          <p className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <span className="break-all rounded-sm bg-secondary px-1.5 py-0.5">Provider {refText(state.provider)}</span>
            <ArrowRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
            <span className="sr-only">called by</span>
            <span className="break-all rounded-sm bg-secondary px-1.5 py-0.5">Consumer {refText(state.consumer)}</span>
          </p>
          <p className="mt-3 text-sm">
            {state.reason}
            <span className="mt-1 block text-xs text-muted-foreground">{meta.meaning}</span>
          </p>
          {state.evidence.length > 0 && (
            <ul className="mt-4 border-t border-border pt-4">
              {state.evidence.map((item, index) => (
                <EvidenceItem key={`${item.method}:${item.path}:${item.field}:${index}`} item={item} />
              ))}
            </ul>
          )}
          {state.unresolved.length > 0 && (
            <div className="mt-4 border-t border-border pt-4">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Could not be established</h4>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
                {state.unresolved.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </Disclosure>
      </div>
    </section>
  )
}

function RefsTable({ refs }: { refs: AnalyzedRef[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <caption className="px-5 pt-4 text-left text-xs text-muted-foreground">
          Exactly what was read. A ref is resolved to a commit first, and everything is fetched at that commit.
        </caption>
        <thead className="text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-5 py-2 font-medium">Ref</th>
            <th scope="col" className="px-3 py-2 font-medium">Repository</th>
            <th scope="col" className="px-3 py-2 font-medium">Commit</th>
            <th scope="col" className="px-5 py-2 font-medium">What was read</th>
          </tr>
        </thead>
        <tbody>
          {refs.map((ref) => (
            <tr key={ref.label} className="border-t border-border align-top">
              <th scope="row" className="px-5 py-3 font-normal">
                <span className="font-mono text-xs font-medium">{ref.label}</span>
                <span className="mt-0.5 block break-all font-mono text-xs text-muted-foreground">{ref.ref}</span>
              </th>
              <td className="break-all px-3 py-3 font-mono text-xs">{ref.repository}</td>
              <td className="px-3 py-3 font-mono text-xs">{ref.commit ? ref.commit.slice(0, 10) : <span className="font-sans text-muted-foreground">Not resolved</span>}</td>
              <td className="px-5 py-3 text-muted-foreground">
                {ref.problem ? (
                  ref.problem
                ) : ref.spec_file ? (
                  <>
                    <span className="font-mono text-xs text-foreground">{ref.spec_file}</span>
                    {(ref.api_title || ref.api_version) && ` (${[ref.api_title, ref.api_version && `version ${ref.api_version}`].filter(Boolean).join(', ')})`}
                  </>
                ) : ref.files_read !== null ? (
                  `${ref.files_read} source ${ref.files_read === 1 ? 'file' : 'files'}`
                ) : (
                  'Nothing was read'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const DIRECTIONS: Record<string, { title: string; note: string }> = {
  P0_TO_P1: { title: 'From P0 to P1', note: 'What P1 no longer accepts or returns. It matters while the consumer is still on C0.' },
  P1_TO_P0: { title: 'In P1 but not in P0', note: 'What a consumer written for P1 may rely on. It matters while the provider is still on P0.' },
}

/** The contract changes in full: both directions, before and after values, specification file and JSON pointer. */
function ContractChanges({ changes }: { changes: RolloutContractChange[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Object.entries(DIRECTIONS).map(([direction, meta]) => {
        const listed = changes.filter((change) => change.direction === direction)
        return (
          <section key={direction} aria-label={meta.title} className="min-w-0 rounded-lg border border-border bg-card">
            <header className="px-5 py-4">
              <h3 className="font-medium">{meta.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{meta.note}</p>
            </header>
            {listed.length === 0 ? (
              <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">Nothing detected in this direction.</p>
            ) : (
              <ul>
                {listed.map((change, index) => (
                  <li key={`${change.method}:${change.path}:${change.field}:${index}`} className="border-t border-border px-5 py-4">
                    <p className="font-medium">{humanizeCode(change.change_type)}</p>
                    <p className="mt-1 break-all font-mono text-xs">
                      {change.method && `${change.method} `}
                      {change.path}
                    </p>
                    <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground">Before</dt>
                        <dd className="break-all font-mono">{change.previous_value}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">After</dt>
                        <dd className="break-all font-mono">{change.new_value}</dd>
                      </div>
                    </dl>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {change.spec_file} {change.json_pointer}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}

/** Each detected change as one line: the endpoint, what changed, and which order it matters for. */
function ChangeSummaryList({ changes }: { changes: RolloutContractChange[] }) {
  return (
    <ul aria-label="Contract changes in brief" className="divide-y divide-border rounded-lg border border-border bg-card">
      {rolloutChangeLines(changes).map((line, index) => (
        <li key={`${line.endpoint}:${line.subject}:${index}`} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-5 py-3 text-sm">
          <p className="min-w-0">
            <span className="break-all font-mono text-xs">{line.endpoint}</span>
            <span className="mt-0.5 block">
              {line.subject && <code className="mr-1 break-all rounded-sm bg-secondary px-1 py-0.5 font-mono text-xs">{line.subject}</code>}
              {line.change}
            </span>
          </p>
          <span className="text-xs text-muted-foreground">{line.matters}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The backend's summary opens by restating the recommendation ("Deploy the
 * consumer first."), which the heading right above it already says. The rest
 * of the summary is the reason.
 */
export function whyText(label: string, summary: string): string {
  const lead = `${label}. `
  return summary.startsWith(lead) && summary.length > lead.length ? summary.slice(lead.length) : summary
}

function Results({ result }: { result: RolloutResult }) {
  const recommendation = recommendationOf(result.recommendation)
  const style = TONE_STYLES[recommendation.tone]
  const top = useRef<HTMLElement>(null)
  const unread = result.refs.filter((ref) => ref.problem)

  // The answer is what was asked for: bring it into view instead of leaving it below the form.
  useEffect(() => {
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    top.current?.scrollIntoView?.({ block: 'start', behavior: calm ? 'auto' : 'smooth' })
  }, [result])

  return (
    <div className="mt-6 space-y-8" aria-live="polite">
      <section ref={top} aria-label="Recommendation" className={cx('scroll-mt-6 rounded-lg border px-6 py-6', style.border, style.tint)}>
        <p className="eyebrow">Recommended next action</p>
        <h2 className="mt-2 font-display text-4xl tracking-tight sm:text-5xl">{recommendation.label}</h2>
        <p className="mt-3 max-w-3xl">
          <span className="font-medium">Why: </span>
          {whyText(recommendation.label, result.summary)}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Based on reading specifications and source code at the given refs. Nothing was executed, and this is not a guarantee about production.
        </p>
      </section>

      {unread.length > 0 && (
        // Something the analysis needed could not be read. That is a warning, so it is never folded away.
        <Banner tone="warning" role="status" title={`${plural(unread.length, 'ref')} could not be read`}>
          <ul className="space-y-1">
            {unread.map((ref) => (
              <li key={ref.label}>
                <span className="font-mono text-xs font-medium">{ref.label}</span> {ref.problem}
              </li>
            ))}
          </ul>
        </Banner>
      )}

      <section aria-labelledby="states-title">
        <h2 id="states-title" className="font-display text-2xl tracking-tight">The two rollout orders</h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <StateCard state={result.provider_first} refs={result.refs} recommended={result.recommendation === 'PROVIDER_FIRST' || result.recommendation === 'EITHER'} />
          <StateCard state={result.consumer_first} refs={result.refs} recommended={result.recommendation === 'CONSUMER_FIRST' || result.recommendation === 'EITHER'} />
        </div>
        <div className="mt-4">
          <StateCard state={result.final} refs={result.refs} />
        </div>
      </section>

      <section aria-labelledby="changes-title">
        <h2 id="changes-title" className="font-display text-2xl tracking-tight">Contract changes</h2>
        <div className="mt-4">
          {result.contract_changes.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
              No removed operation, newly required request value or changed response type was detected between the two provider
              specifications. Other kinds of difference are not checked.
            </p>
          ) : (
            <>
              <ChangeSummaryList changes={result.contract_changes} />
              <Disclosure label="Show contract details" className="mt-3">
                <ContractChanges changes={result.contract_changes} />
              </Disclosure>
            </>
          )}
        </div>
      </section>

      {result.unresolved.length > 0 && (
        <section aria-label="Unresolved">
          <h2 className="font-display text-2xl tracking-tight">Unresolved</h2>
          <p className="mt-1 text-sm">
            {plural(result.unresolved.length, 'point')} could not be established. None of this is evidence of compatibility.
          </p>
          <Disclosure label={`Show unresolved details (${result.unresolved.length})`} className="mt-2">
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {result.unresolved.map((item, index) => (
                <li key={index} className="px-5 py-3 text-sm">
                  <span className="font-mono text-xs font-medium">{item.scope}</span>
                  <span className="mt-0.5 block break-words text-muted-foreground">{item.reason}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </section>
      )}

      <section aria-label="Analyzed refs" className="space-y-2">
        <Disclosure label="Show analyzed refs">
          <RefsTable refs={result.refs} />
        </Disclosure>
        {result.limitations.length > 0 && (
          <Disclosure label="What this does not cover">
            <ul className="max-w-4xl list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {result.limitations.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </Disclosure>
        )}
      </section>
    </div>
  )
}

interface RolloutPlannerProps {
  onBack: () => void
  /** Replaceable in tests. The page always calls the real backend otherwise. */
  analyze?: AnalyzeRollout
}

export function RolloutPlanner({ onBack, analyze = analyzeRollout }: RolloutPlannerProps) {
  const baseId = useId()
  const [form, setForm] = useState<RolloutRequest>(EMPTY)
  const [problems, setProblems] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ title: string; message: string } | null>(null)
  const [result, setResult] = useState<RolloutResult | null>(null)
  const [analyzed, setAnalyzed] = useState<RolloutRequest | null>(null)
  const controller = useRef<AbortController | null>(null)

  const patch = (side: Side, name: FieldName, value: string) => {
    setForm((current) => ({ ...current, [side]: { ...current[side], [name]: value } }))
    setProblems((current) => {
      if (!current[`${side}.${name}`]) return current
      const { [`${side}.${name}`]: _removed, ...rest } = current
      return rest
    })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = validateRollout(form)
    setProblems(found)
    if (Object.keys(found).length > 0) return
    const request: RolloutRequest = {
      provider: { url: form.provider.url.trim().replace(/\/+$/, ''), current_ref: form.provider.current_ref.trim(), proposed_ref: form.provider.proposed_ref.trim() },
      consumer: { url: form.consumer.url.trim().replace(/\/+$/, ''), current_ref: form.consumer.current_ref.trim(), proposed_ref: form.consumer.proposed_ref.trim() },
    }
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setBusy(true)
    setError(null)
    // The previous answer is cleared first: an old verdict must not sit next to new inputs.
    setResult(null)
    try {
      const answer = await analyze(request, { signal: current.signal })
      if (controller.current !== current) return
      setResult(answer)
      setAnalyzed(request)
    } catch (failure) {
      if (controller.current !== current || isCancelled(failure)) return
      setError(rolloutErrorMessage(failure))
    } finally {
      if (controller.current === current) setBusy(false)
    }
  }

  return (
    <div className="guide-lines relative min-h-screen overflow-x-clip">
      <header className="relative mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <nav aria-label="Primary" className="flex h-16 items-center justify-between gap-6 rounded-xl border border-border bg-card/90 px-5 shadow-nav backdrop-blur sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-4 text-sm sm:gap-8">
            <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-foreground/70 transition-colors hover:text-foreground">
              <ArrowLeft aria-hidden="true" className="size-4" />
              Dependency scan
            </button>
            <span aria-current="page" className="hidden font-medium sm:inline">Rollout planner</span>
            <AuthButton />
          </div>
        </nav>
      </header>

      <main className="relative mx-auto max-w-[1400px] px-4 pb-24 pt-12 sm:px-6 lg:px-8">
        <p className="eyebrow">Rollout planner</p>
        <h1 className="mt-4 font-display text-[clamp(2.25rem,5vw,4rem)] leading-[0.95] tracking-tight">Which side should be deployed first?</h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-muted-foreground">
          Give one provider and one consumer, each at the ref that is deployed now and the ref you want to release. The
          planner compares the provider&apos;s OpenAPI specification at both refs, reads the consumer&apos;s code at both
          refs, and evaluates the two intermediate states of the rollout.
        </p>

        <form noValidate onSubmit={submit} aria-label="Rollout to analyze" className="mt-10 max-w-5xl rounded-xl border border-border bg-card shadow-nav">
          <div className="grid gap-px overflow-hidden rounded-t-xl bg-border md:grid-cols-2">
            {(['provider', 'consumer'] as const).map((side) => (
              <div key={side} role="group" aria-labelledby={`${baseId}-${side}`} className="bg-card px-4 py-5 sm:px-6">
                <h2 id={`${baseId}-${side}`} className="font-display text-xl tracking-tight">
                  {FIELDS[side].title}
                </h2>
                <div className="mt-3 space-y-4">
                  {FIELDS[side].fields.map((item) => {
                    const id = `${baseId}-${side}-${item.name}`
                    const problem = problems[`${side}.${item.name}`]
                    return (
                      <div key={item.name}>
                        <label htmlFor={id} className="flex items-center gap-2 text-xs text-muted-foreground">
                          {item.label}
                          {item.tag && <span className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-foreground">{item.tag}</span>}
                        </label>
                        <input
                          id={id}
                          type={item.name === 'url' ? 'url' : 'text'}
                          value={form[side][item.name]}
                          onChange={(event) => patch(side, item.name, event.target.value)}
                          placeholder={item.placeholder}
                          autoComplete="off"
                          spellCheck={false}
                          aria-invalid={problem ? true : undefined}
                          aria-describedby={problem ? `${id}-problem` : undefined}
                          className={cx(FIELD, 'mt-1 font-mono', problem && 'border-risk-critical')}
                        />
                        {problem && (
                          <p id={`${id}-problem`} className="mt-1 text-xs text-risk-critical">
                            {problem}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-4 sm:px-6">
            <BusyButton type="submit" variant="primary" size="lg" busy={busy}>
              {busy ? 'Analyzing rollout' : 'Analyze Rollout'}
            </BusyButton>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setForm(SAMPLE_REQUEST)
                setProblems({})
              }}
            >
              Fill in a public example
            </Button>
            <p className="text-xs text-muted-foreground">Refs can be branches, tags or commit SHAs. Public repositories only.</p>
          </div>
        </form>

        {busy && (
          <p role="status" className="mt-6 max-w-5xl rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
            Fetching the four refs from GitHub, comparing the provider specifications and reading the consumer code. This usually takes a few seconds.
          </p>
        )}

        {error && (
          <Banner tone="error" role="alert" title={error.title} className="mt-6 max-w-5xl" onDismiss={() => setError(null)}>
            {error.message}
          </Banner>
        )}

        {result && analyzed && (
          <>
            <p className="mt-10 break-words text-xs text-muted-foreground">
              Result for provider <span className="font-mono">{analyzed.provider.current_ref}</span> to{' '}
              <span className="font-mono">{analyzed.provider.proposed_ref}</span>, consumer{' '}
              <span className="font-mono">{analyzed.consumer.current_ref}</span> to <span className="font-mono">{analyzed.consumer.proposed_ref}</span>.
            </p>
            <Results result={result} />
          </>
        )}
      </main>
    </div>
  )
}
