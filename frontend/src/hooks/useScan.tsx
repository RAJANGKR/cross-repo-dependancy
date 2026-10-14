import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { createDemoClient, DEMO_REPO_URLS, readDemoVariant } from '../api/demoScan'
import { ApiFailure, isCancelled, toUiError, type UiError } from '../api/errors'
import { runScan } from '../api/runScan'
import { createSavedDemoClient, createScanClient, type ScanClient, type ScanClientConfig } from '../api/scanClient'
import type { ScanProgress, ScanRecord } from '../api/scanTypes'
import {
  API_BASE_URL,
  DEMO_POLL_INTERVAL_MS,
  MAX_POLL_FAILURES,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  SCAN_TIMEOUT_MS,
  USE_MOCK,
} from '../config'
import type { DataSource } from '../lib/exportMarkdown'
import { toHistoryEntry } from '../lib/insights'
import { HISTORY_LIMIT, log, updateStore } from '../lib/localStore'
import { toScanRequest, type ScanTarget } from '../lib/targets'

/** A target as submitted. The label is display-only and never sent. */
export type SubmittedRepo = ScanTarget

export type ScanState =
  | { phase: 'idle' }
  | {
      phase: 'running'
      source: DataSource
      startedAt: number
      scanId: string | null
      /** Latest status from the backend; "SUBMITTING" before the first reply. */
      status: string
      progress: ScanProgress | null
      repos: SubmittedRepo[]
      /** Why this data is being shown instead of what was asked for, when that is the case. */
      notice: string | null
    }
  | { phase: 'done'; source: DataSource; record: ScanRecord; repos: SubmittedRepo[]; notice: string | null }
  | { phase: 'error'; source: DataSource; error: UiError; repos: SubmittedRepo[] }

type Action =
  | { type: 'start'; source: DataSource; startedAt: number; repos: SubmittedRepo[]; notice: string | null }
  | { type: 'update'; scanId: string; status: string; progress: ScanProgress | null }
  | { type: 'done'; source: DataSource; record: ScanRecord; repos: SubmittedRepo[]; notice: string | null }
  | { type: 'error'; source: DataSource; error: UiError; repos: SubmittedRepo[] }
  | { type: 'reset' }

function reducer(state: ScanState, action: Action): ScanState {
  switch (action.type) {
    case 'start':
      return {
        phase: 'running',
        source: action.source,
        startedAt: action.startedAt,
        scanId: null,
        status: 'SUBMITTING',
        progress: null,
        repos: action.repos,
        notice: action.notice,
      }
    case 'update':
      return state.phase === 'running'
        ? { ...state, scanId: action.scanId, status: action.status, progress: action.progress }
        : state
    case 'done':
      return { phase: 'done', source: action.source, record: action.record, repos: action.repos, notice: action.notice }
    case 'error':
      return { phase: 'error', source: action.source, error: action.error, repos: action.repos }
    case 'reset':
      return { phase: 'idle' }
  }
}

export interface ScanApi {
  state: ScanState
  /** Submits a scan and polls it to completion. Ignored while one is running. */
  startScan: (repos: SubmittedRepo[]) => Promise<boolean>
  /**
   * Loads the saved demo run from the backend. When that fails, the sample
   * built into the app is played instead and the state says so (`notice`).
   */
  loadDemo: () => Promise<boolean>
  /** Runs the last scan or demo again. */
  retry: () => Promise<boolean>
  /** Stops polling and returns to idle. */
  cancel: () => void
  reset: () => void
}

const ScanContext = createContext<ScanApi | null>(null)

/** The repositories of the bundled sample. */
const SAMPLE_REPOS: SubmittedRepo[] = ['payment-service', 'core-service', 'customer-service'].map((name) => ({
  kind: 'github' as const,
  label: name,
  url: DEMO_REPO_URLS[name] ?? `https://github.com/GoogleCloudPlatform/microservices-demo/tree/main/src/${name}`,
  name,
  ref: null,
  files: [],
}))

interface Run {
  source: DataSource
  repos: SubmittedRepo[]
  makeClient: () => ScanClient
  pollIntervalMs: number
  /** Names the repositories from the finished record, for a run that does not know them beforehand. */
  reposFrom?: (record: ScanRecord) => SubmittedRepo[]
  /** What to run instead when this run fails, given what was thrown. */
  fallback?: (error: unknown) => Run
  notice?: string
}

const backendConfig = (): ScanClientConfig => ({
  baseUrl: API_BASE_URL,
  timeoutMs: REQUEST_TIMEOUT_MS,
  // The session cookie goes along, so a backend that requires sign-in recognizes the user.
  fetchImpl: (input, init) => fetch(input, { ...init, credentials: 'include' }),
})

