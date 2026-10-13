import { FileQuestion, Gauge, ServerCrash, Timer, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react'
import type { UiError, UiErrorAction, UiErrorKind } from '../../api/errors'
import { Button } from '../common/Button'
import { Wordmark } from '../common/Tags'

const ICONS: Record<UiErrorKind, LucideIcon> = {
  'bad-request': TriangleAlert,
  'rate-limited': Gauge,
  unreachable: WifiOff,
  timeout: Timer,
  'unexpected-response': FileQuestion,
  'server-error': ServerCrash,
}

const ACTION_LABELS: Record<UiErrorAction, string> = {
  retry: 'Retry',
  'load-demo': 'Load demo run',
  'edit-input': 'Edit input',
  'switch-to-paste-tab': 'Use the Paste manifests tab',
}

interface ErrorStateProps {
  error: UiError
  onAction: (action: UiErrorAction) => void
}

export function ErrorState({ error, onAction }: ErrorStateProps) {
  const Icon = ICONS[error.kind]
  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-20 sm:px-6">
        <div role="alert">
          <Icon aria-hidden="true" className="size-10 text-muted-foreground" strokeWidth={1.5} />
          <p className="eyebrow mt-8">Something went wrong</p>
          <h1 className="mt-6 font-display text-4xl tracking-tight lg:text-6xl">{error.title}</h1>
          <p className="mt-6 text-xl leading-relaxed text-muted-foreground">{error.message}</p>
        </div>
        <div className="mt-10 flex flex-wrap gap-3">
          {error.actions.map((action, index) => (
            <Button
              key={action}
              size="lg"
              variant={index === 0 ? 'primary' : 'secondary'}
              onClick={() => onAction(action)}
            >
              {ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
        {error.actions.includes('load-demo') && (
          <p className="mt-4 font-mono text-xs text-muted-foreground">The demo run uses saved demo data</p>
        )}
      </main>
    </div>
  )
}

interface NoResultsProps {
  onStart: () => void
  onLoadDemo: () => void
}

/** Shown at /results when no analysis has been run in this session. */
export function NoResults({ onStart, onLoadDemo }: NoResultsProps) {
  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-20 sm:px-6">
        <p className="eyebrow">Results</p>
        <h1 className="mt-6 font-display text-4xl tracking-tight lg:text-6xl">No results to show yet</h1>
        <p className="mt-6 text-xl leading-relaxed text-muted-foreground">
          Results are kept only while this page is open. Run an analysis, or load the demo run to see this
          view with your filters applied.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-3">
          <Button size="lg" variant="primary" onClick={onStart}>
            Start an analysis
          </Button>
          <Button size="lg" onClick={onLoadDemo}>
            Load demo run
          </Button>
          <span className="font-mono text-xs text-muted-foreground">Uses saved demo data</span>
        </div>
      </main>
    </div>
  )
}
