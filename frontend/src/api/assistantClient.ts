import { API_BASE_URL } from '../config'
import type { DataSource } from '../lib/exportMarkdown'
import { ApiFailure, extractServerError } from './errors'
import type { RolloutResult } from './rolloutClient'
import type { ScanResult } from './scanTypes'

/**
 * Client for the assistant: POST /api/v1/assistant/chat (docs/API_CONTRACT.md,
 * "Assistant"). The backend holds the Gemini key and builds the answer from the
 * results sent with the question; nothing here talks to a model directly.
 */

export const ASSISTANT_TIMEOUT_MS = 40_000
/** Limits the backend enforces; the widget applies them before sending. */
export const MAX_ASSISTANT_MESSAGE = 600
export const MAX_ASSISTANT_HISTORY = 8
const MAX_TURN_CHARS = 2000

export interface AssistantTurn {
  role: 'user' | 'assistant'
  content: string
}

/** The results on screen. The assistant answers from these and from nothing else. */
export interface AssistantContext {
  scan: ScanResult | null
  scanId: string
  scanSource: DataSource
  rollout: RolloutResult | null
  /** The screen the question is asked from. An open question is about that screen's results first. */
  view: 'start' | 'results' | 'rollout'
}

export const ASSISTANT_SOURCES = ['gemini', 'fallback', 'no_context'] as const
export type AssistantSource = (typeof ASSISTANT_SOURCES)[number]

export interface AssistantReply {
  answer: string
  /** gemini: written by the model from the results. fallback: answered by fixed rules from the same results. no_context: there was nothing to answer from. */
  source: AssistantSource
  /** For a fallback: what the question was taken to be about, for example main_problem or out_of_scope. Empty otherwise. */
  intent: string
  /** For a fallback: one short sentence on why the model was not used. Empty otherwise. */
  notice: string
}

/** Fallback intents whose answer only says what the assistant can do: no fact from the results is given. */
export const SCOPE_INTENTS = ['out_of_scope', 'greeting', 'unsupported'] as const

export interface AssistantClientOptions {
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  baseUrl?: string
  timeoutMs?: number
}

export type AskAssistant = (message: string, history: readonly AssistantTurn[], context: AssistantContext, options?: AssistantClientOptions) => Promise<AssistantReply>

/** The same words the backend uses when it is asked without results. */
export const NO_RESULTS_ANSWER =
  "I can only answer questions about DriftLock results, and there are none yet. Run a scan from the start page, or load the demo run, and then ask me about it. I can also help once the Rollout planner has analyzed a provider and a consumer."

export function hasContext(context: AssistantContext): boolean {
  return context.scan !== null || context.rollout !== null
}

/** The request body. The dependency graph is left out: the assistant does not read it, and it is the largest part of a result. */
export function assistantRequest(message: string, history: readonly AssistantTurn[], context: AssistantContext) {
  const scan = context.scan ? { ...context.scan, graph_summary: null } : null
  return {
    message: message.trim().slice(0, MAX_ASSISTANT_MESSAGE),
    history: history.slice(-MAX_ASSISTANT_HISTORY).map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) })),
    context: { scan, scan_id: scan ? context.scanId : '', scan_source: context.scanSource, rollout: context.rollout, view: context.view },
  }
}

export function parseAssistantReply(body: unknown): AssistantReply {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
  const source = ASSISTANT_SOURCES.find((value) => value === record.source)
  // An answer without text, or of a kind this dashboard cannot label, is not shown as an answer.
  if (!answer || !source) throw new ApiFailure('shape')
  return {
    answer,
    source,
    intent: typeof record.intent === 'string' ? record.intent : '',
    notice: typeof record.notice === 'string' ? record.notice : '',
  }
}

export const askAssistant: AskAssistant = async (message, history, context, options = {}) => {
  const { signal: external, fetchImpl = fetch, baseUrl = API_BASE_URL, timeoutMs = ASSISTANT_TIMEOUT_MS } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (external?.aborted) controller.abort()
  external?.addEventListener('abort', onAbort, { once: true })

  try {
    let response: Response
    let text: string
    try {
      response = await fetchImpl(`${baseUrl}/api/v1/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(assistantRequest(message, history, context)),
        signal: controller.signal,
      })
      text = await response.text()
    } catch {
      throw new ApiFailure(timedOut ? 'timeout' : external?.aborted ? 'aborted' : 'network')
    }
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      if (response.ok) throw new ApiFailure('shape')
    }
    if (!response.ok) throw new ApiFailure('http', { status: response.status, ...extractServerError(body) })
    return parseAssistantReply(body)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onAbort)
  }
}

/** What to tell the user when no answer came back. It never contains an answer. */
export function assistantErrorMessage(error: unknown): string {
  if (!(error instanceof ApiFailure)) return 'The assistant could not answer. Try again.'
  if (error.reason === 'network') return 'The assistant could not reach the backend. Check that it is running, then try again.'
  if (error.reason === 'timeout') return 'The assistant took too long to answer. Try again.'
  if (error.reason === 'shape') return 'The backend sent a reply the assistant could not read. Nothing is shown, because it could not be read reliably.'
  if (error.status === 401) return error.serverMessage || 'Sign in with GitHub to use the assistant.'
  if (error.status === 404 || error.status === 405) return 'This backend has no assistant yet. Update and restart the backend, then try again.'
  if (error.status === 400 || error.status === 413 || error.status === 422) return error.serverMessage || 'The assistant could not accept this question.'
  return `The assistant failed to answer (status ${error.status ?? 'unknown'}). Try again.`
}
