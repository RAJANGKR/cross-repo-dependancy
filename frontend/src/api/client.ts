import { API_URL, MOCK_DELAY_MS, REQUEST_TIMEOUT_MS, USE_MOCK } from '../config'
import { ApiFailure, extractServerMessage } from './errors'
import { emptyMockReport, mockReport, partialMockReport } from './mockReport'
import { parseReport, ReportShapeError } from './parseReport'
import type { AnalyzeRequest, Health, Report } from './types'

/**
 * The only module that touches the network. Components reach it through the
 * `useAnalysis` hook. Request bodies are never logged or stored here: pasted
 * manifest content exists only in the POST /api/analyze body.
 */

export const MOCK_VARIANTS = ['error400', 'ratelimit', 'offline', 'empty', 'partial'] as const
export type MockVariant = (typeof MOCK_VARIANTS)[number]

export interface RequestOptions {
  signal?: AbortSignal
}

export interface ApiClient {
  analyze(payload: AnalyzeRequest, options?: RequestOptions): Promise<Report>
  getDemo(options?: RequestOptions): Promise<Report>
  getHealth(options?: RequestOptions): Promise<Health>
}

export interface ApiClientConfig {
  apiUrl: string
  useMock: boolean
  timeoutMs: number
  mockDelayMs: number
  fetchImpl: typeof fetch
  /** Dev-only: which mock scenario to play. Ignored when `useMock` is false. */
  getMockVariant: () => MockVariant | null
}

export const BUNDLED_DEMO_WARNING = 'Backend unreachable, showing the bundled demo data'

/** Reads the dev-only `?mock=` switch from the current URL. */
export function readMockVariant(search: string): MockVariant | null {
  const value = new URLSearchParams(search).get('mock')
  return (MOCK_VARIANTS as readonly string[]).includes(value ?? '') ? (value as MockVariant) : null
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiFailure('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ApiFailure('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  const { apiUrl, useMock, timeoutMs, mockDelayMs, fetchImpl, getMockVariant } = config

  async function mockAnalyze(options?: RequestOptions): Promise<Report> {
    await wait(mockDelayMs, options?.signal)
    switch (getMockVariant()) {
      case 'error400':
        throw new ApiFailure('http', {
          status: 400,
          serverMessage: 'Repository example-org/private-api was not found or is private.',
        })
      case 'ratelimit':
        throw new ApiFailure('http', {
          status: 429,
          serverMessage: 'GitHub API rate limit reached. Retry later or paste manifests instead.',
        })
      case 'offline':
        throw new ApiFailure('network')
      case 'empty':
        return emptyMockReport()
      case 'partial':
        return partialMockReport()
      default:
        return mockReport
    }
  }

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

    const transportFailure = () =>
      new ApiFailure(timedOut ? 'timeout' : external?.aborted ? 'aborted' : 'network')

    try {
      let response: Response
      let text: string
      try {
        response = await fetchImpl(`${apiUrl}${path}`, { ...init, signal: controller.signal })
        text = await response.text()
      } catch {
        throw transportFailure()
      }

      let body: unknown = null
      let isJson = true
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        isJson = false
      }

      if (!response.ok) {
        throw new ApiFailure('http', {
          status: response.status,
          serverMessage: extractServerMessage(body),
        })
      }
      if (!isJson) throw new ApiFailure('shape')
      return body
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }

  function toReport(body: unknown): Report {
    try {
      return parseReport(body)
    } catch (error) {
      if (error instanceof ReportShapeError) throw new ApiFailure('shape')
      throw error
    }
  }

  return {
    async analyze(payload, options) {
      if (useMock) return mockAnalyze(options)
      const body = await request(
        '/api/analyze',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        options,
      )
      return toReport(body)
    },

    async getDemo(options) {
      if (useMock) {
        await wait(mockDelayMs, options?.signal)
        return mockReport
      }
      try {
        const report = toReport(await request('/api/demo', { method: 'GET' }, options))
        // Whatever the backend says, this endpoint only ever serves demo data.
        return { ...report, meta: { ...report.meta, source: 'demo' } }
      } catch (error) {
        // The demo must still open with the network off. The bundled report is
        // labeled as demo data and says where it came from.
        if (error instanceof ApiFailure && error.reason === 'network') {
          return { ...mockReport, warnings: [BUNDLED_DEMO_WARNING, ...mockReport.warnings] }
        }
        throw error
      }
    },

    async getHealth(options) {
      if (useMock) return { status: 'ok', mock: true }
      const body = await request('/api/health', { method: 'GET' }, options)
      const status =
        typeof body === 'object' && body !== null ? (body as Record<string, unknown>).status : null
      if (typeof status !== 'string') throw new ApiFailure('shape')
      return { status, mock: false }
    },
  }
}

const client = createApiClient({
  apiUrl: API_URL,
  useMock: USE_MOCK,
  timeoutMs: REQUEST_TIMEOUT_MS,
  mockDelayMs: MOCK_DELAY_MS,
  fetchImpl: (input, init) => fetch(input, init),
  getMockVariant: () => (typeof window === 'undefined' ? null : readMockVariant(window.location.search)),
})

export const analyze = client.analyze
export const getDemo = client.getDemo
export const getHealth = client.getHealth
