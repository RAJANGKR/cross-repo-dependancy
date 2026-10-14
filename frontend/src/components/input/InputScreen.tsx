import type { UiError } from '../../api/errors'
import { API_BASE_URL } from '../../config'
import { useBackendHealth, type BackendHealth } from '../../hooks/useBackendHealth'
import { cx } from '../../lib/cx'
import type { ScanTarget } from '../../lib/targets'
import { AuthButton } from '../common/AuthButton'
import { GlyphField } from '../common/GlyphField'
import { Wordmark } from '../common/Tags'
import { RepoForm, type FormState } from './RepoForm'

const HEADLINE_WORD = 'break'

const STEPS = [
  {
    numeral: 'I',
    title: 'Fetch',
    text: 'Reads manifests and lockfiles from each public repository, or from what you paste: package.json, requirements.txt, pyproject.toml, pom.xml and their lockfiles.',
  },
  {
    numeral: 'II',
    title: 'Compare',
    text: 'Lines up every shared package and separates what each repository declares from the version it actually resolves to.',
  },
  {
    numeral: 'III',
    title: 'Assess',
    text: 'Classifies the drift, then checks release notes for evidence of breaking changes. A version gap alone is never called a break.',
  },
]

const HEALTH: Record<BackendHealth, { label: string; dot: string }> = {
  checking: { label: 'Checking backend', dot: 'bg-muted-foreground' },
  online: { label: 'Backend online', dot: 'bg-success' },
  unreachable: { label: 'Backend unreachable', dot: 'bg-risk-critical' },
  mock: { label: 'Mock mode', dot: 'bg-warning' },
}

interface InputScreenProps {
  form: FormState
  onFormChange: (form: FormState) => void
  busy: boolean
  error: UiError | null
  onDismissError: () => void
  onSubmit: (targets: ScanTarget[]) => void
  onLoadDemo: () => void
  /** Opens the rollout planner. The link is hidden when no handler is given. */
  onOpenRollout?: () => void
}

export function InputScreen({ form, onFormChange, busy, error, onDismissError, onSubmit, onLoadDemo, onOpenRollout }: InputScreenProps) {
  const health = useBackendHealth()

  return (
    <div className="guide-lines relative min-h-screen overflow-x-clip">
      <GlyphField className="pointer-events-none absolute inset-x-0 top-0 h-[46rem] w-full" />

      <header className="relative mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <nav
          aria-label="Primary"
          className="flex h-16 items-center justify-between gap-6 rounded-xl border border-border bg-card/90 px-5 shadow-nav backdrop-blur sm:px-6"
        >
          <Wordmark />
          <div className="flex items-center gap-6 text-sm sm:gap-10">
            <a href="#how-it-works" className="hidden text-foreground/70 transition-colors hover:text-foreground sm:inline">
              How it works
            </a>
            {onOpenRollout && (
              <button type="button" onClick={onOpenRollout} className="text-foreground/70 transition-colors hover:text-foreground">
                Rollout planner
              </button>
            )}
            <span
              role="status"
              title={health === 'mock' ? undefined : API_BASE_URL}
              className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1 font-mono text-xs text-muted-foreground"
            >
              <span aria-hidden="true" className={cx('size-2 rounded-full', HEALTH[health].dot)} />
              {HEALTH[health].label}
            </span>
            <AuthButton />
          </div>
        </nav>
      </header>

      <main className="relative mx-auto max-w-[1400px] px-4 pb-24 pt-16 sm:px-6 lg:px-8 lg:pt-20">
        <p className="eyebrow animate-rise-in">Cross-repo dependency drift detector</p>
        <h1
          aria-label={`Find the drift that will ${HEADLINE_WORD}`}
          className="mt-8 animate-rise-in font-display text-[clamp(2.75rem,9vw,7.5rem)] leading-[0.9] tracking-tight"
        >
          <span aria-hidden="true" className="block">
            Find the drift
          </span>
          <span aria-hidden="true" className="block">
            that will{' '}
            <span className="relative inline-block">
              <span className="inline-flex overflow-hidden pb-[0.12em]">
                {[...HEADLINE_WORD].map((char, index) => (
                  <span
                    key={`${char}-${index}`}
                    className="inline-block animate-char-in opacity-0"
                    style={{ animationDelay: `${300 + index * 50}ms` }}
                  >
                    {char}
                  </span>
                ))}
              </span>
              <span className="absolute -bottom-1 left-0 right-0 h-3 bg-foreground/10" />
            </span>
          </span>
        </h1>
        <p className="mt-10 max-w-2xl animate-rise-in text-xl leading-relaxed text-muted-foreground lg:text-2xl">
          Compare 2 to 10 services at once. See which shared packages have drifted, what each repository
          really resolves to, and what the release notes say about it.
        </p>

        <div className="mt-12 max-w-5xl">
          <RepoForm
            form={form}
            onChange={onFormChange}
            onSubmit={onSubmit}
            onLoadDemo={onLoadDemo}
            busy={busy}
            error={error}
            onDismissError={onDismissError}
          />
        </div>

        <section id="how-it-works" aria-labelledby="how-it-works-title" className="mt-24 scroll-mt-8">
          <p className="eyebrow">How it works</p>
          <h2 id="how-it-works-title" className="mt-6 font-display text-4xl tracking-tight lg:text-6xl">
            Three steps. <span className="text-muted-foreground">Evidence at every one.</span>
          </h2>
          <ol className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
            {STEPS.map((step) => (
              <li key={step.title} className="bg-background p-6 lg:p-8">
                <span aria-hidden="true" className="font-mono text-sm text-muted-foreground">
                  {step.numeral}
                </span>
                <h3 className="mt-6 font-display text-2xl tracking-tight">{step.title}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
          <p className="mt-8 text-lg text-muted-foreground">
            Works on public repositories. Nothing to install in them.
          </p>
        </section>
      </main>

      <footer className="relative border-t border-border">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:px-8">
          <p>DriftLock. Missing evidence is never shown as proof of safety.</p>
        </div>
      </footer>
    </div>
  )
}
