import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiErrorAction } from './api/errors'
import { AnalyzingState } from './components/analyzing/AnalyzingState'
import { ToastProvider, useToast } from './components/common/Controls'
import { useTheme } from './components/console/Shell'
import { InputScreen } from './components/input/InputScreen'
import type { FormState } from './components/input/RepoForm'
import { ResultsScreen } from './components/results/ResultsScreen'
import { ErrorState, NoResults } from './components/states/ErrorState'
import { SignInScreen } from './components/states/SignInScreen'
import { INITIAL_REPO_ROWS, USE_MOCK } from './config'
import { AnnouncerProvider, useAnnounce } from './hooks/useAnnouncer'
import { AUTH_ERRORS, AuthProvider, useAuth } from './hooks/useAuth'
import { carrySearch, navigate, ROUTE_PATHS, useRoute } from './hooks/useRoute'
import { ScanProvider, useScan } from './hooks/useScan'
import { isDrifted } from './lib/classify'
import type { HistoryEntry } from './lib/localStore'
import { newRow, type ScanTarget } from './lib/targets'

const emptyForm = (): FormState => ({
  tab: 'github',
  rows: Array.from({ length: INITIAL_REPO_ROWS }, () => newRow()),
  projects: [],
})

function AppShell() {
  const route = useRoute()
  const { state, startScan, loadDemo, retry, cancel, reset } = useScan()
  const announce = useAnnounce()
  const toast = useToast()
  const auth = useAuth()
  useTheme()

  // GitHub sends the browser back with ?auth_error=... when sign-in did not finish.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const problem = params.get('auth_error')
    if (!problem) return
    params.delete('auth_error')
    const rest = params.toString()
    navigate(`${window.location.pathname}${rest ? `?${rest}` : ''}`, { replace: true })
    toast(AUTH_ERRORS[problem] ?? 'Sign-in did not complete. Try again.')
  }, [toast])
  // Held here, above the screens, so the form survives a cancel or a new scan.
  // It is React state only: pasted content is never written to storage.
  const [form, setForm] = useState<FormState>(emptyForm)

  const goTo = useCallback(
    (name: 'input' | 'results', keepQuery = false) =>
      navigate(`${ROUTE_PATHS[name]}${keepQuery ? route.search : carrySearch(route.search)}`),
    [route.search],
  )

  // Show the results once a run finishes, keeping any filters already in the URL.
  const run = useCallback(
    async (start: () => Promise<boolean>) => {
      if (await start()) goTo('results', route.name === 'results')
    },
    [goTo, route.name],
  )

  const submit = useCallback((targets: ScanTarget[]) => void run(() => startScan(targets)), [run, startScan])
  const demo = useCallback(() => void run(loadDemo), [run, loadDemo])
  const scanAgain = useCallback(() => void run(retry), [run, retry])

  /** Puts a history entry's repositories back in the form. Pasted projects are never saved, so they cannot be restored. */
  const restore = useCallback(
    (entry: HistoryEntry) => {
      const github = entry.targets.filter((target) => target.kind === 'github' && target.url)
      setForm({
        tab: 'github',
        projects: [],
        rows: github.map((target) => ({ ...newRow(), label: target.label, url: target.url ?? '', ref: target.ref ?? '' })),
      })
      goTo('input')
    },
    [goTo],
  )

  // Announce scan milestones to screen readers.
  const lastPhase = useRef(state.phase)
  useEffect(() => {
    if (lastPhase.current === state.phase) return
    lastPhase.current = state.phase
    if (state.phase === 'running') announce('Scan started')
    if (state.phase === 'error') announce(`${state.error.title}. ${state.error.message}`)
    if (state.phase === 'done') {
      const drifted = state.record.result?.drift_matrix.filter((row) => isDrifted(row.drift_disparity)).length ?? 0
      announce(`Scan complete: ${drifted} drifted ${drifted === 1 ? 'package' : 'packages'} found`)
    }
  }, [state, announce])

  // Sign-in is optional. The sign-in screen appears only when a backend has
  // been configured to demand it (AUTH_REQUIRED=true).
  if (!USE_MOCK && auth.required && !auth.user) return <SignInScreen />

  if (state.phase === 'running') {
    return (
      <AnalyzingState
        source={state.source}
        startedAt={state.startedAt}
        scanId={state.scanId}
        status={state.status}
        progress={state.progress}
        repos={state.repos}
        onCancel={() => {
          cancel()
          goTo('input')
        }}
      />
    )
  }

  if (state.phase === 'error') {
    // A rejected request is something to fix in the form, so it is shown there.
    const inline = state.error.kind === 'bad-request'
    if (!inline) {
      const onAction = (action: UiErrorAction) => {
        if (action === 'retry') scanAgain()
        else if (action === 'load-demo') demo()
        else {
          reset()
          goTo('input')
        }
      }
      return <ErrorState error={state.error} demo={state.source === 'demo'} onAction={onAction} />
    }
  }

  if (route.name === 'results') {
    if (state.phase === 'done' && state.record.result) {
      return (
        <ResultsScreen
          record={state.record}
          result={state.record.result}
          source={state.source}
          submitted={state.repos}
          search={route.search}
          onNewScan={() => goTo('input')}
          onScanAgain={scanAgain}
          onRunAgain={restore}
        />
      )
    }
    if (state.phase !== 'error') {
      return <NoResults onStart={() => goTo('input')} onLoadDemo={demo} />
    }
  }

  return (
    <InputScreen
      form={form}
      onFormChange={setForm}
      busy={false}
      error={state.phase === 'error' ? state.error : null}
      onDismissError={reset}
      onSubmit={submit}
      onLoadDemo={demo}
    />
  )
}

export default function App() {
  return (
    <AnnouncerProvider>
      <ToastProvider>
        <AuthProvider>
          <ScanProvider>
            <AppShell />
          </ScanProvider>
        </AuthProvider>
      </ToastProvider>
    </AnnouncerProvider>
  )
}
