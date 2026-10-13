import { API_BASE_URL } from '../config'
import { ApiFailure, extractServerError } from './errors'

/**
 * Client for the rollout planner: POST /api/v1/rollout (docs/API_CONTRACT.md,
 * "Rollout planner"). One request, one answer; there is no polling.
 */

export const RECOMMENDATIONS = ['PROVIDER_FIRST', 'CONSUMER_FIRST', 'EITHER', 'NEITHER', 'UNRESOLVED'] as const
export const STATE_STATUSES = ['COMPATIBLE', 'INCOMPATIBLE', 'UNKNOWN'] as const

/** The analysis reads four refs and two source archives, so it gets more time than an ordinary request. */
export const ROLLOUT_TIMEOUT_MS = 120_000

export interface RolloutSideInput {
  url: string
  /** What runs today: a branch, tag or commit. */
  current_ref: string
  /** What is about to be released. */
  proposed_ref: string
}

export interface RolloutRequest {
  provider: RolloutSideInput
  consumer: RolloutSideInput
}

/** Exactly what the backend read for one side at one ref. */
export interface AnalyzedRef {
  /** P0, P1, C0 or C1. */
  label: string
  repository: string
  url: string
  ref: string
  /** Empty when the ref could not be resolved. */
  commit: string
  spec_file: string
  api_title: string
  api_version: string
  /** Source files read from a consumer ref; null for a provider ref or when nothing was read. */
  files_read: number | null
  /** Why this ref could not be read or used; empty when it was. */
  problem: string
}

export interface RolloutContractChange {
  /** P0_TO_P1: P1 no longer accepts or returns what P0 did. P1_TO_P0: P1 offers something P0 does not. */
  direction: string
  change_type: string
  method: string
  path: string
  field: string
  field_in: string
  previous_value: string
  new_value: string
  spec_file: string
  json_pointer: string
  description: string
}

/** What the consumer code at one ref shows about one contract change. */
export interface RolloutEvidence {
  verdict: string
  change_type: string
  method: string
  path: string
  field: string
  field_in: string
  evidence_tier: string
  usage: string
  file: string
  line: number | null
  snippet: string
  explanation: string
}

export interface RolloutState {
  key: string
  title: string
  description: string
  provider: string
  consumer: string
  status: string
  reason: string
  evidence: RolloutEvidence[]
  unresolved: string[]
}

export interface RolloutResult {
  recommendation: string
  summary: string
  refs: AnalyzedRef[]
  provider_first: RolloutState
  consumer_first: RolloutState
  /** Both deployed (P1 with C1). Informational: it does not change the recommendation. */
  final: RolloutState
  contract_changes: RolloutContractChange[]
  unresolved: { scope: string; reason: string }[]
  limitations: string[]
}

type Rec = Record<string, unknown>

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const records = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter(isRecord) : [])
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function parseState(raw: unknown): RolloutState {
  if (!isRecord(raw) || !str(raw.status)) throw new ApiFailure('shape')
  return {
    key: str(raw.key),
    title: str(raw.title),
    description: str(raw.description),
    provider: str(raw.provider),
    consumer: str(raw.consumer),
    status: str(raw.status),
    reason: str(raw.reason),
    evidence: records(raw.evidence).map((item) => ({
      verdict: str(item.verdict),
      change_type: str(item.change_type),
      method: str(item.method).toUpperCase(),
      path: str(item.path),
      field: str(item.field),
      field_in: str(item.field_in),
      evidence_tier: str(item.evidence_tier),
      usage: str(item.usage),
      file: str(item.file),
      line: num(item.line),
      snippet: str(item.snippet),
      explanation: str(item.explanation),
    })),
    unresolved: Array.isArray(raw.unresolved) ? raw.unresolved.filter((item): item is string => typeof item === 'string') : [],
  }
}

/**
 * Reads a rollout response. A body without a recommendation or without the two
 * intermediate states is rejected: showing a half-read verdict would be worse
 * than showing an error.
 */
