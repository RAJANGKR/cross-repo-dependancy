import { ArrowRight, ClipboardPaste, Link2 } from 'lucide-react'
import { useId, useRef, type KeyboardEvent } from 'react'
import type { UiError } from '../../api/errors'
import type { ReportSource } from '../../api/types'
import { MAX_PROJECTS, RATE_LIMIT_LOW_THRESHOLD, USE_MOCK } from '../../config'
import { useProjectInput } from '../../hooks/useProjectInput'
import { cx } from '../../lib/cx'
import { SOURCE_LABELS } from '../../lib/exportMarkdown'
import type { InputTab } from '../../lib/projectInput'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { GithubTab, type ResolvedRefs } from './GithubTab'
import { PasteTab } from './PasteTab'

const TABS: ReadonlyArray<{ id: InputTab; label: string; icon: typeof Link2 }> = [
  { id: 'github', label: 'GitHub links', icon: Link2 },
  { id: 'paste', label: 'Paste manifests', icon: ClipboardPaste },
]

export function ProjectCounter({ count }: { count: number }) {
  return (
    <p className="font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">
      {count} of {MAX_PROJECTS} projects
    </p>
  )
}

export interface RateLimitInfo {
  remaining: number
  source: ReportSource
}

function RateLimitStatus({ info }: { info: RateLimitInfo }) {
  const low = info.remaining < RATE_LIMIT_LOW_THRESHOLD
  return (
    <p className={cx('text-xs', low ? 'text-warning' : 'text-muted-foreground')}>
      GitHub API calls remaining: <span className="font-mono tabular-nums">{info.remaining}</span>
      {info.source === 'demo' && ` (${SOURCE_LABELS.demo.toLowerCase()})`}
      {low && '. The limit is low, so the next analysis may be rate limited.'}
    </p>
  )
}

interface InputCardProps {
  busy: boolean
  /** A rejected request, shown under the input. */
  inlineError: UiError | null
  onDismissError: () => void
  onAnalyze: () => void
  onLoadDemo: () => void
  resolvedRefs: ResolvedRefs
  rateLimit: RateLimitInfo | null
}

export function InputCard({
  busy,
  inlineError,
  onDismissError,
  onAnalyze,
  onLoadDemo,
  resolvedRefs,
  rateLimit,
}: InputCardProps) {
  const { state, summary, setTab } = useProjectInput()
  const baseId = useId()
  const tabRefs = useRef<Record<InputTab, HTMLButtonElement | null>>({ github: null, paste: null })
  const reasonId = useId()

  const onTabKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next: InputTab = state.tab === 'github' ? 'paste' : 'github'
    setTab(next)
    tabRefs.current[next]?.focus()
  }

  const githubCount = summary.validChips.length
  const counts: Record<InputTab, number> = { github: githubCount, paste: state.projects.length }

  return (
    <section aria-label="Projects to analyze" className="rounded-xl border border-border bg-card shadow-nav">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
        <div role="tablist" aria-label="How to add projects" className="flex" onKeyDown={onTabKeyDown}>
          {TABS.map(({ id, label, icon: Icon }) => {
            const selected = state.tab === id
            return (
              <button
                key={id}
                ref={(element) => {
                  tabRefs.current[id] = element
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(id)}
                className={cx(
                  '-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-4 font-mono text-sm transition-colors',
                  selected
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
                {counts[id] > 0 && (
                  <span className="rounded-full bg-secondary px-1.5 text-xs tabular-nums">
                    {counts[id]}
                    <span className="sr-only"> added</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <ProjectCounter count={summary.projectCount} />
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${state.tab}`}
        aria-labelledby={`${baseId}-tab-${state.tab}`}
        className="px-4 py-6 sm:px-6"
      >
        {state.tab === 'github' ? <GithubTab resolvedRefs={resolvedRefs} /> : <PasteTab />}
      </div>

      <div className="space-y-4 border-t border-border px-4 py-5 sm:px-6">
        {summary.atLimit && (
          <Banner tone="warning" role="status">
            You have {MAX_PROJECTS} projects, the most one run can take. Remove one to add another.
          </Banner>
        )}
        {inlineError && (
          <Banner
            tone="error"
            role="alert"
            title={inlineError.title}
            onDismiss={onDismissError}
            actions={
              inlineError.actions.includes('switch-to-paste-tab') && state.tab !== 'paste' ? (
                <Button size="sm" onClick={() => setTab('paste')}>
                  Use the Paste manifests tab for private projects
                </Button>
              ) : undefined
            }
          >
            {inlineError.message}
          </Banner>
        )}
        {USE_MOCK && (
          <Banner tone="info">
            Mock mode is on. Analyze projects returns the saved demo data, not a scan of your projects.
          </Banner>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button
            variant="primary"
            size="lg"
            onClick={onAnalyze}
            disabled={busy || !summary.canAnalyze}
            aria-describedby={summary.blockedReason ? reasonId : undefined}
          >
            Analyze projects
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button size="lg" onClick={onLoadDemo} disabled={busy}>
            Load demo run
          </Button>
          <span className="font-mono text-xs text-muted-foreground">Uses saved demo data</span>
        </div>
        <p id={reasonId} className="min-h-5 text-sm text-muted-foreground">
          {summary.blockedReason ?? ''}
        </p>
        {rateLimit && <RateLimitStatus info={rateLimit} />}
      </div>
    </section>
  )
}
