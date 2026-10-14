// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ApiFailure, toUiError } from '../../api/errors'
import { installUrl, parseListing, type GitHubRepository, type RepositoryListing } from '../../api/githubClient'
import { AuthProvider } from '../../hooks/useAuth'
import { ToastProvider } from '../common/Controls'
import { RepositoryPicker, targetOf, visibleRepositories } from './RepositoryPicker'

const ME = { configured: true, required: false, user: { login: 'alice', name: 'Alice', avatar_url: 'https://avatars.githubusercontent.com/u/1' }, repository_access: { configured: true } }

function repo(id: number, fullName: string, isPrivate: boolean, extra: Partial<GitHubRepository> = {}): GitHubRepository {
  const [owner = '', name = ''] = fullName.split('/')
  return { id, name, owner, fullName, private: isPrivate, language: 'Python', defaultBranch: 'main', updatedAt: '2026-10-01T10:00:00Z', htmlUrl: `https://github.com/${fullName}`, archived: false, installationId: 101, ...extra }
}

const LISTING: RepositoryListing = {
  installations: [
    { id: 101, account: { login: 'alice', type: 'User', avatarUrl: null }, repositorySelection: 'selected', suspended: false, missingPermissions: [], manageUrl: 'https://github.com/settings/installations/101', repositoryCount: 3 },
    { id: 202, account: { login: 'acme-org', type: 'Organization', avatarUrl: null }, repositorySelection: 'all', suspended: false, missingPermissions: ['contents'], manageUrl: 'https://github.com/organizations/acme-org/settings/installations/202', repositoryCount: 1 },
  ],
  repositories: [
    repo(1, 'alice/ledger', true),
    repo(2, 'alice/notes', true, { language: null, defaultBranch: 'develop' }),
    repo(3, 'alice/site', false, { language: 'TypeScript' }),
    repo(4, 'acme-org/gateway', false, { installationId: 202, updatedAt: null }),
  ],
  complete: true,
  fetchedAt: '2026-10-14T09:00:00Z',
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }) })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function show(me: unknown, load = vi.fn(async () => LISTING), props: Partial<Parameters<typeof RepositoryPicker>[0]> = {}) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
    String(input).endsWith('/auth/me') ? Promise.resolve(new Response(JSON.stringify(me), { status: 200 })) : Promise.reject(new TypeError('no network in tests')))
  const onAddToForm = vi.fn()
  const onScan = vi.fn()
  render(
    <ToastProvider>
      <AuthProvider>
        <RepositoryPicker onBack={() => undefined} onAddToForm={onAddToForm} onScan={onScan} search="" load={load} {...props} />
      </AuthProvider>
    </ToastProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  return { load, onAddToForm, onScan }
}

const rows = () => within(screen.getByRole('list', { name: 'Repositories' })).getAllByRole('listitem')
const names = () => rows().map((row) => row.querySelector('span span')?.textContent)
const check = (fullName: string) => fireEvent.click(screen.getByRole('checkbox', { name: `Select ${fullName}` }))

