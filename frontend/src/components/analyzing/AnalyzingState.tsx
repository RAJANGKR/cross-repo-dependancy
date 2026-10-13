import { Check, CircleX, Clock, LoaderCircle, type LucideIcon } from 'lucide-react'
import type { RunMode, SubmittedProject } from '../../hooks/useAnalysis'
import { useElapsedSeconds } from '../../hooks/useUi'
import { cx } from '../../lib/cx'
import { formatElapsed } from '../../lib/formatters'
import { Button } from '../common/Button'
import { Wordmark } from '../common/Tags'

/** Per-project progress. The backend answers once at the end today, so every
 *  row is "fetching"; streamed statuses can be passed in later unchanged. */
export type ProjectProgress = 'waiting' | 'fetching' | 'done' | 'failed'

const PROGRESS: Record<ProjectProgress, { label: string; icon: LucideIcon; classes: string }> = {
  waiting: { label: 'Waiting', icon: Clock, classes: 'text-muted-foreground' },
  fetching: { label: 'In progress', icon: LoaderCircle, classes: 'text-foreground' },
  done: { label: 'Done', icon: Check, classes: 'text-success' },
  failed: { label: 'Failed', icon: CircleX, classes: 'text-risk-critical' },
}

export function ProjectStatusList({
  projects,
  statuses,
}: {
  projects: SubmittedProject[]
  statuses?: Readonly<Record<string, ProjectProgress>>
}) {
  if (projects.length === 0) return null
  return (
    <ul aria-label="Project status" className="divide-y divide-border rounded-lg border border-border bg-card">
      {projects.map((project) => {
        const progress = statuses?.[project.name] ?? 'fetching'
        const { label, icon: Icon, classes } = PROGRESS[progress]
        return (
          <li key={`${project.origin}:${project.name}`} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="font-medium">{project.name}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {project.origin === 'github' ? 'GitHub' : 'Pasted'}
              </span>
            </span>
            <span className={cx('inline-flex shrink-0 items-center gap-1.5', classes)}>
              <Icon aria-hidden="true" className={cx('size-4', progress === 'fetching' && 'animate-spin')} />
              {label}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Block({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-muted', className)} />
}

/** Placeholders sized like the real dashboard so nothing shifts when data arrives. */
export function DashboardSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-8">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="bg-background p-6">
            <Block className="h-12 w-20" />
            <Block className="mt-3 h-4 w-28" />
          </div>
        ))}
      </div>
      <Block className="h-[420px] w-full rounded-lg" />
      <div className="space-y-2">
        {[0, 1, 2, 3, 4].map((item) => (
          <Block key={item} className="h-14 w-full" />
        ))}
      </div>
    </div>
  )
}

interface AnalyzingStateProps {
  mode: RunMode
  startedAt: number
  projects: SubmittedProject[]
  statuses?: Readonly<Record<string, ProjectProgress>>
  onCancel: () => void
}

export function AnalyzingState({ mode, startedAt, projects, statuses, onCancel }: AnalyzingStateProps) {
  const elapsed = useElapsedSeconds(startedAt)

  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 pb-24 pt-14 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
          <section aria-labelledby="analyzing-title">
            <p className="eyebrow">{mode === 'demo' ? 'Demo run' : 'Analysis'}</p>
            <h1 id="analyzing-title" className="mt-6 font-display text-4xl tracking-tight lg:text-5xl">
              {mode === 'demo' ? 'Loading the saved demo run' : 'Analyzing your projects'}
            </h1>
            <p className="mt-4 text-lg text-muted-foreground">
              {mode === 'demo'
                ? 'This is saved demo data, not a live scan.'
                : 'Fetching manifests, comparing versions, checking risk'}
            </p>

            <div
              role="progressbar"
              aria-label="Analysis in progress"
              aria-valuetext="In progress"
              className="mt-8 h-1 overflow-hidden rounded-full bg-muted"
            >
              <div className="h-full w-2/5 animate-indeterminate rounded-full bg-foreground" />
            </div>
            <p className="mt-3 font-mono text-sm text-muted-foreground">
              Elapsed{' '}
              <time role="timer" aria-live="off" className="tabular-nums text-foreground">
                {formatElapsed(elapsed)}
              </time>
            </p>

            <div className="mt-8">
              <ProjectStatusList projects={projects} statuses={statuses} />
            </div>
          </section>

          <DashboardSkeleton />
        </div>
      </main>
    </div>
  )
}
