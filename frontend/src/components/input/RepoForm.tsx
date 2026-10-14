import { ArrowDown, ArrowRight, ArrowUp, Check, ClipboardPaste, Eraser, GitBranch, Link2, Play, Plus, Trash2, X } from 'lucide-react'
import { useId, useRef, useState, type FormEvent } from 'react'
import type { UiError } from '../../api/errors'
import { MAX_PASTED_FILE_BYTES, MAX_REPOS, MIN_REPOS, USE_MOCK } from '../../config'
import { useAnnounce } from '../../hooks/useAnnouncer'
import { cx } from '../../lib/cx'
import { DEMO_HINT } from '../../lib/exportMarkdown'
import { formatDateTime } from '../../lib/formatters'
import { updateStore, useStore, type HistoryEntry } from '../../lib/localStore'
import {
  checkForm,
  contentBytes,
  detectManifest,
  EXAMPLE_MANIFESTS,
  MANIFEST_OPTIONS,
  newFile,
  newProject,
  newRow,
  type PastedProject,
  type RepoRow,
  type ScanTarget,
} from '../../lib/targets'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { ConfirmButton, IconButton, useToast } from '../common/Controls'

const FIELD = 'h-10 w-full rounded-md border border-input bg-card px-3 text-sm placeholder:text-muted-foreground/70'

/** Real public repositories, offered so the form can be tried in one click. */
const EXAMPLE_URLS = ['https://github.com/pallets/flask', 'https://github.com/fastapi/fastapi', 'https://github.com/psf/requests']

export interface FormState {
  tab: 'github' | 'paste'
  rows: RepoRow[]
  projects: PastedProject[]
}

interface RepoFormProps {
  form: FormState
  onChange: (form: FormState) => void
  onSubmit: (targets: ScanTarget[]) => void
  onLoadDemo: () => void
  busy: boolean
  /** A request the backend rejected, shown above the buttons. */
  error: UiError | null
  onDismissError: () => void
}

function move<T>(list: T[], index: number, offset: number): T[] {
  const next = [...list]
  const [item] = next.splice(index, 1)
  if (item !== undefined) next.splice(index + offset, 0, item)
  return next
}

