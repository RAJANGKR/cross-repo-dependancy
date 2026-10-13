import { describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_DEMO_WARNING,
  createApiClient,
  readMockVariant,
  type ApiClientConfig,
  type MockVariant,
} from './client'
import { ApiFailure } from './errors'
import { emptyMockReport, mockReport, partialMockReport } from './mockReport'
import { parseReport, ReportShapeError } from './parseReport'
import type { AnalyzeRequest } from './types'

const payload: AnalyzeRequest = { repos: ['https://github.com/example-org/service-a'], pasted: [] }

function makeClient(overrides: Partial<ApiClientConfig> = {}) {
  return createApiClient({
    apiUrl: 'http://backend.test',
    useMock: true,
    timeoutMs: 1_000,
    mockDelayMs: 0,
    fetchImpl: () => Promise.reject(new Error('fetch must not be called in mock mode')),
    getMockVariant: () => null,
    ...overrides,
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ApiFailure)) throw new Error('Expected an ApiFailure')
  return error
}

describe('mock mode', () => {
  it('returns typed demo data without touching the network', async () => {
    const report = await makeClient().getDemo()
    expect(report.meta.source).toBe('demo')
    expect(report.drifts.length).toBeGreaterThanOrEqual(6)
    expect(report.summary.drifts).toBe(report.drifts.length)
  })

  it('labels analyze results as demo data', async () => {
    const report = await makeClient().analyze(payload)
    expect(report.meta.source).toBe('demo')
  })

  it.each<[MockVariant, number | null, string]>([
    ['error400', 400, 'http'],
    ['ratelimit', 429, 'http'],
    ['offline', null, 'network'],
  ])('plays the %s scenario', async (variant, status, reason) => {
    const failure = await failureOf(makeClient({ getMockVariant: () => variant }).analyze(payload))
    expect(failure.reason).toBe(reason)
    expect(failure.status).toBe(status)
  })

  it('plays the empty and partial scenarios', async () => {
    const empty = await makeClient({ getMockVariant: () => 'empty' }).analyze(payload)
    expect(empty.summary.drifts).toBe(0)
    const partial = await makeClient({ getMockVariant: () => 'partial' }).analyze(payload)
    expect(partial.repos.some((repo) => repo.status === 'error')).toBe(true)
  })

  it('can be cancelled', async () => {
    const controller = new AbortController()
    const pending = makeClient({ mockDelayMs: 5_000 }).analyze(payload, { signal: controller.signal })
    controller.abort()
    expect((await failureOf(pending)).reason).toBe('aborted')
  })
})

describe('real mode', () => {
  it('posts the payload to /api/analyze and parses the report', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(mockReport)))
    const report = await makeClient({ useMock: false, fetchImpl }).analyze(payload)

    expect(report.drifts).toHaveLength(mockReport.drifts.length)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://backend.test/api/analyze')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify(payload))
  })

  it('ignores the mock switch', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(mockReport)))
    const client = makeClient({ useMock: false, fetchImpl, getMockVariant: () => 'offline' })
    await expect(client.analyze(payload)).resolves.toBeDefined()
  })

  it('surfaces the backend message on HTTP 400', async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse({ detail: 'At most 10 projects' }, 400))
    const failure = await failureOf(makeClient({ useMock: false, fetchImpl }).analyze(payload))
    expect(failure.status).toBe(400)
    expect(failure.serverMessage).toBe('At most 10 projects')
  })

  it('reports a rejected fetch as a network failure', async () => {
    const fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'))
    const failure = await failureOf(makeClient({ useMock: false, fetchImpl }).analyze(payload))
    expect(failure.reason).toBe('network')
  })

  it('reports invalid JSON and wrong shapes as shape failures', async () => {
    const notJson = () => Promise.resolve(new Response('<html>', { status: 200 }))
    expect((await failureOf(makeClient({ useMock: false, fetchImpl: notJson }).analyze(payload))).reason).toBe(
      'shape',
    )
    const wrongShape = () => Promise.resolve(jsonResponse({ scan_id: 'scn_1', status: 'QUEUED' }))
    expect(
      (await failureOf(makeClient({ useMock: false, fetchImpl: wrongShape }).analyze(payload))).reason,
    ).toBe('shape')
  })

  it('times out', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    const failure = await failureOf(
      makeClient({ useMock: false, fetchImpl, timeoutMs: 10 }).analyze(payload),
    )
    expect(failure.reason).toBe('timeout')
  })

  it('falls back to the bundled demo, with a warning, when the backend is unreachable', async () => {
    const fetchImpl = () => Promise.reject(new TypeError('Failed to fetch'))
    const report = await makeClient({ useMock: false, fetchImpl }).getDemo()
    expect(report.meta.source).toBe('demo')
    expect(report.warnings[0]).toBe(BUNDLED_DEMO_WARNING)
  })

  it('reads /api/health', async () => {
    const fetchImpl = () => Promise.resolve(jsonResponse({ status: 'ok' }))
    await expect(makeClient({ useMock: false, fetchImpl }).getHealth()).resolves.toEqual({
      status: 'ok',
      mock: false,
    })
  })
})

describe('readMockVariant', () => {
  it('accepts known variants only', () => {
    expect(readMockVariant('?mock=ratelimit')).toBe('ratelimit')
    expect(readMockVariant('?mock=nonsense')).toBeNull()
    expect(readMockVariant('')).toBeNull()
  })
})

describe('parseReport', () => {
  it('round-trips every mock variant through JSON', () => {
    for (const report of [mockReport, emptyMockReport(), partialMockReport()]) {
      expect(parseReport(JSON.parse(JSON.stringify(report)))).toEqual(report)
    }
  })

  it('defaults missing optional fields instead of crashing', () => {
    const report = parseReport({
      meta: { source: 'live' },
      summary: {},
      repos: [{ name: 'a' }],
      graph: {},
      drifts: [{ id: 'npm:x', library: 'x', risk: 'Low', score: 5 }],
    })
    const drift = report.drifts[0]
    expect(drift?.evidence.changelog).toEqual([])
    expect(drift?.evidence.code_usage).toEqual({ import_map: [], hits: [], note: null })
    expect(drift?.explanation).toBeNull()
    expect(drift?.confidence).toBeNull()
    expect(report.summary.by_risk.Low).toBe(1)
    expect(report.repos[0]?.status).toBe('error')
    expect(report.skipped).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('rejects a report without a known source or with a drift missing its risk', () => {
    expect(() => parseReport({ meta: {}, summary: {}, repos: [], graph: {}, drifts: [] })).toThrow(
      ReportShapeError,
    )
    expect(() =>
      parseReport({
        meta: { source: 'live' },
        summary: {},
        repos: [],
        graph: {},
        drifts: [{ id: 'npm:x', library: 'x', score: 5 }],
      }),
    ).toThrow(ReportShapeError)
  })

  it('keeps the mock internally consistent', () => {
    const total = Object.values(mockReport.summary.by_risk).reduce((sum, count) => sum + count, 0)
    expect(total).toBe(mockReport.drifts.length)
    for (const drift of mockReport.drifts) {
      const sum = drift.breakdown.reduce((acc, item) => acc + item.points, 0)
      expect(drift.score).toBe(Math.max(0, sum))
      expect(mockReport.graph.nodes.some((node) => node.id === drift.id && node.drifted)).toBe(true)
    }
  })
})
