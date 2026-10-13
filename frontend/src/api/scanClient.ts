import { ApiFailure, extractServerError } from './errors'
import { parseScanAccepted, parseScanRecord, ScanShapeError } from './parseScan'
import type { Health, ScanAccepted, ScanCreateRequest, ScanRecord } from './scanTypes'

/**
 * The only module that talks to the backend. Endpoints and shapes follow
 * docs/API_CONTRACT.md:
 *   POST /api/v1/scans            -> 202 { scan_id, status, poll_url }
 *   GET  /api/v1/scans/{scan_id}  -> ScanRecord
 *   GET  /health
 */

export interface RequestOptions {
  signal?: AbortSignal
}

/** What `POST /api/v1/scans` can answer: a queued job, or a finished record. */
export type ScanSubmission = { kind: 'accepted'; accepted: ScanAccepted } | { kind: 'record'; record: ScanRecord }

export interface ScanClient {
  createScan(request: ScanCreateRequest, options?: RequestOptions): Promise<ScanSubmission>
  getScan(accepted: ScanAccepted, options?: RequestOptions): Promise<ScanRecord>
  getHealth(options?: RequestOptions): Promise<Health>
}

export interface ScanClientConfig {
  baseUrl: string
  timeoutMs: number
  fetchImpl: typeof fetch
}

/**
 * Path to poll for a scan. `poll_url` is used only when it is a path on the
 * configured backend; anything else falls back to the documented route, so a
 * response can never redirect polling to another host.
 */
export function pollPathFor(accepted: ScanAccepted): string {
  const pollUrl = accepted.poll_url
  if (pollUrl && pollUrl.startsWith('/') && !pollUrl.startsWith('//')) return pollUrl
  return `/api/v1/scans/${encodeURIComponent(accepted.scan_id)}`
}

export function createScanClient(config: ScanClientConfig): ScanClient {
  const { baseUrl, timeoutMs, fetchImpl } = config

  async function request(path: string, init: RequestInit, options?: RequestOptions): Promise<unknown> {
    const external = options?.signal
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
        response = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: controller.signal })
        text = await response.text()
      } catch {
        throw new ApiFailure(timedOut ? 'timeout' : external?.aborted ? 'aborted' : 'network')
      }

      let body: unknown = null
      let isJson = true
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        isJson = false
      }

      if (!response.ok) {
        throw new ApiFailure('http', { status: response.status, ...extractServerError(body) })
      }
      if (!isJson) throw new ApiFailure('shape')
      return body
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }

  function parse<T>(parser: (body: unknown) => T, body: unknown): T {
    try {
      return parser(body)
    } catch (error) {
      if (error instanceof ScanShapeError) throw new ApiFailure('shape')
      throw error
    }
  }

  return {
    async createScan(scanRequest, options) {
      const body = await request(
        '/api/v1/scans',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scanRequest),
        },
        options,
      )
      // With ?wait=true, or on a backend that answers synchronously, the body
      // is already a full record rather than a 202 receipt.
      const isRecord =
        typeof body === 'object' && body !== null && ('result' in body || 'progress' in body || 'completed_at' in body)
      return isRecord
        ? { kind: 'record', record: parse(parseScanRecord, body) }
        : { kind: 'accepted', accepted: parse(parseScanAccepted, body) }
    },

    async getScan(accepted, options) {
      return parse(parseScanRecord, await request(pollPathFor(accepted), { method: 'GET' }, options))
    },

    async getHealth(options) {
      const body = await request('/health', { method: 'GET' }, options)
      const status = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).status : null
      if (typeof status !== 'string') throw new ApiFailure('shape')
      return { status }
    },
  }
}
