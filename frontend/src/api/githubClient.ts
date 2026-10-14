import { API_BASE_URL } from '../config'
import { ApiFailure, extractServerError } from './errors'

/**
 * Client for the signed-in user's repositories: GET /api/v1/github/repositories
 * (docs/API_CONTRACT.md, "Repository access"). The backend holds every GitHub
 * token; this code only ever sees names, visibility and links to GitHub's own
 * settings pages.
 */

export const LISTING_TIMEOUT_MS = 30_000

export interface GitHubInstallation {
  id: number
  account: { login: string; type: string; avatarUrl: string | null }
  /** "all" or "selected": which of the account's repositories the App may read. */
  repositorySelection: string
  suspended: boolean
  /** Permissions a scan needs that this installation was not granted, for example "contents". */
  missingPermissions: string[]
  /** GitHub's settings page for this installation, or null when none could be built. */
  manageUrl: string | null
  repositoryCount: number | null
}

export interface GitHubRepository {
  id: number
  name: string
  owner: string
  fullName: string
  private: boolean
  language: string | null
  defaultBranch: string
  updatedAt: string | null
  htmlUrl: string | null
  archived: boolean
  installationId: number
}

export interface RepositoryListing {
  installations: GitHubInstallation[]
  repositories: GitHubRepository[]
  /** False when GitHub reported more repositories than were listed. */
  complete: boolean
  fetchedAt: string | null
}

type Rec = Record<string, unknown>
const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
/** Only GitHub's own pages and avatars are ever linked or shown. */
const github = (value: unknown, prefix: string): string | null => (str(value).startsWith(prefix) ? str(value) : null)

export function parseListing(body: unknown): RepositoryListing {
  if (!isRecord(body) || !Array.isArray(body.repositories) || !Array.isArray(body.installations)) throw new ApiFailure('shape')
  const installations = body.installations.filter(isRecord).map((item) => {
    const account = isRecord(item.account) ? item.account : {}
    return {
      id: num(item.id) ?? 0,
      account: { login: str(account.login), type: str(account.type), avatarUrl: github(account.avatar_url, 'https://avatars.githubusercontent.com/') },
      repositorySelection: str(item.repository_selection),
      suspended: item.suspended === true,
      missingPermissions: Array.isArray(item.missing_permissions) ? item.missing_permissions.filter((p): p is string => typeof p === 'string') : [],
      manageUrl: github(item.manage_url, 'https://github.com/'),
      repositoryCount: num(item.repository_count),
    }
  })
  const repositories = body.repositories
    .filter(isRecord)
    .map((item) => ({
      id: num(item.id) ?? 0,
      name: str(item.name),
      owner: str(item.owner),
      fullName: str(item.full_name),
      private: item.private === true,
      language: str(item.language) || null,
      defaultBranch: str(item.default_branch),
      updatedAt: str(item.updated_at) || null,
      htmlUrl: github(item.html_url, 'https://github.com/'),
      archived: item.archived === true,
      installationId: num(item.installation_id) ?? 0,
    }))
    // A row this dashboard cannot turn into a scan target is not offered.
    .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo.fullName))
  return { installations, repositories, complete: body.complete !== false, fetchedAt: str(body.fetched_at) || null }
}

export interface ListingOptions {
  refresh?: boolean
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export async function fetchRepositories(options: ListingOptions = {}): Promise<RepositoryListing> {
  const { refresh = false, signal, fetchImpl = fetch, baseUrl = API_BASE_URL } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, LISTING_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let response: Response
    let text: string
    try {
      response = await fetchImpl(`${baseUrl}/api/v1/github/repositories${refresh ? '?refresh=true' : ''}`, { credentials: 'include', signal: controller.signal })
      text = await response.text()
    } catch {
      throw new ApiFailure(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network')
    }
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      if (response.ok) throw new ApiFailure('shape')
    }
    if (!response.ok) throw new ApiFailure('http', { status: response.status, ...extractServerError(body) })
    return parseListing(body)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** The backend route that sends a signed-in user to GitHub to install the App or change its repositories. */
export function installUrl(origin: string): string {
  return `${API_BASE_URL}/api/v1/auth/github/install?return_to=${encodeURIComponent(origin)}`
}

export interface ListingProblem {
  kind: 'sign-in' | 'expired' | 'not-configured' | 'rate-limited' | 'unavailable' | 'other'
  title: string
  message: string
}

/** What to show when the list could not be loaded. It is never shown as an empty list. */
export function listingProblem(error: unknown): ListingProblem {
  if (!(error instanceof ApiFailure)) return { kind: 'other', title: 'Repositories could not be loaded', message: 'Try again.' }
  const message = error.serverMessage
  if (error.reason === 'network') return { kind: 'unavailable', title: 'Backend unreachable', message: 'DriftLock could not reach its backend. Check that it is running, then try again.' }
  if (error.reason === 'timeout') return { kind: 'unavailable', title: 'GitHub took too long', message: 'The repository list did not arrive in time. Try again.' }
  if (error.reason === 'shape') return { kind: 'other', title: 'Unreadable answer', message: 'The backend sent a repository list this page could not read.' }
  switch (error.errorCode) {
    case 'SIGN_IN_REQUIRED':
      return { kind: 'sign-in', title: 'Sign in to see your repositories', message: message || 'Sign in with GitHub first.' }
    case 'SESSION_EXPIRED':
      return { kind: 'expired', title: 'Your session has ended', message: message || 'Sign in with GitHub again.' }
    case 'GITHUB_APP_NOT_CONFIGURED':
    case 'GITHUB_APP_MISCONFIGURED':
      return { kind: 'not-configured', title: 'Repository access is not set up', message: message || 'This backend has no GitHub App configured.' }
    case 'GITHUB_RATE_LIMITED':
      return { kind: 'rate-limited', title: "GitHub's rate limit was reached", message: message || 'Wait a few minutes, then refresh.' }
    case 'GITHUB_UNAVAILABLE':
      return { kind: 'unavailable', title: 'GitHub could not be reached', message: message || 'Try again in a moment.' }
  }
  if (error.status === 404) return { kind: 'not-configured', title: 'Repository access is not available', message: 'This backend does not serve the repository list. Update and restart it.' }
  return { kind: 'other', title: 'Repositories could not be loaded', message: message || `The backend returned an error (HTTP ${error.status ?? 'unknown'}).` }
}
