import { LoaderCircle, LogIn, RotateCcw } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { Button } from '../common/Button'
import { Wordmark } from '../common/Tags'

/**
 * Shown only when the backend is configured to require sign-in. It also says
 * plainly why sign-in is not possible when the backend is down or has no
 * GitHub app configured.
 */
export function SignInScreen() {
  const auth = useAuth()

  return (
    <div className="guide-lines min-h-screen">
      <header className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center rounded-xl border border-border bg-card px-5 shadow-nav sm:px-6">
          <Wordmark />
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-20 sm:px-6">
        <p className="eyebrow">Cross-repo dependency drift detector</p>
        <h1 className="mt-6 font-display text-5xl tracking-tight lg:text-7xl">Sign in to continue</h1>
        <p className="mt-6 text-xl leading-relaxed text-muted-foreground">
          This DriftLock server requires a GitHub account. Signing in shares only your public profile: your name, username
          and avatar. It does not give DriftLock access to your repositories.
        </p>

        <div className="mt-10" aria-live="polite">
          {auth.status === 'loading' && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              Checking whether you are signed in
            </p>
          )}

          {auth.status === 'ready' && (
            <>
              <Button variant="primary" size="lg" onClick={auth.signIn} disabled={!auth.configured}>
                <LogIn aria-hidden="true" />
                Sign in with GitHub
              </Button>
              {!auth.configured && (
                <p role="alert" className="mt-4 max-w-xl text-risk-critical">
                  GitHub sign-in is not set up on the backend yet, so nobody can sign in. Add
                  GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET to backend/.env and restart the backend.
                </p>
              )}
            </>
          )}

          {auth.status === 'unavailable' && (
            <>
              <p role="alert" className="max-w-xl text-risk-critical">
                The backend could not be reached, so sign-in is not possible right now. Check that it is running.
              </p>
              <Button className="mt-4" size="lg" onClick={() => void auth.refresh()}>
                <RotateCcw aria-hidden="true" />
                Try again
              </Button>
            </>
          )}
        </div>
      </main>
    </div>
  )
}