/** The bundled sample, played through the same lifecycle as a scan. */
const sampleRun = (repos: SubmittedRepo[], variant: Parameters<typeof createDemoClient>[0] = null, notice?: string): Run => ({
  source: 'sample',
  repos,
  makeClient: () => createDemoClient(variant),
  pollIntervalMs: DEMO_POLL_INTERVAL_MS,
  notice,
})

/** The saved run names its own repositories; nothing was submitted for it. */
function reposOf(record: ScanRecord): SubmittedRepo[] {
  return (record.result?.scanned_repositories ?? []).map((repo) => ({
    kind: 'github' as const,
    label: repo.name,
    url: repo.url,
    name: repo.name,
    ref: null,
    files: [],
  }))
}

/**
 * Why the sample is on screen instead of the saved demo run. It is shown with
 * the results, so the sample is never mistaken for the backend's saved scan.
 */
export function sampleNotice(error: unknown): string {
  let reason = 'the backend sent a record that could not be read as a finished scan'
  if (error instanceof ApiFailure) {
    if (error.reason === 'network') reason = 'the backend could not be reached'
    else if (error.reason === 'timeout') reason = 'the backend did not answer in time'
    else if (error.reason === 'http') reason = error.serverMessage.replace(/\.$/, '') || `the backend answered with status ${error.status}`
  }
  return `The saved demo scan could not be loaded: ${reason}. Showing the sample built into the app instead: illustrative data, not the output of a real scan.`
}

export function ScanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { phase: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  const lastRunRef = useRef<Run | null>(null)

  const execute = useCallback(async (first: Run): Promise<boolean> => {
    // One scan at a time: a second click while polling must not submit again.
    if (controllerRef.current) return false
    const controller = new AbortController()
    controllerRef.current = controller
    lastRunRef.current = first // "Scan again" repeats what was asked for, before any fallback

    try {
      for (let run = first; ; ) {
        const { source } = run
        const notice = run.notice ?? null
        dispatch({ type: 'start', source, startedAt: Date.now(), repos: run.repos, notice })
        try {
          const record = await runScan(
            run.makeClient(),
            toScanRequest(run.repos),
            {
              signal: controller.signal,
              onUpdate: (update) => {
                if (controllerRef.current === controller) dispatch({ type: 'update', ...update })
              },
              pollIntervalMs: run.pollIntervalMs,
              timeoutMs: SCAN_TIMEOUT_MS,
              maxPollFailures: MAX_POLL_FAILURES,
            },
          )
          if (controllerRef.current !== controller) return false
          const repos = run.reposFrom?.(record) ?? run.repos
          dispatch({ type: 'done', source, record, repos, notice })
          if (record.result) {
            // History keeps names and public URLs only. Pasted content is never stored.
            // It knows two kinds of entry: a live scan, and anything that cannot be run again as one.
            const entry = toHistoryEntry(`${record.scan_id}:${Date.now()}`, source === 'live' ? 'live' : 'demo', repos, record.result)
            updateStore((store) => ({ ...store, history: [entry, ...store.history].slice(0, HISTORY_LIMIT) }))
            const what = { live: 'Scan', demo: 'Demo run', sample: 'Sample run' }[source]
            log('scan', `${what} of ${repos.length} targets: ${entry.drifted} drifted packages`)
          }
          return true
        } catch (error) {
          if (controllerRef.current !== controller || isCancelled(error)) return false
          if (!run.fallback) {
            dispatch({ type: 'error', source, error: toUiError(error), repos: run.repos })
            return false
          }
          run = run.fallback(error)
        }
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  const startScan = useCallback(
    (repos: SubmittedRepo[]) =>
      execute(
        USE_MOCK
          ? sampleRun(repos, readDemoVariant(window.location.search))
          : { source: 'live', repos, makeClient: () => createScanClient(backendConfig()), pollIntervalMs: POLL_INTERVAL_MS },
      ),
    [execute],
  )

  const loadDemo = useCallback(
    () =>
      execute(
        USE_MOCK
          ? sampleRun(SAMPLE_REPOS)
          : {
              source: 'demo',
              repos: [],
              makeClient: () => createSavedDemoClient(backendConfig()),
              pollIntervalMs: POLL_INTERVAL_MS,
              reposFrom: reposOf,
              // The demo still opens without a backend: the sample plays instead, and says why.
              fallback: (error) => sampleRun(SAMPLE_REPOS, null, sampleNotice(error)),
            },
      ),
    [execute],
  )

  const retry = useCallback(async () => {
    const last = lastRunRef.current
    return last ? execute(last) : false
  }, [execute])

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    dispatch({ type: 'reset' })
  }, [])

  const reset = useCallback(() => dispatch({ type: 'reset' }), [])

  const value = useMemo<ScanApi>(
    () => ({ state, startScan, loadDemo, retry, cancel, reset }),
    [state, startScan, loadDemo, retry, cancel, reset],
  )

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>
}

export function useScan(): ScanApi {
  const api = useContext(ScanContext)
  if (!api) throw new Error('useScan must be used inside <ScanProvider>')
  return api
}