export function RepoForm({ form, onChange, onSubmit, onLoadDemo, busy, error, onDismissError }: RepoFormProps) {
  const announce = useAnnounce()
  const toast = useToast()
  const baseId = useId()
  const urlRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const [submitted, setSubmitted] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const { history } = useStore()
  const { rows, projects, tab } = form
  const check = checkForm(rows, projects)
  const total = check.targets.length

  const setRows = (next: RepoRow[]) => onChange({ ...form, rows: next })
  const setProjects = (next: PastedProject[]) => onChange({ ...form, projects: next })
  const patchRow = (id: string, patch: Partial<RepoRow>) => setRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const patchProject = (id: string, change: (project: PastedProject) => PastedProject) =>
    setProjects(projects.map((project) => (project.id === id ? change(project) : project)))
  const canAdd = rows.length + projects.length < MAX_REPOS

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setSubmitted(true)
    if (check.blocked) {
      announce(check.blocked)
      const firstBad = rows.find((_row, index) => check.rowErrors[index] !== null)
      if (firstBad) {
        if (tab !== 'github') onChange({ ...form, tab: 'github' })
        urlRefs.current[firstBad.id]?.focus()
      } else if (Object.values(check.projectErrors).some((item) => item.name || Object.values(item.files).some(Boolean))) {
        if (tab !== 'paste') onChange({ ...form, tab: 'paste' })
      }
      return
    }
    onSubmit(check.targets)
  }

  const pasteInto = async (row: RepoRow) => {
    try {
      patchRow(row.id, { url: (await navigator.clipboard.readText()).trim() })
    } catch {
      toast('Clipboard access was blocked. Paste with Ctrl+V instead.')
    }
  }

  const runAgain = (entry: HistoryEntry) => {
    const github = entry.targets.filter((target) => target.kind === 'github' && target.url)
    onChange({
      tab: 'github',
      projects: [],
      rows: github.map((target) => ({ ...newRow(), label: target.label, url: target.url ?? '', ref: target.ref ?? '' })),
    })
    toast(
      github.length < entry.targets.length
        ? 'Repositories restored. Pasted projects are never saved, so paste them again.'
        : 'Repositories restored. Press Analyze repositories to run the scan.',
    )
  }

  const tabs = [
    { id: 'github' as const, label: 'GitHub links', icon: Link2, count: check.targets.filter((t) => t.kind === 'github').length },
    { id: 'paste' as const, label: 'Paste manifests', icon: ClipboardPaste, count: projects.length },
  ]

  return (
    <form noValidate onSubmit={submit} aria-label="Repositories to analyze" className="rounded-xl border border-border bg-card shadow-nav">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 sm:px-6">
        <div
          role="tablist"
          aria-label="How to add projects"
          className="flex"
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault()
              onChange({ ...form, tab: tab === 'github' ? 'paste' : 'github' })
            }
          }}
        >
          {tabs.map(({ id, label, icon: Icon, count }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${baseId}-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`${baseId}-panel`}
              tabIndex={tab === id ? 0 : -1}
              onClick={() => onChange({ ...form, tab: id })}
              className={cx(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-4 font-mono text-sm transition-colors',
                tab === id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              {label}
              {count > 0 && <span className="rounded-full bg-secondary px-1.5 text-xs tabular-nums">{count}</span>}
            </button>
          ))}
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {total} of {MAX_REPOS} targets, {MIN_REPOS} needed
        </p>
      </div>

      <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`} className="px-4 py-5 sm:px-6">
        {tab === 'github' ? (
          <>
            <ol className="space-y-4">
              {rows.map((row, index) => {
                const parsed = check.parsed[index]
                const message = check.rowErrors[index] ?? null
                const showError = message !== null && (submitted || touched[row.id] === true)
                const n = index + 1
                return (
                  <li key={row.id} className="grid gap-2 md:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,9rem)_auto] md:items-start">
                    <div>
                      <label htmlFor={`${row.id}-label`} className="block text-xs text-muted-foreground">
                        Label {n}, optional
                      </label>
                      <input id={`${row.id}-label`} type="text" value={row.label} onChange={(event) => patchRow(row.id, { label: event.target.value })} placeholder="Your name for it" autoComplete="off" className={cx(FIELD, 'mt-1')} />
                    </div>
                    <div>
                      <label htmlFor={`${row.id}-url`} className="block text-xs text-muted-foreground">
                        GitHub repository URL {n}
                      </label>
                      <div className="mt-1 flex items-center gap-1">
                        <input
                          ref={(element) => {
                            urlRefs.current[row.id] = element
                          }}
                          id={`${row.id}-url`}
                          type="url"
                          inputMode="url"
                          value={row.url}
                          onChange={(event) => patchRow(row.id, { url: event.target.value })}
                          onBlur={() => setTouched((previous) => ({ ...previous, [row.id]: true }))}
                          aria-invalid={showError}
                          aria-describedby={`${row.id}-hint`}
                          placeholder="https://github.com/owner/repo"
                          autoComplete="off"
                          spellCheck={false}
                          className={cx(FIELD, 'font-mono', showError && 'border-risk-critical')}
                        />
                        <IconButton label={`Paste into URL ${n}`} onClick={() => void pasteInto(row)}>
                          <ClipboardPaste aria-hidden="true" />
                        </IconButton>
                        <IconButton label={`Clear URL ${n}`} disabled={row.url === ''} disabledReason="Nothing to clear" onClick={() => patchRow(row.id, { url: '' })}>
                          <Eraser aria-hidden="true" />
                        </IconButton>
                      </div>
                      <p id={`${row.id}-hint`} className="mt-1 flex min-h-5 flex-wrap items-center gap-2 text-xs">
                        {showError ? (
                          <span className="text-risk-critical">{message}</span>
                        ) : (
                          parsed && (
                            <>
                              <span className="inline-flex items-center gap-1 text-success">
                                <Check aria-hidden="true" className="size-3.5" />
                                {parsed.owner}/{parsed.repo}
                              </span>
                              {(parsed.ref ?? row.ref.trim()) && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 font-mono text-muted-foreground">
                                  <GitBranch aria-hidden="true" className="size-3" />
                                  <span className="sr-only">Branch </span>
                                  {parsed.ref ?? row.ref.trim()}
                                </span>
                              )}
                            </>
                          )
                        )}
                      </p>
                    </div>
                    <div>
                      <label htmlFor={`${row.id}-ref`} className="block text-xs text-muted-foreground">
                        Branch or tag {n}
                      </label>
                      <input
                        id={`${row.id}-ref`}
                        type="text"
                        value={parsed?.ref ?? row.ref}
                        disabled={Boolean(parsed?.ref)}
                        title={parsed?.ref ? 'Taken from the /tree/ link in the URL' : undefined}
                        onChange={(event) => patchRow(row.id, { ref: event.target.value })}
                        placeholder="default branch"
                        autoComplete="off"
                        spellCheck={false}
                        className={cx(FIELD, 'mt-1 font-mono disabled:opacity-60')}
                      />
                    </div>
                    <div className="flex items-center gap-0.5 md:pt-5">
                      <IconButton label={`Move repository ${n} up`} disabled={index === 0} disabledReason="Already first" onClick={() => setRows(move(rows, index, -1))}>
                        <ArrowUp aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Move repository ${n} down`} disabled={index === rows.length - 1} disabledReason="Already last" onClick={() => setRows(move(rows, index, 1))}>
                        <ArrowDown aria-hidden="true" />
                      </IconButton>
                      <IconButton label={`Remove repository ${n}`} disabled={rows.length <= 1} disabledReason="Keep at least one row" onClick={() => setRows(rows.filter((item) => item.id !== row.id))}>
                        <X aria-hidden="true" />
                      </IconButton>
                    </div>
                  </li>
                )
              })}
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={!canAdd} title={canAdd ? undefined : `A scan takes at most ${MAX_REPOS} targets`} onClick={() => setRows([...rows, newRow()])}>
                <Plus aria-hidden="true" />
                Add repository
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const base = rows.length >= EXAMPLE_URLS.length ? rows : [...rows, ...EXAMPLE_URLS.slice(rows.length).map(() => newRow())]
                  setRows(base.map((row, index) => (EXAMPLE_URLS[index] ? { ...row, url: EXAMPLE_URLS[index], ref: '' } : row)))
                  setSubmitted(false)
                }}
              >
                Fill example repositories
              </Button>
              <ConfirmButton
                size="sm"
                variant="ghost"
                disabled={rows.every((row) => row.url === '') && projects.length === 0}
                confirmLabel={`Clear ${rows.filter((row) => row.url !== '').length} links and ${projects.length} pasted projects`}
                onConfirm={() => {
                  onChange({ ...form, rows: [0, 1, 2].map(() => newRow()), projects: [] })
                  setSubmitted(false)
                  setTouched({})
                }}
              >
                <Trash2 aria-hidden="true" />
                Clear all
              </ConfirmButton>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Compare {MIN_REPOS} to {MAX_REPOS} repositories. Add /tree/branch-name to a URL, or fill Branch or tag, to
              scan a specific branch. Only pushed code is read.
            </p>
          </>
        ) : (
          <PasteTab projects={projects} errors={check.projectErrors} submitted={submitted} canAdd={canAdd} onChange={setProjects} onPatch={patchProject} />
        )}
      </div>

      <div className="space-y-4 border-t border-border px-4 py-5 sm:px-6">
        {error && (
          <Banner tone="error" role="alert" title={error.title} onDismiss={onDismissError}>
            {error.message}
            {error.code && <span className="mt-1 block font-mono text-xs">{error.code}</span>}
          </Banner>
        )}
        {USE_MOCK && <Banner tone="info">Mock mode is on. Analyze repositories plays the sample built into the app, not a scan of these targets.</Banner>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <Button type="submit" variant="primary" size="lg" disabled={busy} aria-describedby={`${baseId}-blocked`}>
            Analyze repositories
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button size="lg" onClick={onLoadDemo} disabled={busy}>
            Load demo run
          </Button>
          <span className="font-mono text-xs text-muted-foreground">{DEMO_HINT}</span>
        </div>
        <p id={`${baseId}-blocked`} className={cx('min-h-5 text-sm', submitted && check.blocked ? 'text-risk-critical' : 'text-muted-foreground')}>
          {check.blocked ?? 'No GitHub or Gemini key is needed here: keys are configured on the backend.'}
        </p>
      </div>

      {history.length > 0 && (
        <section aria-label="Recent scans" className="border-t border-border px-4 py-5 sm:px-6">
          <h3 className="font-mono text-xs uppercase text-muted-foreground">Recent scans, saved in this browser</h3>
          <ul className="mt-3 divide-y divide-border">
            {history.slice(0, 5).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{entry.targets.map((target) => target.label).join(', ')}</span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(entry.at)}, {entry.drifted} drifted{entry.source === 'demo' ? ', demo data' : ''}
                </span>
                <Button size="sm" variant="ghost" disabled={entry.source === 'demo'} title={entry.source === 'demo' ? 'Use Load demo run for demo data' : undefined} onClick={() => runAgain(entry)}>
                  <Play aria-hidden="true" />
                  Run again
                </Button>
                <IconButton
                  label="Remove this scan from history"
                  onClick={() => {
                    updateStore((store) => ({ ...store, history: store.history.filter((item) => item.id !== entry.id) }))
                    toast('Scan removed from history', () => updateStore((store) => ({ ...store, history: [entry, ...store.history] })))
                  }}
                >
                  <X aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        </section>
      )}
    </form>
  )
}

