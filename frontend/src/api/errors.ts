import { ReportShapeError } from './parseReport'

export type ApiFailureReason = 'http' | 'network' | 'timeout' | 'shape' | 'aborted'

/** The single error type thrown by the API client. */
export class ApiFailure extends Error {
  readonly reason: ApiFailureReason
  readonly status: number | null
  readonly serverMessage: string

  constructor(reason: ApiFailureReason, options: { status?: number; serverMessage?: string } = {}) {
    super(options.serverMessage || `API request failed (${reason})`)
    this.name = 'ApiFailure'
    this.reason = reason
    this.status = options.status ?? null
    this.serverMessage = options.serverMessage ?? ''
  }
}

export type UiErrorKind =
  | 'bad-request'
  | 'rate-limited'
  | 'unreachable'
  | 'timeout'
  | 'unexpected-response'
  | 'server-error'

export type UiErrorAction = 'retry' | 'switch-to-paste-tab' | 'load-demo' | 'edit-input'

export interface UiError {
  kind: UiErrorKind
  title: string
  message: string
  actions: UiErrorAction[]
}

const RATE_LIMIT_PATTERN = /rate.?limit/i

/** True when the request was cancelled by the user; this is not an error state. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ApiFailure && error.reason === 'aborted'
}

/** Pulls a human-readable message out of a FastAPI-style or contract-style error body. */
export function extractServerMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const record = body as Record<string, unknown>
  for (const key of ['message', 'detail', 'error'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  // FastAPI validation errors: { detail: [{ msg: "..." }, ...] }
  if (Array.isArray(record.detail)) {
    const messages = record.detail
      .map((item) =>
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>).msg : null,
      )
      .filter((msg): msg is string => typeof msg === 'string')
    return messages.join('. ')
  }
  return ''
}

const UNEXPECTED_RESPONSE: UiError = {
  kind: 'unexpected-response',
  title: 'Unexpected response',
  message:
    'The backend replied, but not in the format DriftLock expects. Nothing is shown because the result could not be read reliably.',
  actions: ['retry', 'load-demo'],
}

/** Maps anything thrown by the API client to a state the UI can render. */
export function toUiError(error: unknown): UiError {
  if (error instanceof ReportShapeError) return UNEXPECTED_RESPONSE
  if (!(error instanceof ApiFailure)) return UNEXPECTED_RESPONSE

  const { reason, status, serverMessage } = error

  if (reason === 'shape') return UNEXPECTED_RESPONSE

  if (reason === 'timeout') {
    return {
      kind: 'timeout',
      title: 'Analysis timed out',
      message:
        'The backend did not finish within 2 minutes. Try again with fewer projects, or load the demo run.',
      actions: ['retry', 'edit-input', 'load-demo'],
    }
  }

  if (reason === 'network' || reason === 'aborted') {
    return {
      kind: 'unreachable',
      title: 'Backend unreachable',
      message:
        'DriftLock could not reach the analysis server. Check that the backend is running, then retry.',
      actions: ['retry', 'load-demo'],
    }
  }

  if (status === 429 || RATE_LIMIT_PATTERN.test(serverMessage)) {
    return {
      kind: 'rate-limited',
      title: 'GitHub rate limit reached',
      message:
        serverMessage ||
        'GitHub is limiting requests from the backend right now. Wait a while, paste manifests instead, or load the demo run.',
      actions: ['load-demo', 'switch-to-paste-tab', 'retry'],
    }
  }

  if (status === 400 || status === 422) {
    return {
      kind: 'bad-request',
      title: 'Check your input',
      message: serverMessage || 'The backend rejected this input without giving a reason.',
      actions: ['edit-input', 'switch-to-paste-tab'],
    }
  }

  return {
    kind: 'server-error',
    title: 'Analysis failed',
    message: serverMessage || `The backend returned an error (HTTP ${status ?? 'unknown'}).`,
    actions: ['retry', 'load-demo'],
  }
}
