import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { analyze, getDemo } from '../api/client'
import { isCancelled, toUiError, type UiError } from '../api/errors'
import type { AnalyzeRequest, Report } from '../api/types'

export type RunMode = 'analyze' | 'demo'

/** One row of the analyzing screen. Only name and origin are kept, never content. */
export interface SubmittedProject {
  name: string
  origin: 'github' | 'pasted'
}

export type AnalysisState =
  | { status: 'idle' }
  | { status: 'loading'; mode: RunMode; startedAt: number; projects: SubmittedProject[] }
  | { status: 'success'; mode: RunMode; report: Report }
  | { status: 'error'; mode: RunMode; error: UiError }

type Action =
  | { type: 'start'; mode: RunMode; startedAt: number; projects: SubmittedProject[] }
  | { type: 'success'; mode: RunMode; report: Report }
  | { type: 'failure'; mode: RunMode; error: UiError }
  | { type: 'reset' }

function reducer(_state: AnalysisState, action: Action): AnalysisState {
  switch (action.type) {
    case 'start':
      return {
        status: 'loading',
        mode: action.mode,
        startedAt: action.startedAt,
        projects: action.projects,
      }
    case 'success':
      return { status: 'success', mode: action.mode, report: action.report }
    case 'failure':
      return { status: 'error', mode: action.mode, error: action.error }
    case 'reset':
      return { status: 'idle' }
  }
}

export interface AnalysisApi {
  state: AnalysisState
  /** Runs an analysis. Resolves to true when a report was loaded. */
  runAnalysis: (payload: AnalyzeRequest, projects: SubmittedProject[]) => Promise<boolean>
  /** Loads the saved demo run. Resolves to true when a report was loaded. */
  loadDemo: () => Promise<boolean>
  /** Aborts the request in flight and returns to idle. */
  cancel: () => void
  /** Clears a result or an error and returns to idle. */
  reset: () => void
}

const AnalysisContext = createContext<AnalysisApi | null>(null)

export function AnalysisProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { status: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)

  const run = useCallback(
    async (
      mode: RunMode,
      projects: SubmittedProject[],
      call: (signal: AbortSignal) => Promise<Report>,
    ): Promise<boolean> => {
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller
      dispatch({ type: 'start', mode, startedAt: Date.now(), projects })
      try {
        const report = await call(controller.signal)
        // A newer run or a cancel has replaced this one; drop its result.
        if (controllerRef.current !== controller) return false
        dispatch({ type: 'success', mode, report })
        return true
      } catch (error) {
        if (controllerRef.current !== controller || isCancelled(error)) return false
        dispatch({ type: 'failure', mode, error: toUiError(error) })
        return false
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null
      }
    },
    [],
  )

  const runAnalysis = useCallback(
    (payload: AnalyzeRequest, projects: SubmittedProject[]) =>
      run('analyze', projects, (signal) => analyze(payload, { signal })),
    [run],
  )

  const loadDemo = useCallback(() => run('demo', [], (signal) => getDemo({ signal })), [run])

  const cancel = useCallback(() => {
    controllerRef.current?.abort()
    controllerRef.current = null
    dispatch({ type: 'reset' })
  }, [])

  const reset = useCallback(() => dispatch({ type: 'reset' }), [])

  const value = useMemo<AnalysisApi>(
    () => ({ state, runAnalysis, loadDemo, cancel, reset }),
    [state, runAnalysis, loadDemo, cancel, reset],
  )

  return <AnalysisContext.Provider value={value}>{children}</AnalysisContext.Provider>
}

export function useAnalysis(): AnalysisApi {
  const api = useContext(AnalysisContext)
  if (!api) throw new Error('useAnalysis must be used inside <AnalysisProvider>')
  return api
}
