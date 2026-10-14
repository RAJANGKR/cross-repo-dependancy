// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toUiError, ApiFailure } from '../api/errors'
import { AuthProvider, parseAuth, signInUrl } from '../hooks/useAuth'
import { AuthButton } from './common/AuthButton'
import { ToastProvider } from './common/Controls'

const OCTOCAT = { id: 42, login: 'octocat', name: 'The Octocat', avatar_url: 'https://avatars.githubusercontent.com/u/42' }

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function renderButton() {
  return render(
    <ToastProvider>
      <AuthProvider>
        <AuthButton />
      </AuthProvider>
    </ToastProvider>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('parseAuth', () => {
  it('reads a signed-in user and accepts only GitHub avatar URLs', () => {
    expect(parseAuth({ configured: true, required: true, user: OCTOCAT, repository_access: { configured: true } })).toEqual({
      configured: true,
      required: true,
      user: { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/42' },
      repositoryAccess: true,
    })
    expect(parseAuth({ configured: true, user: OCTOCAT }).repositoryAccess).toBe(false)              // an older backend has none
    expect(parseAuth({ configured: true, user: { login: 'x', avatar_url: 'https://evil.example/a.png' } }).user).toEqual({
      login: 'x',
      name: 'x',
      avatarUrl: null,
    })
  })

  it('treats anything unexpected as signed out', () => {
    const signedOut = { configured: false, required: false, user: null, repositoryAccess: false }
    for (const body of [null, 'text', {}, { user: {} }, { user: { name: 'no login' } }, { configured: 'yes' }]) {
      expect(parseAuth(body)).toEqual(signedOut)
    }
  })

  it('builds the sign-in link with the page to come back to', () => {
    expect(signInUrl('http://localhost:5174')).toMatch(/\/api\/v1\/auth\/github\/login\?return_to=http%3A%2F%2Flocalhost%3A5174$/)
  })
})

describe('AuthButton', () => {
  it('offers GitHub sign-in when signed out, and sends the session cookie when asking', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve(json({ configured: true, required: false, user: null })))
    vi.stubGlobal('fetch', fetchMock)
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, origin: 'http://localhost:5174', assign })
    renderButton()

    const button = (await screen.findByRole('button', { name: 'Sign in with GitHub' })) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include')
    fireEvent.click(button)
    expect(assign).toHaveBeenCalledWith(expect.stringContaining('/api/v1/auth/github/login?return_to=http%3A%2F%2Flocalhost%3A5174'))
  })

  it('disables the button and says why when the backend has no GitHub app set up', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(json({ configured: false, user: null })))
    renderButton()
    const button = (await screen.findByRole('button', { name: 'Sign in with GitHub' })) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toMatch(/not set up on the backend/)
  })

  it('shows the signed-in user and signs out', async () => {
    let signedIn = true
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/logout')) {
        expect(init?.method).toBe('POST')
        signedIn = false
        return Promise.resolve(json({ signed_out: true }))
      }
      return Promise.resolve(json({ configured: true, user: signedIn ? OCTOCAT : null }))
    })
    vi.stubGlobal('fetch', fetchMock)
    renderButton()

    fireEvent.click(await screen.findByRole('button', { name: /octocat/ }))
    expect(screen.getByText('The Octocat')).toBeTruthy()
    expect(screen.getByText('Signed in with GitHub as octocat')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy())
    expect(screen.getByText('Signed out')).toBeTruthy()
  })

  it('renders nothing when the backend cannot be reached', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')))
    const { container } = renderButton()
    await waitFor(() => expect(container.querySelector('button')).toBeNull())
  })
})

describe('a scan refused for lack of sign-in', () => {
  it('is explained in the form', () => {
    const error = toUiError(new ApiFailure('http', { status: 401, errorCode: 'SIGN_IN_REQUIRED', serverMessage: 'Sign in with GitHub to start a scan.' }))
    expect(error).toMatchObject({ kind: 'bad-request', title: 'Sign in required', message: 'Sign in with GitHub to start a scan.' })
  })
})