describe('repository picker', () => {
  it('asks a signed-out visitor to sign in, says why, and reads nothing', async () => {
    const { load } = await show({ ...ME, user: null })
    expect(await screen.findByRole('heading', { name: 'Sign in to see your repositories' })).toBeTruthy()
    expect(screen.getByText(/choose which repositories it may read, all of them or only a few/)).toBeTruthy()
    expect(screen.getByText(/Access is read-only and can be removed on GitHub at any time/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Sign in with GitHub' }).length).toBeGreaterThan(0)
    expect(load).not.toHaveBeenCalled()
  })

  it('says plainly when the backend has no GitHub App', async () => {
    const { load } = await show({ ...ME, repository_access: { configured: false } })
    expect(await screen.findByRole('heading', { name: 'Repository access is not set up' })).toBeTruthy()
    expect(screen.getByText(/Public repositories can still be scanned by URL/)).toBeTruthy()
    expect(load).not.toHaveBeenCalled()
  })

  it('lists every granted repository with owner, visibility, language, default branch and last update', async () => {
    const { load } = await show(ME)
    expect(await screen.findByRole('list', { name: 'Repositories' })).toBeTruthy()
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ refresh: false }))
    expect(names()).toEqual(['ledger', 'notes', 'site', 'gateway'])
    const ledger = within(rows()[0] as HTMLElement)
    expect(ledger.getByText('alice')).toBeTruthy()
    expect(ledger.getByText('Private')).toBeTruthy()
    expect(ledger.getByText('Python')).toBeTruthy()
    expect(ledger.getByText('main')).toBeTruthy()
    expect(ledger.getByText(/^Updated /)).toBeTruthy()
    expect(within(rows()[1] as HTMLElement).getByText('Language not reported')).toBeTruthy()
    expect(within(rows()[1] as HTMLElement).getByText('develop')).toBeTruthy()
    expect(within(rows()[3] as HTMLElement).getByText('Last update not reported')).toBeTruthy()
    expect(within(rows()[2] as HTMLElement).getByText('Public')).toBeTruthy()
    // Through which accounts access was granted, and what is missing.
    const access = screen.getByRole('list', { name: 'Repository access' })
    expect(within(access).getByText('acme-org')).toBeTruthy()
    expect(within(access).getByRole('alert').textContent).toContain('Missing permission: contents (read)')
    expect(within(access).getAllByRole('link', { name: 'Manage on GitHub' }).map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/settings/installations/101', 'https://github.com/organizations/acme-org/settings/installations/202'])
    expect(screen.getByText(/A private repository is listed only when it was granted to DriftLock's GitHub App/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Manage repository access' }).getAttribute('href')).toBe(installUrl(window.location.origin))
  })

  it('searches by name and filters public and private', async () => {
    await show(ME)
    await screen.findByRole('list', { name: 'Repositories' })
    const filters = screen.getByRole('radiogroup', { name: 'Visibility' })
    expect(within(filters).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['all (4)', 'public (2)', 'private (2)'])
    fireEvent.click(within(filters).getByRole('radio', { name: 'private (2)' }))
    expect(names()).toEqual(['ledger', 'notes'])
    fireEvent.click(within(filters).getByRole('radio', { name: 'public (2)' }))
    expect(names()).toEqual(['site', 'gateway'])
    fireEvent.click(within(filters).getByRole('radio', { name: 'all (4)' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search repositories by name' }), { target: { value: 'ACME' } })
    expect(names()).toEqual(['gateway'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search repositories by name' }), { target: { value: 'nothing-like-it' } })
    expect(screen.getByText('No repository matches this search and filter.')).toBeTruthy()
  })

  it('selects several, clears, and hands the selection to the scan form or to a scan', async () => {
    const { onAddToForm, onScan } = await show(ME)
    await screen.findByRole('list', { name: 'Repositories' })
    const scanButton = () => screen.getByRole('button', { name: /^Scan / }) as HTMLButtonElement
    expect(screen.getByText('0 repositories selected')).toBeTruthy()
    check('alice/ledger')
    expect(scanButton().disabled).toBe(true)                                         // a scan needs two targets
    expect(scanButton().title).toContain('Select at least 2')
    fireEvent.click(screen.getByRole('button', { name: /Add to scan form/ }))
    expect(onAddToForm).toHaveBeenCalledWith([{ kind: 'github', label: 'ledger', name: 'ledger', url: 'https://github.com/alice/ledger', ref: null, files: [] }])
    check('alice/site')
    expect(screen.getByText('2 repositories selected')).toBeTruthy()
    fireEvent.click(scanButton())
    expect(onScan.mock.calls[0]?.[0].map((target: { url: string }) => target.url)).toEqual(['https://github.com/alice/ledger', 'https://github.com/alice/site'])
    fireEvent.click(screen.getByRole('button', { name: /Clear selection/ }))
    expect(screen.getByText('0 repositories selected')).toBeTruthy()
  })

  it('stops at the most targets a scan can take', async () => {
    const many = { ...LISTING, repositories: Array.from({ length: 12 }, (_, index) => repo(index + 1, `alice/svc-${String(index).padStart(2, '0')}`, index % 2 === 0)) }
    await show(ME, vi.fn(async () => many))
    await screen.findByRole('list', { name: 'Repositories' })
    for (let index = 0; index < 10; index += 1) check(`alice/svc-${String(index).padStart(2, '0')}`)
    expect(screen.getByText(/10 repositories selected/).textContent).toContain('a scan takes at most 10')
    expect((screen.getByRole('checkbox', { name: 'Select alice/svc-10' }) as HTMLInputElement).disabled).toBe(true)
  })

  it('offers to connect repositories when the App is installed nowhere', async () => {
    const load = vi.fn(async () => ({ ...LISTING, installations: [], repositories: [] }))
    await show(ME, load)
    expect(await screen.findByRole('heading', { name: 'Connect GitHub repositories' })).toBeTruthy()
    expect(screen.getByRole('link', { name: /Connect GitHub repositories/ }).getAttribute('href')).toBe(installUrl(window.location.origin))
    expect(screen.getByText(/GitHub sends the request to an owner to approve/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /I installed it, check again/ }))
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }))
  })

  it.each([
    [new ApiFailure('http', { status: 401, errorCode: 'SESSION_EXPIRED', serverMessage: 'Your GitHub sign-in has expired. Sign in again.' }), 'Your session has ended', 'Sign in with GitHub'],
    [new ApiFailure('http', { status: 401, errorCode: 'SIGN_IN_REQUIRED', serverMessage: 'Sign in with GitHub to see your repositories.' }), 'Sign in to see your repositories', 'Sign in with GitHub'],
    [new ApiFailure('http', { status: 429, errorCode: 'GITHUB_RATE_LIMITED', serverMessage: "GitHub's rate limit was reached." }), "GitHub's rate limit was reached", 'Try again'],
    [new ApiFailure('http', { status: 502, errorCode: 'GITHUB_UNAVAILABLE', serverMessage: 'GitHub could not be reached.' }), 'GitHub could not be reached', 'Try again'],
    [new ApiFailure('network'), 'Backend unreachable', 'Try again'],
    [new ApiFailure('http', { status: 503, errorCode: 'GITHUB_APP_NOT_CONFIGURED' }), 'Repository access is not set up', null],
  ])('shows a failed listing as an error with a way forward, never as an empty list (%#)', async (failure, title, action) => {
    await show(ME, vi.fn(async () => Promise.reject(failure)))
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByRole('heading', { name: title })).toBeTruthy()
    if (action) expect(within(alert).getByRole('button', { name: action })).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Repositories' })).toBeNull()
    expect(screen.queryByText(/No repository is granted/)).toBeNull()
  })

  it('reads the list again on Refresh and after returning from GitHub, and shows how the installation ended', async () => {
    const { load } = await show(ME, vi.fn(async () => LISTING), { search: '?github_setup=request' })
    await screen.findByRole('list', { name: 'Repositories' })
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ refresh: true }))
    expect(screen.getByText(/Your request was sent to an organization owner/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('reports an incomplete list and a refused scan', async () => {
    const refused = toUiError(new ApiFailure('http', { status: 403, errorCode: 'REPOSITORY_NOT_AUTHORIZED', serverMessage: 'bob/vault was not found, or your GitHub sign-in has no access to it through DriftLock.' }))
    await show(ME, vi.fn(async () => ({ ...LISTING, complete: false })), { error: refused })
    await screen.findByRole('list', { name: 'Repositories' })
    expect(screen.getByText(/GitHub reported more repositories than DriftLock lists, so some are not shown/)).toBeTruthy()
    const banner = screen.getAllByRole('alert').find((element) => element.textContent?.includes('No access to a repository')) as HTMLElement
    expect(banner.textContent).toContain('bob/vault was not found, or your GitHub sign-in has no access to it')
  })
})