export function parseRolloutResult(body: unknown): RolloutResult {
  if (!isRecord(body) || !str(body.recommendation)) throw new ApiFailure('shape')
  return {
    recommendation: str(body.recommendation),
    summary: str(body.summary),
    refs: records(body.refs).map((item) => ({
      label: str(item.label),
      repository: str(item.repository),
      url: str(item.url),
      ref: str(item.ref),
      commit: str(item.commit),
      spec_file: str(item.spec_file),
      api_title: str(item.api_title),
      api_version: str(item.api_version),
      files_read: num(item.files_read),
      problem: str(item.problem),
    })),
    provider_first: parseState(body.provider_first),
    consumer_first: parseState(body.consumer_first),
    final: parseState(body.final),
    contract_changes: records(body.contract_changes).map((item) => ({
      direction: str(item.direction),
      change_type: str(item.change_type),
      method: str(item.method).toUpperCase(),
      path: str(item.path),
      field: str(item.field),
      field_in: str(item.field_in),
      previous_value: str(item.previous_value),
      new_value: str(item.new_value),
      spec_file: str(item.spec_file),
      json_pointer: str(item.json_pointer),
      description: str(item.description),
    })),
    unresolved: records(body.unresolved).map((item) => ({ scope: str(item.scope), reason: str(item.reason) })),
    limitations: Array.isArray(body.limitations) ? body.limitations.filter((item): item is string => typeof item === 'string') : [],
  }
}

export interface RolloutClientOptions {
  signal?: AbortSignal
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export type AnalyzeRollout = (request: RolloutRequest, options?: RolloutClientOptions) => Promise<RolloutResult>

/** Sends the six form values to the backend and returns its analysis. Throws `ApiFailure`. */
export const analyzeRollout: AnalyzeRollout = async (request, options = {}) => {
  const { signal, baseUrl = API_BASE_URL, timeoutMs = ROLLOUT_TIMEOUT_MS, fetchImpl = fetch } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (signal?.aborted) controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    let response: Response
    let text: string
    try {
      response = await fetchImpl(`${baseUrl}/api/v1/rollout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        credentials: 'include',
        signal: controller.signal,
      })
      text = await response.text()
    } catch {
      throw new ApiFailure(timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'network')
    }
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      throw new ApiFailure(response.ok ? 'shape' : 'http', { status: response.status })
    }
    if (!response.ok) throw new ApiFailure('http', { status: response.status, ...extractServerError(body) })
    return parseRolloutResult(body)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** A sentence a person can act on, for each way the request can fail. */
export function rolloutErrorMessage(error: unknown, baseUrl: string = API_BASE_URL): { title: string; message: string } {
  if (error instanceof ApiFailure) {
    if (error.reason === 'network') {
      return { title: 'The backend could not be reached', message: `Nothing answered at ${baseUrl}. Start the backend, then analyze again.` }
    }
    if (error.reason === 'timeout') {
      return { title: 'The analysis took too long', message: 'The backend did not answer in time. Large repositories take longer to download; try again.' }
    }
    if (error.reason === 'http' && error.status === 404) {
      return { title: 'This backend has no rollout planner', message: `${baseUrl} answered, but it does not serve POST /api/v1/rollout. Update and restart the backend.` }
    }
    if (error.reason === 'http' && error.status === 401) {
      return { title: 'Sign-in required', message: error.serverMessage || 'Sign in with GitHub, then analyze again.' }
    }
    if (error.reason === 'http' && error.status === 400) {
      return { title: 'The request was not accepted', message: error.serverMessage || 'Check the repository URLs and the four refs.' }
    }
    if (error.reason === 'http') {
      return { title: 'The backend reported an error', message: error.serverMessage || `The backend answered with HTTP ${error.status ?? 'error'}.` }
    }
    if (error.reason === 'shape') {
      return { title: 'The answer could not be read', message: 'The backend replied in a format this page does not understand. Nothing is shown, because a partly read result could mislead.' }
    }
  }
  return { title: 'The analysis did not finish', message: 'Something unexpected went wrong. Try again.' }
}
