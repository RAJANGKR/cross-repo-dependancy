import { useMemo, useState } from 'react'
import type { UiError } from '../../api/errors'
import type { Report } from '../../api/types'
import { USE_MOCK } from '../../config'
import { GlyphField } from '../common/GlyphField'
import { Wordmark } from '../common/Tags'
import { LimitationsDialog } from '../states/LimitationsDialog'
import type { ResolvedRefs } from './GithubTab'
import { InputCard, type RateLimitInfo } from './InputCard'

const HEADLINE_WORD = 'break'

const STEPS = [
  {
    numeral: 'I',
    title: 'Fetch',
    text: 'Reads package.json, requirements.txt and pom.xml from each project, straight from GitHub or from what you paste.',
  },
  {
    numeral: 'II',
    title: 'Compare',
    text: 'Groups every direct dependency by library and flags the ones pinned to different versions across projects.',
  },
  {
    numeral: 'III',
    title: 'Score',
    text: 'Weighs the version gap, changelogs, known vulnerabilities and your actual code usage, and shows the evidence.',
  },
]

interface InputScreenProps {
  busy: boolean
  inlineError: UiError | null
  onDismissError: () => void
  onAnalyze: () => void
  onLoadDemo: () => void
  /** The most recent report, used for rate-limit status and resolved refs. */
  lastReport: Report | null
}

export function InputScreen({ busy, inlineError, onDismissError, onAnalyze, onLoadDemo, lastReport }: InputScreenProps) {
  const [limitationsOpen, setLimitationsOpen] = useState(false)

  const resolvedRefs = useMemo<ResolvedRefs>(() => {
    const map = new Map<string, { ref: string; commit: string }>()
    for (const repo of lastReport?.repos ?? []) {
      if (repo.origin === 'github' && repo.url) {
        map.set(repo.url.toLowerCase(), { ref: repo.ref, commit: repo.commit })
      }
    }
    return map
  }, [lastReport])

  const rateLimit = useMemo<RateLimitInfo | null>(() => {
    const remaining = lastReport?.meta.github_rate_limit_remaining ?? null
    return remaining === null || !lastReport ? null : { remaining, source: lastReport.meta.source }
  }, [lastReport])

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
            <button
              type="button"
              onClick={() => setLimitationsOpen(true)}
              className="text-foreground/70 transition-colors hover:text-foreground"
            >
              Limitations
            </button>
            <span className="rounded-full bg-secondary px-3 py-1 font-mono text-xs text-muted-foreground">
              {USE_MOCK ? 'Mock mode' : 'Live API'}
            </span>
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
          Dependabot tells you versions differ. DriftLock tells you whether your code will actually break.
        </p>

        <div className="mt-12 max-w-5xl">
          <InputCard
            busy={busy}
            inlineError={inlineError}
            onDismissError={onDismissError}
            onAnalyze={onAnalyze}
            onLoadDemo={onLoadDemo}
            resolvedRefs={resolvedRefs}
            rateLimit={rateLimit}
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
            Works on any public repo. Nothing to install in your repos.
          </p>
        </section>
      </main>

      <footer className="relative border-t border-border">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:px-6 lg:px-8">
          <p>DriftLock. Risk is a signal, not a guarantee.</p>
          <button
            type="button"
            onClick={() => setLimitationsOpen(true)}
            className="underline decoration-foreground/30 underline-offset-4 transition-colors hover:text-foreground"
          >
            Limitations
          </button>
        </div>
      </footer>

      {limitationsOpen && <LimitationsDialog onClose={() => setLimitationsOpen(false)} />}
    </div>
  )
}
