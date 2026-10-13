import {
  FileQuestion,
  Gauge,
  SearchX,
  ServerCrash,
  Timer,
  TriangleAlert,
  Unplug,
  WifiOff,
  type LucideIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { UiError, UiErrorAction, UiErrorKind } from '../../api/errors'
import { Button } from '../common/Button'
import { useCopy } from '../common/Controls'
import { Wordmark } from '../common/Tags'

const ICONS: Record<UiErrorKind, LucideIcon> = {
  'bad-request': TriangleAlert,
  'rate-limited': Gauge,
  unreachable: WifiOff,
  timeout: Timer,
  'unexpected-response': FileQuestion,
  'scan-not-found': SearchX,
  'scan-failed': ServerCrash,
  'endpoint-missing': Unplug,
  'server-error': ServerCrash,
}

const ACTION_LABELS: Record<UiErrorAction, string> = {
  retry: 'Retry scan',
  'load-demo': 'Load demo run',
  'edit-input': 'Edit repositories',
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-20 sm:px-6">{children}</main>
    </div>
  )
}

interface ErrorStateProps {
  error: UiError
  /** Shown when the failed run was the demo, so "Retry" is labeled correctly. */
  demo: boolean
  onAction: (action: UiErrorAction) => void
}

export function ErrorState({ error, demo, onAction }: ErrorStateProps) {
  const Icon = ICONS[error.kind]
  const copy = useCopy()
  return (
    <Shell>
      <div role="alert">
        <Icon aria-hidden="true" className="size-10 text-muted-foreground" strokeWidth={1.5} />
        <p className="eyebrow mt-8">{demo ? 'Demo run did not complete' : 'Scan did not complete'}</p>
        <h1 className="mt-6 font-display text-4xl tracking-tight lg:text-6xl">{error.title}</h1>
        <p className="mt-6 text-xl leading-relaxed text-muted-foreground">{error.message}</p>
        {error.code && <p className="mt-4 font-mono text-sm text-muted-foreground">Error code: {error.code}</p>}
      </div>
      <p className="mt-6 text-sm text-muted-foreground">No results are shown, because none were returned.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        {error.actions.map((action, index) => (
          <Button key={action} size="lg" variant={index === 0 ? 'primary' : 'secondary'} onClick={() => onAction(action)}>
            {action === 'retry' && demo ? 'Retry demo run' : ACTION_LABELS[action]}
          </Button>
        ))}
        <Button size="lg" variant="ghost" onClick={() => void copy(`${error.title}\n${error.message}${error.code ? `\nError code: ${error.code}` : ''}`, 'Error details')}>
          Copy error details
        </Button>
      </div>
      {error.actions.includes('load-demo') && (
        <p className="mt-4 font-mono text-xs text-muted-foreground">The demo run uses bundled demo data</p>
      )}
    </Shell>
  )
}

/** Shown at /results when no scan has been run in this session. */
export function NoResults({ onStart, onLoadDemo }: { onStart: () => void; onLoadDemo: () => void }) {
  return (
    <Shell>
      <p className="eyebrow">Results</p>
      <h1 className="mt-6 font-display text-4xl tracking-tight lg:text-6xl">No results to show yet</h1>
      <p className="mt-6 text-xl leading-relaxed text-muted-foreground">
        Results are kept only while this page is open. Run a scan, or load the demo run to see this view with
        your filters applied.
      </p>
      <div className="mt-10 flex flex-wrap items-center gap-3">
        <Button size="lg" variant="primary" onClick={onStart}>
          Start a scan
        </Button>
        <Button size="lg" onClick={onLoadDemo}>
          Load demo run
        </Button>
        <span className="font-mono text-xs text-muted-foreground">Uses bundled demo data</span>
      </div>
    </Shell>
  )
}
