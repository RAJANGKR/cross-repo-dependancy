import { Check, LoaderCircle } from 'lucide-react'
import { SCAN_STAGES, type ScanProgress } from '../../api/scanTypes'
import type { SubmittedRepo } from '../../hooks/useScan'
import { useElapsedSeconds } from '../../hooks/useUi'
import { cx } from '../../lib/cx'
import type { DataSource } from '../../lib/exportMarkdown'
import { formatElapsed } from '../../lib/formatters'
import { Button } from '../common/Button'
import { SourceBadge, Wordmark } from '../common/Tags'

const STAGE_COPY: Record<string, { title: string; text: string }> = {
  QUEUED: { title: 'Queued', text: 'The scan is accepted and waiting to start.' },
  FETCHING: { title: 'Fetching', text: 'Reading manifests and lockfiles from GitHub.' },
  PARSING: { title: 'Parsing', text: 'Extracting declared ranges and resolved versions.' },
  ANALYZING: { title: 'Analyzing', text: 'Comparing versions and checking release evidence.' },
}

function Block({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-muted', className)} />
}

/** Placeholders sized like the real dashboard so nothing shifts when data arrives. */
export function DashboardSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-8">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
          <div key={item} className="bg-background p-6">
            <Block className="h-10 w-16" />
            <Block className="mt-3 h-4 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((item) => (
          <Block key={item} className="h-14 w-full" />
        ))}
      </div>
    </div>
  )
}

interface AnalyzingStateProps {
  source: DataSource
  startedAt: number
  scanId: string | null
  /** Latest backend status, or "SUBMITTING" before the first reply. */
  status: string
  progress: ScanProgress | null
  repos: SubmittedRepo[]
  /** Why this run is playing instead of what was asked for. */
  notice?: string | null
  onCancel: () => void
}

const HEADINGS: Record<DataSource, string> = {
  live: 'Analyzing your repositories',
  demo: 'Loading the saved demo scan',
  sample: 'Playing the sample scan',
}

export function AnalyzingState({ source, startedAt, scanId, status, progress, repos, notice, onCancel }: AnalyzingStateProps) {
  const elapsed = useElapsedSeconds(startedAt)
  const stageIndex = (SCAN_STAGES as readonly string[]).indexOf(status)
  const known = stageIndex !== -1
  const percentage = progress?.percentage ?? null
  const current =
    status === 'SUBMITTING'
      ? 'Submitting the scan'
      : progress?.current_action || STAGE_COPY[status]?.text || `Status: ${status}`

  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 pb-24 pt-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] lg:gap-16">
          <section aria-labelledby="analyzing-title">
            <div className="flex flex-wrap items-center gap-3">
              <p className="eyebrow">Scan in progress</p>
              <SourceBadge source={source} />
            </div>
            <h1 id="analyzing-title" className="mt-6 font-display text-4xl tracking-tight lg:text-5xl">
              {HEADINGS[source]}
            </h1>
            {notice && <p className="mt-4 rounded-md border border-warning/30 bg-warning-tint px-4 py-3 text-sm">{notice}</p>}
            <p role="status" aria-live="polite" className="mt-4 min-h-14 text-lg text-muted-foreground">
              {current}
            </p>

            <div
              role="progressbar"
              aria-label="Scan progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percentage ?? undefined}
              aria-valuetext={percentage === null ? 'In progress' : `${percentage} percent`}
              className="mt-6 h-1 overflow-hidden rounded-full bg-muted"
            >
              {percentage === null ? (
                <div className="h-full w-2/5 animate-indeterminate rounded-full bg-foreground" />
              ) : (
                <div
                  className="h-full rounded-full bg-foreground transition-[width] duration-500"
                  style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
                />
              )}
            </div>
            <p className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-sm text-muted-foreground">
              <span>
                Elapsed <span className="tabular-nums text-foreground">{formatElapsed(elapsed)}</span>
              </span>
              {percentage !== null && <span className="tabular-nums">{percentage}%</span>}
              {scanId && <span className="break-all">{scanId}</span>}
            </p>

            <ol aria-label="Scan stages" className="mt-8 divide-y divide-border rounded-lg border border-border bg-card">
              {SCAN_STAGES.map((stage, index) => {
                const state = !known ? 'pending' : index < stageIndex ? 'done' : index === stageIndex ? 'active' : 'pending'
                return (
                  <li
                    key={stage}
                    aria-current={state === 'active' ? 'step' : undefined}
                    className={cx('flex items-start gap-3 px-4 py-3 text-sm', state === 'pending' && 'text-muted-foreground')}
                  >
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                      {state === 'done' && <Check aria-hidden="true" className="size-4 text-success" />}
                      {state === 'active' && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
                      {state === 'pending' && <span aria-hidden="true" className="size-1.5 rounded-full bg-border" />}
                    </span>
                    <span>
                      <span className="font-medium">{STAGE_COPY[stage]?.title}</span>
                      <span className="sr-only">
                        {state === 'done' ? ', done' : state === 'active' ? ', in progress' : ', not started'}
                      </span>
                      <span className="block text-muted-foreground">{STAGE_COPY[stage]?.text}</span>
                    </span>
                  </li>
                )
              })}
            </ol>

            {repos.length > 0 && (
              <ul aria-label="Repositories in this scan" className="mt-6 space-y-1 text-sm">
                {repos.map((repo, index) => (
                  // The same repository can be scanned at two refs, so its URL alone is not a unique key.
                  <li key={`${repo.url}:${index}`} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">{repo.label}</span>
                    <span className="font-mono text-xs leading-5 text-muted-foreground">{repo.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <DashboardSkeleton />
        </div>
      </main>
    </div>
  )
}