interface PasteTabProps {
  projects: PastedProject[]
  errors: ReturnType<typeof checkForm>['projectErrors']
  submitted: boolean
  canAdd: boolean
  onChange: (projects: PastedProject[]) => void
  onPatch: (id: string, change: (project: PastedProject) => PastedProject) => void
}

function PasteTab({ projects, errors, submitted, canAdd, onChange, onPatch }: PasteTabProps) {
  return (
    <div>
      <Banner tone="info">
        For private projects. Nothing is fetched from GitHub, so there is no code scan, and resolved versions exist
        only if you paste a lockfile. Pasted content is sent to the scan request only. It is never stored.
      </Banner>
      <ul aria-label="Pasted projects" className="mt-4 space-y-4">
        {projects.map((project, index) => {
          const problems = errors[project.id]
          const title = project.name.trim() || `Project ${index + 1}`
          const nameError = problems?.name && (submitted || project.name.trim() !== '') ? problems.name : null
          return (
            <li key={project.id} className="rounded-lg border border-border bg-background p-4">
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <label htmlFor={`${project.id}-name`} className="block text-xs text-muted-foreground">
                    Project name {index + 1}
                  </label>
                  <input id={`${project.id}-name`} type="text" value={project.name} onChange={(event) => onPatch(project.id, (p) => ({ ...p, name: event.target.value }))} aria-invalid={nameError !== null} placeholder="billing-service" autoComplete="off" spellCheck={false} className={cx(FIELD, 'mt-1', nameError && 'border-risk-critical')} />
                </div>
                <Button size="sm" variant="ghost" onClick={() => onChange(projects.filter((item) => item.id !== project.id))} aria-label={`Remove project ${title}`}>
                  <Trash2 aria-hidden="true" />
                  Remove project
                </Button>
              </div>
              <p className="mt-1 min-h-4 text-xs text-risk-critical">{nameError}</p>

              <div className="mt-2 space-y-3">
                {project.files.map((file, fileIndex) => {
                  const fileProblem = problems?.files[file.id] ?? null
                  const setFile = (patch: Partial<typeof file>) =>
                    onPatch(project.id, (p) => ({ ...p, files: p.files.map((item) => (item.id === file.id ? { ...item, ...patch } : item)) }))
                  return (
                    <div key={file.id} className="rounded-md border border-border bg-card p-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <div>
                          <label htmlFor={`${file.id}-type`} className="block text-xs text-muted-foreground">
                            File type
                          </label>
                          <select
                            id={`${file.id}-type`}
                            value={file.filename ?? ''}
                            onChange={(event) => {
                              const filename = MANIFEST_OPTIONS.find((option) => option === event.target.value)
                              if (filename) setFile({ filename, manual: true })
                            }}
                            className={cx(FIELD, 'mt-1 w-auto font-mono')}
                          >
                            <option value="" disabled>
                              Choose a type
                            </option>
                            {MANIFEST_OPTIONS.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                          </select>
                        </div>
                        <span className="pb-2 text-xs text-muted-foreground">{file.filename && !file.manual && file.content.trim() ? 'Detected from content' : ''}</span>
                        <div className="ml-auto flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const filename = file.manual && file.filename && EXAMPLE_MANIFESTS[file.filename] ? file.filename : 'package.json'
                              setFile({ content: EXAMPLE_MANIFESTS[filename] ?? '', filename })
                            }}
                          >
                            Insert example
                          </Button>
                          <IconButton label={`Remove file ${fileIndex + 1} of ${title}`} disabled={project.files.length <= 1} disabledReason="A project needs at least one file" onClick={() => onPatch(project.id, (p) => ({ ...p, files: p.files.filter((item) => item.id !== file.id) }))}>
                            <X aria-hidden="true" />
                          </IconButton>
                        </div>
                      </div>
                      <label htmlFor={`${file.id}-content`} className="mt-3 block text-xs text-muted-foreground">
                        Manifest content, file {fileIndex + 1} of {title}
                      </label>
                      <textarea
                        id={`${file.id}-content`}
                        rows={6}
                        value={file.content}
                        onChange={(event) => setFile({ content: event.target.value, filename: file.manual ? file.filename : detectManifest(event.target.value) })}
                        aria-invalid={fileProblem !== null}
                        placeholder="Paste the contents of package.json, requirements.txt, pyproject.toml, pom.xml or a lockfile"
                        spellCheck={false}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        className={cx(FIELD, 'mt-1 block h-auto resize-y py-2 font-mono text-xs leading-relaxed', fileProblem && 'border-risk-critical')}
                      />
                      <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs">
                        <p role={fileProblem ? 'alert' : undefined} className="text-risk-critical">
                          {fileProblem}
                        </p>
                        <p className="tabular-nums text-muted-foreground">
                          {(contentBytes(file.content) / 1024).toFixed(1)} KB of {MAX_PASTED_FILE_BYTES / 1024} KB
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
              <Button size="sm" className="mt-3" onClick={() => onPatch(project.id, (p) => ({ ...p, files: [...p.files, newFile()] }))}>
                <Plus aria-hidden="true" />
                Add file
              </Button>
            </li>
          )
        })}
      </ul>
      <Button className="mt-4" disabled={!canAdd} title={canAdd ? undefined : `A scan takes at most ${MAX_REPOS} targets`} onClick={() => onChange([...projects, newProject()])}>
        <Plus aria-hidden="true" />
        Add project
      </Button>
    </div>
  )
}