describe('repository list parsing', () => {
  it('keeps only what can be shown and scanned, and links only to GitHub', () => {
    const listing = parseListing({
      installations: [{ id: 1, account: { login: 'a', type: 'User', avatar_url: 'https://evil.example/a.png' }, repository_selection: 'all', missing_permissions: ['contents', 3], manage_url: 'javascript:alert(1)' }],
      repositories: [
        { id: 1, name: 'ok', owner: 'a', full_name: 'a/ok', private: true, html_url: 'https://github.com/a/ok' },
        { id: 2, name: 'bad', full_name: 'a/bad repo; rm -rf', private: false },
        { id: 3, name: 'odd', full_name: 'a/odd', private: 'yes', html_url: 'http://github.com/a/odd' },
        'not a repository',
      ],
      complete: false,
    })
    expect(listing.installations[0]).toMatchObject({ account: { avatarUrl: null }, manageUrl: null, missingPermissions: ['contents'] })
    expect(listing.repositories.map((r) => [r.fullName, r.private, r.htmlUrl])).toEqual([['a/ok', true, 'https://github.com/a/ok'], ['a/odd', false, null]])
    expect(listing.complete).toBe(false)
    expect(() => parseListing({ repositories: 'nope' })).toThrow(ApiFailure)
  })

  it('filters and turns a pick into a scan target on its default branch', () => {
    expect(visibleRepositories(LISTING.repositories, 'LEDGER', 'all').map((r) => r.fullName)).toEqual(['alice/ledger'])
    expect(visibleRepositories(LISTING.repositories, '', 'private')).toHaveLength(2)
    expect(targetOf(LISTING.repositories[2] as GitHubRepository)).toEqual({ kind: 'github', label: 'site', name: 'site', url: 'https://github.com/alice/site', ref: null, files: [] })
  })
})
