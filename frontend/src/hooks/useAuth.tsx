import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { API_BASE_URL, USE_MOCK } from '../config'

/**
 * Sign in with GitHub, the only sign-in method. It is optional unless the
 * backend is configured to require it. The backend runs the OAuth
 * flow and keeps the session in an HTTP-only cookie, so this code never sees
 * a token: it only asks "who is signed in?" and starts or ends the session.
 */

export interface AuthUser {
  login: string
  name: string
  /** Only GitHub's own avatar host is accepted; anything else is dropped. */
  avatarUrl: string | null
}

export interface AuthInfo {
  /** GitHub sign-in is set up on the backend. */
  configured: boolean
  /** The backend refuses scans from signed-out users. */
  required: boolean
  user: AuthUser | null
  /** A GitHub App is set up, so a signed-in user can pick repositories and scan private ones. */
  repositoryAccess: boolean
}

export interface AuthApi extends AuthInfo {
  /** "unavailable" means the backend could not be asked (offline, or mock mode). */
  status: 'loading' | 'ready' | 'unavailable'
  signIn: () => void
  signOut: () => Promise<void>
  /** Asks the backend again, for example after it was unreachable. */
  refresh: () => Promise<void>
}

const SIGNED_OUT: AuthInfo = { configured: false, required: false, user: null, repositoryAccess: false }
const AVATAR_HOST = 'https://avatars.githubusercontent.com/'

export const AUTH_ERRORS: Record<string, string> = {
  cancelled: 'Sign-in was cancelled on GitHub.',
  exchange_failed: 'GitHub did not complete the sign-in. Try again.',
  github_unreachable: 'GitHub could not be reached to finish signing in. Try again.',
  not_configured: 'GitHub sign-in is not set up on the backend.',
}

/** Where GitHub's App installation flow ended, from /repositories?github_setup=. */
export const SETUP_NOTICES: Record<string, { tone: 'success' | 'info' | 'warning'; text: string }> = {
  install: { tone: 'success', text: "DriftLock's GitHub App is installed. The repositories you granted are listed below." },
  update: { tone: 'success', text: 'Repository access was updated. The list below is read again from GitHub.' },
  request: { tone: 'info', text: 'Your request was sent to an organization owner. Its repositories appear here once they approve the installation.' },
  done: { tone: 'info', text: 'Back from GitHub. The list below is read again.' },
  sign_in_required: { tone: 'warning', text: 'Sign in with GitHub first, then connect repositories.' },
  not_configured: { tone: 'warning', text: 'Repository access is not set up on this backend.' },
}

/** Reads the backend's /auth/me reply, tolerating missing or malformed fields. */
export function parseAuth(body: unknown): AuthInfo {
  if (typeof body !== 'object' || body === null) return SIGNED_OUT
  const data = body as Record<string, unknown>
  const raw = typeof data.user === 'object' && data.user !== null ? (data.user as Record<string, unknown>) : null
  const login = raw && typeof raw.login === 'string' ? raw.login : ''
  const avatar = raw && typeof raw.avatar_url === 'string' ? raw.avatar_url : ''
  const access = typeof data.repository_access === 'object' && data.repository_access !== null ? (data.repository_access as Record<string, unknown>) : {}
  return {
    configured: data.configured === true,
    required: data.required === true,
    repositoryAccess: access.configured === true,
    user: login
      ? {
          login,
          name: raw && typeof raw.name === 'string' && raw.name ? raw.name : login,
          avatarUrl: avatar.startsWith(AVATAR_HOST) ? avatar : null,
        }
      : null,
  }
}

export function signInUrl(origin: string): string {
  return `${API_BASE_URL}/api/v1/auth/github/login?return_to=${encodeURIComponent(origin)}`
}

const AuthContext = createContext<AuthApi>({ ...SIGNED_OUT, status: 'unavailable', signIn: () => undefined, signOut: async () => undefined, refresh: async () => undefined })

export function AuthProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AuthInfo>(SIGNED_OUT)
  const [status, setStatus] = useState<AuthApi['status']>(USE_MOCK ? 'unavailable' : 'loading')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/me`, { credentials: 'include', signal })
      if (!response.ok) throw new Error('auth status unavailable')
      setInfo(parseAuth(await response.json()))
      setStatus('ready')
    } catch {
      if (signal?.aborted) return
      setInfo(SIGNED_OUT)
      setStatus('unavailable')
    }
  }, [])

  useEffect(() => {
    if (USE_MOCK) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const signIn = useCallback(() => window.location.assign(signInUrl(window.location.origin)), [])

  const signOut = useCallback(async () => {
    try {
      await fetch(`${API_BASE_URL}/api/v1/auth/logout`, { method: 'POST', credentials: 'include' })
    } catch {
      // Even if the request failed, re-reading the status below shows the truth.
    }
    await refresh()
  }, [refresh])

  const retry = useCallback(async () => {
    setStatus('loading')
    await refresh()
  }, [refresh])

  const value = useMemo<AuthApi>(
    () => ({ ...info, status, signIn, signOut, refresh: retry }),
    [info, status, signIn, signOut, retry],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  return useContext(AuthContext)
}
