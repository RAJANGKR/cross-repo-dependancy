import { ArrowLeft, ExternalLink, GitBranch, LoaderCircle, Lock, LogIn, Play, Plus, RotateCcw, Search, Unlock, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { isCancelled, type UiError } from '../../api/errors'
import {
  fetchRepositories,
  installUrl,
  listingProblem,
  type GitHubRepository,
  type ListingProblem,
  type RepositoryListing,
} from '../../api/githubClient'
import { MAX_REPOS, MIN_REPOS } from '../../config'
import { SETUP_NOTICES, useAuth } from '../../hooks/useAuth'
import { cx } from '../../lib/cx'
import { formatDateTime, plural } from '../../lib/formatters'
import type { ScanTarget } from '../../lib/targets'
import { AuthButton } from '../common/AuthButton'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { Wordmark } from '../common/Tags'

export type VisibilityFilter = 'all' | 'public' | 'private'

/** A picked repository as a scan target on its default branch. A ref can be set in the scan form. */
export function targetOf(repo: GitHubRepository): ScanTarget {
  return { kind: 'github', label: repo.name, name: repo.name, url: `https://github.com/${repo.fullName}`, ref: null, files: [] }
}

export function visibleRepositories(repos: readonly GitHubRepository[], query: string, filter: VisibilityFilter): GitHubRepository[] {
  const needle = query.trim().toLowerCase()
  return repos.filter((repo) => (filter === 'all' || (filter === 'private') === repo.private) && (!needle || repo.fullName.toLowerCase().includes(needle)))
}

interface RepositoryPickerProps {
  onBack: () => void
  /** Puts the picked repositories into the scan form, where refs can be set and other targets added. */
  onAddToForm: (targets: ScanTarget[]) => void
  /** Starts a scan of the picked repositories on their default branches. */
  onScan: (targets: ScanTarget[]) => void
  /** The query string, for the result of GitHub's installation flow (`github_setup`). */
  search: string
  /** Why the last scan from here was refused, for example a repository whose access was withdrawn. */
  error?: UiError | null
  onDismissError?: () => void
  load?: typeof fetchRepositories
}

/**
 * The signed-in user's repositories, through DriftLock's GitHub App: search,
 * public and private filters, and a selection that goes to the scan form or
 * straight into a scan. Nothing here decides access: the backend checks it
 * again for every repository when the scan starts.
 */
export function RepositoryPicker({ onBack, onAddToForm, onScan, search, error = null, onDismissError, load = fetchRepositories }: RepositoryPickerProps) {
  const auth = useAuth()
  const [listing, setListing] = useState<RepositoryListing | null>(null)
  const [problem, setProblem] = useState<ListingProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<VisibilityFilter>('all')
  const [picked, setPicked] = useState<number[]>([])
  const controller = useRef<AbortController | null>(null)
  const searchId = useId()
  const setup = new URLSearchParams(search).get('github_setup') ?? ''
  const notice = SETUP_NOTICES[setup]
  const signedIn = auth.status === 'ready' && auth.user !== null && auth.repositoryAccess

  const refresh = useCallback(
    async (force: boolean) => {
      controller.current?.abort()
      const current = new AbortController()
      controller.current = current
      setBusy(true)
      setProblem(null)
      try {
        const answer = await load({ refresh: force, signal: current.signal })
        if (controller.current !== current) return
        setListing(answer)
        // A repository that is no longer granted cannot stay picked.
        setPicked((ids) => ids.filter((id) => answer.repositories.some((repo) => repo.id === id)))
      } catch (failure) {
        if (controller.current !== current || isCancelled(failure)) return
        setListing(null)
        setProblem(listingProblem(failure))
      } finally {
        if (controller.current === current) setBusy(false)
      }
    },
    [load],
  )

  // Back from GitHub's installation page, the list is read again rather than taken from the backend's short cache.
  useEffect(() => {
    if (signedIn) void refresh(Boolean(setup))
    return () => controller.current?.abort()
  }, [signedIn, refresh, setup])

  const repos = useMemo(() => listing?.repositories ?? [], [listing])
  const shown = useMemo(() => visibleRepositories(repos, query, filter), [repos, query, filter])
  const chosen = repos.filter((repo) => picked.includes(repo.id))
  const counts = { all: repos.length, public: repos.filter((repo) => !repo.private).length, private: repos.filter((repo) => repo.private).length }
  const full = picked.length >= MAX_REPOS
  const toggle = (id: number) => setPicked((ids) => (ids.includes(id) ? ids.filter((other) => other !== id) : ids.length >= MAX_REPOS ? ids : [...ids, id]))
  const connect = installUrl(window.location.origin)

  return (
    <div className="guide-lines relative min-h-screen overflow-x-clip">
      <header className="relative z-30 mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <nav aria-label="Primary" className="flex h-16 items-center justify-between gap-6 rounded-xl border border-border bg-card/90 px-5 shadow-nav backdrop-blur sm:px-6">
          <Wordmark />
          <div className="flex min-w-0 items-center gap-3 text-sm sm:gap-8">
            <button type="button" onClick={onBack} aria-label="Dependency scan" className="inline-flex items-center gap-1.5 text-foreground/70 transition-colors hover:text-foreground">
              <ArrowLeft aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">Dependency scan</span>
            </button>
            <span aria-current="page" className="hidden font-medium sm:inline">Your repositories</span>
            <AuthButton />
          </div>
        </nav>
      </header>

      <main className="relative mx-auto max-w-[1400px] px-4 pb-24 pt-12 sm:px-6 lg:px-8">
        <p className="eyebrow">Your repositories</p>
        <h1 className="mt-4 font-display text-[clamp(2.25rem,5vw,4rem)] leading-[0.95] tracking-tight">Choose repositories to scan</h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-muted-foreground">
          Public and private repositories that you granted to DriftLock&apos;s GitHub App. Pick two or more, then scan them on their
          default branches, or add them to the scan form to set a branch, tag or commit and mix them with other targets.
        </p>
        {notice && (
          <Banner tone={notice.tone} role="status" className="mt-6 max-w-5xl">
            {notice.text}
          </Banner>
        )}
        {error && (
          <Banner tone="error" role="alert" title={error.title} className="mt-6 max-w-5xl" onDismiss={onDismissError}>
            {error.message}
          </Banner>
        )}

        <div className="mt-8 max-w-5xl" aria-live="polite">
          {auth.status === 'loading' && <Waiting text="Checking whether you are signed in" />}
          {auth.status === 'unavailable' && (
            <Panel title="Backend unreachable" text="DriftLock could not reach its backend, so your repositories cannot be listed. Check that it is running.">
              <Button size="md" onClick={() => void auth.refresh()}>
                <RotateCcw aria-hidden="true" />
                Try again
              </Button>
            </Panel>
          )}
          {auth.status === 'ready' && !auth.repositoryAccess && (
            <Panel
              title="Repository access is not set up"
              text="This DriftLock backend has no GitHub App configured, so it cannot list or read private repositories. Public repositories can still be scanned by URL from the start page. See docs/GITHUB_APP_SETUP.md to set the App up."
            />
          )}
          {auth.status === 'ready' && auth.repositoryAccess && !auth.user && <SignInPanel onSignIn={auth.signIn} />}

          {signedIn && busy && !listing && <Waiting text="Loading your repositories from GitHub" />}
          {signedIn && problem && (
            <Panel title={problem.title} text={problem.message} alert>
              {problem.kind === 'sign-in' || problem.kind === 'expired' ? (
                <Button variant="primary" onClick={auth.signIn}>
                  <LogIn aria-hidden="true" />
                  Sign in with GitHub
                </Button>
              ) : problem.kind !== 'not-configured' ? (
                <Button onClick={() => void refresh(true)}>
                  <RotateCcw aria-hidden="true" />
                  Try again
                </Button>
              ) : null}
            </Panel>
          )}

          {signedIn && listing && listing.installations.length === 0 && (
            <Panel
              title="Connect GitHub repositories"
              text="You are signed in, but DriftLock's GitHub App is not installed on any account you can use. Install it on your account or on an organization, and choose all repositories or only the ones DriftLock may read. It asks for read access to code and metadata, nothing more. In an organization where you are not an owner, GitHub sends the request to an owner to approve."
            >
              <a href={connect} className="inline-flex h-10 items-center gap-2 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-foreground/90">
                <Plus aria-hidden="true" className="size-4" />
                Connect GitHub repositories
              </a>
              <Button onClick={() => void refresh(true)} disabled={busy}>
                <RotateCcw aria-hidden="true" />
                I installed it, check again
              </Button>
            </Panel>
          )}

          {signedIn && listing && listing.installations.length > 0 && (
            <section aria-label="Repository list" className="rounded-xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <label htmlFor={searchId} className="relative min-w-0 flex-1 basis-56">
                  <span className="sr-only">Search repositories by name</span>
                  <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    id={searchId}
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search by name"
                    className="h-9 w-full rounded-full border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:border-foreground"
                  />
                </label>
                <div role="radiogroup" aria-label="Visibility" className="flex rounded-full border border-border p-0.5">
                  {(['all', 'public', 'private'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={filter === value}
                      onClick={() => setFilter(value)}
                      className={cx('rounded-full px-3 py-1 text-xs capitalize transition-colors', filter === value ? 'bg-foreground text-background' : 'text-foreground/70 hover:text-foreground')}
                    >
                      {value} ({counts[value]})
                    </button>
                  ))}
                </div>
                <Button size="sm" variant="ghost" onClick={() => void refresh(true)} disabled={busy} aria-busy={busy}>
                  <RotateCcw aria-hidden="true" className={cx(busy && 'animate-spin')} />
                  Refresh
                </Button>
                <a href={connect} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground">
                  <ExternalLink aria-hidden="true" className="size-4" />
                  Manage repository access
                </a>
              </div>

              <Access listing={listing} />

              {shown.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">
                  {repos.length === 0 ? 'No repository is granted to DriftLock yet. Add some under Manage repository access.' : 'No repository matches this search and filter.'}
                </p>
              ) : (
                <ul aria-label="Repositories" className="divide-y divide-border">
                  {shown.map((repo) => {
                    const checked = picked.includes(repo.id)
                    return (
                      <li key={repo.id}>
                        <label className={cx('flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-foreground/[0.03]', !checked && full && 'cursor-not-allowed opacity-60')}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && full}
                            onChange={() => toggle(repo.id)}
                            aria-label={`Select ${repo.fullName}`}
                            className="size-4 accent-foreground"
                          />
                          <span className="min-w-0 flex-1 basis-60">
                            <span className="block truncate font-medium">{repo.name}</span>
                            <span className="block truncate font-mono text-xs text-muted-foreground">{repo.owner}</span>
                          </span>
                          <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', repo.private ? 'bg-warning-tint text-warning' : 'bg-secondary text-foreground/80')}>
                            {repo.private ? <Lock aria-hidden="true" className="size-3" /> : <Unlock aria-hidden="true" className="size-3" />}
                            {repo.private ? 'Private' : 'Public'}
                          </span>
                          <span className="w-24 truncate text-xs text-muted-foreground">{repo.language ?? 'Language not reported'}</span>
                          <span className="inline-flex w-32 items-center gap-1 truncate font-mono text-xs text-muted-foreground">
                            <GitBranch aria-hidden="true" className="size-3 shrink-0" />
                            {repo.defaultBranch || 'unknown'}
                          </span>
                          <span className="w-40 text-xs text-muted-foreground">{repo.updatedAt ? `Updated ${formatDateTime(repo.updatedAt)}` : 'Last update not reported'}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}

              <div className="sticky bottom-0 flex flex-wrap items-center gap-3 rounded-b-xl border-t border-border bg-card/95 py-3 pl-4 pr-16 backdrop-blur lg:pr-4">
                <p role="status" className="text-sm">
                  {plural(picked.length, 'repository', 'repositories')} selected
                  {full && <span className="text-muted-foreground"> (a scan takes at most {MAX_REPOS})</span>}
                </p>
                <Button size="sm" variant="ghost" onClick={() => setPicked([])} disabled={picked.length === 0}>
                  <X aria-hidden="true" />
                  Clear selection
                </Button>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onAddToForm(chosen.map(targetOf))} disabled={picked.length === 0}>
                    <Plus aria-hidden="true" />
                    Add to scan form
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => onScan(chosen.map(targetOf))}
                    disabled={picked.length < MIN_REPOS}
                    title={picked.length < MIN_REPOS ? `Select at least ${MIN_REPOS}, or add them to the scan form and combine them with other targets` : undefined}
                  >
                    <Play aria-hidden="true" />
                    Scan {picked.length >= MIN_REPOS ? plural(picked.length, 'repository', 'repositories') : 'selected'}
                  </Button>
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

/** Through which accounts access was granted, what is missing, and why a private repository may not be listed. */
function Access({ listing }: { listing: RepositoryListing }) {
  return (
    <div className="space-y-2 border-b border-border px-4 py-3 text-sm">
      <ul aria-label="Repository access" className="flex flex-wrap gap-x-6 gap-y-2">
        {listing.installations.map((installation) => (
          <li key={installation.id} className="flex flex-wrap items-center gap-2">
            {installation.account.avatarUrl && <img src={installation.account.avatarUrl} alt="" width={20} height={20} className="size-5 rounded-full" referrerPolicy="no-referrer" />}
            <span className="font-medium">{installation.account.login}</span>
            <span className="text-xs text-muted-foreground">
              {installation.account.type === 'Organization' ? 'organization' : 'personal account'},{' '}
              {installation.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'}
              {installation.suspended && ', suspended'}
            </span>
            {installation.manageUrl && (
              <a href={installation.manageUrl} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-4">
                Manage on GitHub
              </a>
            )}
            {installation.missingPermissions.length > 0 && (
              <span role="alert" className="basis-full text-xs text-risk-critical">
                Missing permission: {installation.missingPermissions.join(', ')} (read). Its repositories cannot be scanned until it is granted.
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        A private repository is listed only when it was granted to DriftLock&apos;s GitHub App. Missing one? Add it under Manage repository access.
        {!listing.complete && ' GitHub reported more repositories than DriftLock lists, so some are not shown.'}
        {listing.fetchedAt && ` Read from GitHub ${formatDateTime(listing.fetchedAt)}.`}
      </p>
    </div>
  )
}

function SignInPanel({ onSignIn }: { onSignIn: () => void }) {
  return (
    <Panel
      title="Sign in to see your repositories"
      text="DriftLock reads manifests, lockfiles, OpenAPI files and source code to compare your services. Private repositories need your permission: after signing in you install DriftLock's GitHub App and choose which repositories it may read, all of them or only a few. Access is read-only and can be removed on GitHub at any time."
    >
      <Button variant="primary" onClick={onSignIn}>
        <LogIn aria-hidden="true" />
        Sign in with GitHub
      </Button>
    </Panel>
  )
}

function Panel({ title, text, alert = false, children }: { title: string; text: string; alert?: boolean; children?: ReactNode }) {
  return (
    <section role={alert ? 'alert' : undefined} className="rounded-xl border border-border bg-card p-6">
      <h2 className="font-display text-2xl tracking-tight">{title}</h2>
      <p className="mt-3 max-w-3xl leading-relaxed text-muted-foreground">{text}</p>
      {children && <div className="mt-5 flex flex-wrap gap-3">{children}</div>}
    </section>
  )
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-muted-foreground">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      {text}
    </p>
  )
}
