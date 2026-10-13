import { ScanShapeError } from './parseScan'

export type ApiFailureReason =
  | 'http'
  | 'network'
  | 'timeout'
  | 'shape'
  | 'aborted'
  /** The scan reached the FAILED status. */
  | 'scan-failed'

/** The single error type thrown by the API layer. */
export class ApiFailure extends Error {
  readonly reason: ApiFailureReason
  readonly status: number | null
  readonly errorCode: string
  readonly serverMessage: string

  constructor(
    reason: ApiFailureReason,
    options: { status?: number; errorCode?: string; serverMessage?: string } = {},
  ) {
    super(options.serverMessage || `API request failed (${reason})`)
    this.name = 'ApiFailure'
    this.reason = reason
    this.status = options.status ?? null
    this.errorCode = options.errorCode ?? ''
    this.serverMessage = options.serverMessage ?? ''
  }
}

export type UiErrorKind =
  | 'bad-request'
  | 'rate-limited'
  | 'unreachable'
  | 'timeout'
  | 'unexpected-response'
  | 'scan-not-found'
  | 'scan-failed'
  | 'endpoint-missing'
  | 'server-error'

export type UiErrorAction = 'retry' | 'load-demo' | 'edit-input'

export interface UiError {
  kind: UiErrorKind
  title: string
  message: string
  /** Machine-readable code from the backend, when it sent one. */
  code: string
  actions: UiErrorAction[]
}

const RATE_LIMIT_PATTERN = /rate.?limit/i

/** True when the request was cancelled by the user; this is not an error state. */
export function isCancelled(error: unknown): boolean {
  return error instanceof ApiFailure && error.reason === 'aborted'
}

/** Reads `{ error_code, message }` (contract) or `{ detail }` (FastAPI default). */
export function extractServerError(body: unknown): { errorCode: string; serverMessage: string } {
  if (typeof body !== 'object' || body === null) return { errorCode: '', serverMessage: '' }
  const record = body as Record<string, unknown>
  const errorCode = typeof record.error_code === 'string' ? record.error_code : ''
  for (const key of ['message', 'detail', 'error'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return { errorCode, serverMessage: value.trim() }
  }
  // FastAPI validation errors: { detail: [{ msg: "..." }, ...] }
  if (Array.isArray(record.detail)) {
    const messages = record.detail
      .map((item) => (typeof item === 'object' && item !== null ? (item as Record<string, unknown>).msg : null))
      .filter((msg): msg is string => typeof msg === 'string')
    return { errorCode, serverMessage: messages.join('. ') }
  }
  return { errorCode, serverMessage: '' }
}

function unexpected(code = ''): UiError {
  return {
    kind: 'unexpected-response',
    title: 'Unexpected response',
    message:
      'The backend replied, but not in the format the scan contract describes. Nothing is shown because the result could not be read reliably.',
    code,
    actions: ['retry', 'load-demo'],
  }
}

/** Maps anything thrown by the API layer to a state the UI can render. */
export function toUiError(error: unknown): UiError {
  if (error instanceof ScanShapeError) return unexpected()
  if (!(error instanceof ApiFailure)) return unexpected()

  const { reason, status, errorCode: code, serverMessage } = error

  if (reason === 'shape') return unexpected(code)

  if (reason === 'scan-failed') {
    return {
      kind: 'scan-failed',
      title: 'Scan failed',
      message: serverMessage || 'The backend reported that this scan failed, without giving a reason.',
      code,
      actions: ['retry', 'edit-input', 'load-demo'],
    }
  }

  if (reason === 'timeout') {
    return {
      kind: 'timeout',
      title: 'Scan timed out',
      message:
        'The scan did not finish in time. It may still be running on the backend. Retry, or check that the repositories are reachable.',
      code,
      actions: ['retry', 'edit-input', 'load-demo'],
    }
  }

  if (reason === 'network' || reason === 'aborted') {
    return {
      kind: 'unreachable',
      title: 'Backend unreachable',
      message: 'DriftLock could not reach the backend. Check that it is running, then retry.',
      code,
      actions: ['retry', 'load-demo'],
    }
  }

  if (status === 429 || code === 'RATE_LIMIT_EXCEEDED' || RATE_LIMIT_PATTERN.test(serverMessage)) {
    return {
      kind: 'rate-limited',
      title: 'GitHub rate limit reached',
      message:
        serverMessage ||
        'GitHub is limiting requests from the backend. Wait a while, or set a GitHub token on the backend.',
      code,
      actions: ['retry', 'load-demo'],
    }
  }

  if (code === 'SCAN_NOT_FOUND') {
    return {
      kind: 'scan-not-found',
      title: 'Scan not found',
      message: serverMessage || 'This scan does not exist on the backend or has expired. Start a new scan.',
      code,
      actions: ['retry', 'edit-input'],
    }
  }

  if (status === 404 || status === 405) {
    return {
      kind: 'endpoint-missing',
      title: 'Scan endpoint not available',
      message:
        'The backend is running but does not serve the scan endpoint (POST /api/v1/scans) described in the API contract.',
      code,
      actions: ['retry', 'load-demo'],
    }
  }

  if (status === 401 || code === 'SIGN_IN_REQUIRED') {
    return {
      kind: 'bad-request',
      title: 'Sign in required',
      message: serverMessage || 'Sign in with GitHub to start a scan.',
      code,
      actions: ['edit-input'],
    }
  }

  if (status === 400 || status === 422) {
    return {
      kind: 'bad-request',
      title: 'The backend rejected these repositories',
      message: serverMessage || 'The backend rejected this request without giving a reason.',
      code,
      actions: ['edit-input', 'retry'],
    }
  }

  return {
    kind: 'server-error',
    title: 'Scan could not be completed',
    message: serverMessage || `The backend returned an error (HTTP ${status ?? 'unknown'}).`,
    code,
    actions: ['retry', 'load-demo'],
  }
}
