import { createContext, useCallback, useContext, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { createDemoClient, DEMO_REPO_URLS, readDemoVariant } from '../api/demoScan'
import { isCancelled, toUiError, type UiError } from '../api/errors'
import { runScan } from '../api/runScan'
import { createScanClient, type ScanClient } from '../api/scanClient'
import type { ScanProgress, ScanRecord } from '../api/scanTypes'
import {
  API_BASE_URL,
  DEFAULT_REPO_LABELS,
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
    }
  | { phase: 'done'; source: DataSource; record: ScanRecord; repos: SubmittedRepo[] }
  | { phase: 'error'; source: DataSource; error: UiError; repos: SubmittedRepo[] }

type Action =
  | { type: 'start'; source: DataSource; startedAt: number; repos: SubmittedRepo[] }
  | { type: 'update'; scanId: string; status: string; progress: ScanProgress | null }
  | { type: 'done'; source: DataSource; record: ScanRecord; repos: SubmittedRepo[] }
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
      }
    case 'update':
      return state.phase === 'running'
        ? { ...state, scanId: action.scanId, status: action.status, progress: action.progress }
        : state
    case 'done':
      return { phase: 'done', source: action.source, record: action.record, repos: action.repos }
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
  /** Plays the bundled demo scan. */
  loadDemo: () => Promise<boolean>
  /** Runs the last scan or demo again. */
  retry: () => Promise<boolean>
  /** Stops polling and returns to idle. */
  cancel: () => void
  reset: () => void
}

const ScanContext = createContext<ScanApi | null>(null)

const DEMO_REPOS: SubmittedRepo[] = ['payment-service', 'core-service', 'customer-service'].map((name, index) => ({
  kind: 'github' as const,
  label: DEFAULT_REPO_LABELS[index] ?? name,
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
}

export function ScanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { phase: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)
  const lastRunRef = useRef<Run | null>(null)

  const execute = useCallback(async (run: Run): Promise<boolean> => {
    // One scan at a time: a second click while polling must not submit again.
    if (controllerRef.current) return false
    const controller = new AbortController()
    controllerRef.current = controller
    lastRunRef.current = run
    const { source, repos } = run
    dispatch({ type: 'start', source, startedAt: Date.now(), repos })

    try {
      const record = await runScan(
        run.makeClient(),
        toScanRequest(repos),
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
      dispatch({ type: 'done', source, record, repos })
      if (record.result) {
        // History keeps names and public URLs only. Pasted content is never stored.
        const entry = toHistoryEntry(`${record.scan_id}:${Date.now()}`, source, repos, record.result)
        updateStore((store) => ({ ...store, history: [entry, ...store.history].slice(0, HISTORY_LIMIT) }))
        log('scan', `${source === 'demo' ? 'Demo run' : 'Scan'} of ${repos.length} targets: ${entry.drifted} drifted packages`)
      }
      return true
    } catch (error) {
      if (controllerRef.current !== controller || isCancelled(error)) return false
      dispatch({ type: 'error', source, error: toUiError(error), repos })
      return false
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  const startScan = useCallback(
    (repos: SubmittedRepo[]) =>
      execute(
        USE_MOCK
          ? {
              source: 'demo',
              repos,
              makeClient: () => createDemoClient(readDemoVariant(window.location.search)),
              pollIntervalMs: DEMO_POLL_INTERVAL_MS,
            }
          : {
              source: 'live',
              repos,
              makeClient: () =>
                createScanClient({
                  baseUrl: API_BASE_URL,
                  timeoutMs: REQUEST_TIMEOUT_MS,
                  fetchImpl: (input, init) => fetch(input, init),
                }),
              pollIntervalMs: POLL_INTERVAL_MS,
            },
      ),
    [execute],
  )

  const loadDemo = useCallback(
    () =>
      execute({
        source: 'demo',
        repos: DEMO_REPOS,
        makeClient: () => createDemoClient(),
        pollIntervalMs: DEMO_POLL_INTERVAL_MS,
      }),
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
