import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiErrorAction } from './api/errors'
import { AnalyzingState } from './components/analyzing/AnalyzingState'
import { InputScreen } from './components/input/InputScreen'
import { ResultsScreen } from './components/results/ResultsScreen'
import { ErrorState, NoResults } from './components/states/ErrorState'
import { DEFAULT_REPO_LABELS, REPO_COUNT } from './config'
import { AnnouncerProvider, useAnnounce } from './hooks/useAnnouncer'
import { carrySearch, navigate, ROUTE_PATHS, useRoute } from './hooks/useRoute'
import { ScanProvider, useScan, type SubmittedRepo } from './hooks/useScan'
import { isDrifted } from './lib/classify'
import type { RepoInput } from './lib/validateRepoUrl'

const EMPTY_INPUTS: RepoInput[] = Array.from({ length: REPO_COUNT }, (_, index) => ({
  label: DEFAULT_REPO_LABELS[index] ?? '',
  url: '',
}))

function AppShell() {
  const route = useRoute()
  const { state, startScan, loadDemo, retry, cancel, reset } = useScan()
  const announce = useAnnounce()
  // Held here, above the screens, so the form survives a cancel or a new scan.
  const [inputs, setInputs] = useState<RepoInput[]>(EMPTY_INPUTS)

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

  const submit = useCallback((repos: SubmittedRepo[]) => void run(() => startScan(repos)), [run, startScan])
  const demo = useCallback(() => void run(loadDemo), [run, loadDemo])

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
        if (action === 'retry') void run(retry)
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
        />
      )
    }
    if (state.phase !== 'error') {
      return <NoResults onStart={() => goTo('input')} onLoadDemo={demo} />
    }
  }

  return (
    <InputScreen
      inputs={inputs}
      onInputsChange={setInputs}
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
      <ScanProvider>
        <AppShell />
      </ScanProvider>
    </AnnouncerProvider>
  )
}
