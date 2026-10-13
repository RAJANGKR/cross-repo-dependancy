import { ArrowRight, Check, GitBranch } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'
import type { UiError } from '../../api/errors'
import { DEFAULT_REPO_LABELS, USE_MOCK } from '../../config'
import { useAnnounce } from '../../hooks/useAnnouncer'
import type { SubmittedRepo } from '../../hooks/useScan'
import { cx } from '../../lib/cx'
import { validateRepoInputs, type RepoInput } from '../../lib/validateRepoUrl'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'

const FIELD = 'h-11 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/70'

/** Real public repositories, offered so the form can be tried in one click. */
const EXAMPLE_URLS = [
  'https://github.com/pallets/flask',
  'https://github.com/fastapi/fastapi',
  'https://github.com/psf/requests',
]

interface RepoFormProps {
  inputs: RepoInput[]
  onChange: (inputs: RepoInput[]) => void
  onSubmit: (repos: SubmittedRepo[]) => void
  onLoadDemo: () => void
  busy: boolean
  /** A request the backend rejected, shown above the buttons. */
  error: UiError | null
  onDismissError: () => void
}

export function RepoForm({ inputs, onChange, onSubmit, onLoadDemo, busy, error, onDismissError }: RepoFormProps) {
  const announce = useAnnounce()
  const baseId = useId()
  const urlRefs = useRef<Array<HTMLInputElement | null>>([])
  const [touched, setTouched] = useState<boolean[]>([])
  const [submitted, setSubmitted] = useState(false)
  const validation = validateRepoInputs(inputs)

  const update = (index: number, patch: Partial<RepoInput>) =>
    onChange(inputs.map((input, position) => (position === index ? { ...input, ...patch } : input)))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setSubmitted(true)
    if (!validation.valid) {
      const firstInvalid = validation.errors.findIndex((message) => message !== null)
      urlRefs.current[firstInvalid]?.focus()
      const count = validation.errors.filter((message) => message !== null).length
      announce(`${count} of ${inputs.length} repository fields need attention`)
      return
    }
    onSubmit(
      inputs.flatMap((input, index) => {
        const parsed = validation.parsed[index]
        if (!parsed) return []
        const label = input.label.trim() || DEFAULT_REPO_LABELS[index] || `Repository ${index + 1}`
        return [{ label, url: parsed.url, name: parsed.repo, ref: parsed.ref }]
      }),
    )
  }

  const filled = inputs.filter((input) => input.url.trim() !== '').length

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label="Repositories to analyze"
      className="rounded-xl border border-border bg-card shadow-nav"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
        <p className="font-mono text-sm">Three repositories, one scan</p>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => {
              onChange(inputs.map((input, index) => ({ ...input, url: EXAMPLE_URLS[index] ?? input.url })))
              setTouched([])
              setSubmitted(false)
            }}
            className="text-xs text-foreground/70 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
          >
            Fill example repositories
          </button>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {filled} of {inputs.length} entered
          </p>
        </div>
      </div>

      <ol className="divide-y divide-border">
        {inputs.map((input, index) => {
          const parsed = validation.parsed[index]
          const message = validation.errors[index] ?? null
          const showError = message !== null && (submitted || (touched[index] === true && input.url.trim() !== ''))
          const labelId = `${baseId}-label-${index}`
          const urlId = `${baseId}-url-${index}`
          const errorId = `${baseId}-error-${index}`
          return (
            <li key={index} className="grid gap-x-4 gap-y-3 px-4 py-5 sm:px-6 md:grid-cols-[2rem_minmax(0,14rem)_minmax(0,1fr)]">
              <span aria-hidden="true" className="pt-8 font-mono text-sm text-muted-foreground">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <label htmlFor={labelId} className="block text-xs text-muted-foreground">
                  Label for repository {index + 1}
                </label>
                <input
                  id={labelId}
                  type="text"
                  value={input.label}
                  onChange={(event) => update(index, { label: event.target.value })}
                  placeholder={DEFAULT_REPO_LABELS[index]}
                  autoComplete="off"
                  className={cx(FIELD, 'mt-1')}
                />
              </div>
              <div>
                <label htmlFor={urlId} className="block text-xs text-muted-foreground">
                  GitHub repository URL {index + 1}
                </label>
                <input
                  ref={(element) => {
                    urlRefs.current[index] = element
                  }}
                  id={urlId}
                  type="url"
                  inputMode="url"
                  value={input.url}
                  onChange={(event) => update(index, { url: event.target.value })}
                  onBlur={() =>
                    setTouched((previous) => {
                      const next = [...previous]
                      next[index] = true
                      return next
                    })
                  }
                  aria-invalid={showError}
                  aria-describedby={errorId}
                  placeholder="https://github.com/owner/repo"
                  autoComplete="off"
                  spellCheck={false}
                  className={cx(FIELD, 'mt-1 font-mono', showError && 'border-risk-critical')}
                />
                <p id={errorId} className="mt-1.5 flex min-h-5 flex-wrap items-center gap-2 text-xs">
                  {showError ? (
                    <span className="text-risk-critical">{message}</span>
                  ) : (
                    parsed && (
                      <>
                        <span className="inline-flex items-center gap-1 text-success">
                          <Check aria-hidden="true" className="size-3.5" />
                          {parsed.owner}/{parsed.repo}
                        </span>
                        {parsed.ref && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 font-mono text-muted-foreground">
                            <GitBranch aria-hidden="true" className="size-3" />
                            <span className="sr-only">Branch </span>
                            {parsed.ref}
                          </span>
                        )}
                      </>
                    )
                  )}
                </p>
              </div>
            </li>
          )
        })}
      </ol>

      <div className="space-y-4 border-t border-border px-4 py-5 sm:px-6">
        <p className="text-sm text-muted-foreground">
          Add /tree/branch-name to a URL to scan a specific branch. No GitHub or Gemini key is needed here:
          keys are configured on the backend.
        </p>
        {error && (
          <Banner tone="error" role="alert" title={error.title} onDismiss={onDismissError}>
            {error.message}
            {error.code && <span className="mt-1 block font-mono text-xs">{error.code}</span>}
          </Banner>
        )}
        {USE_MOCK && (
          <Banner tone="info">
            Mock mode is on. Analyze repositories plays the bundled demo scan, not a scan of these repositories.
          </Banner>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            Analyze repositories
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button size="lg" onClick={onLoadDemo} disabled={busy}>
            Load demo run
          </Button>
          <span className="font-mono text-xs text-muted-foreground">Uses bundled demo data</span>
        </div>
      </div>
    </form>
  )
}
