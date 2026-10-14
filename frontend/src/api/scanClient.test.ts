import { describe, expect, it, vi } from 'vitest'
import { demoRecord } from './demoScan'
import { ApiFailure, extractServerError, isCancelled, toUiError } from './errors'
import { parseScanAccepted, parseScanRecord, ScanShapeError } from './parseScan'
import { runScan, type ScanUpdate } from './runScan'
import { createSavedDemoClient, createScanClient, pollPathFor } from './scanClient'
import type { ScanCreateRequest } from './scanTypes'
// The scan the backend actually serves at GET /api/v1/demo, read from the backend's own file.
import savedDemo from '../../../backend/demo/demo_scan.json'

const request: ScanCreateRequest = {
  repository_targets: [{ type: 'github', url: 'https://github.com/example-org/core-service', ref: 'main' }],
}

function client(fetchImpl: typeof fetch, timeoutMs = 1_000) {
  return createScanClient({ baseUrl: 'http://backend.test', timeoutMs, fetchImpl })
}

function json(body: unknown, status = 200): Response {
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

const accepted = { scan_id: 'scn_a1', status: 'QUEUED', poll_url: '/api/v1/scans/scn_a1' }

describe('scan client', () => {
  it('posts repository_targets to /api/v1/scans and reads the 202 receipt', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ ...accepted, created_at: 'x' }, 202)))
    const submission = await client(fetchImpl).createScan(request)

    expect(submission).toEqual({ kind: 'accepted', accepted })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://backend.test/api/v1/scans')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(JSON.stringify(request))
  })

  it('polls the poll_url from the receipt', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(demoRecord())))
    const record = await client(fetchImpl).getScan(accepted)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://backend.test/api/v1/scans/scn_a1')
    expect(record.status).toBe('COMPLETED')
  })

  it('surfaces the contract error body', async () => {
    const body = { error_code: 'INVALID_TARGETS', message: 'A scan must contain between 1 and 3 repository targets.' }
    const failure = await failureOf(client(() => Promise.resolve(json(body, 400))).createScan(request))
    expect(failure.status).toBe(400)
    expect(failure.errorCode).toBe('INVALID_TARGETS')
    expect(toUiError(failure)).toMatchObject({ kind: 'bad-request', message: body.message })
  })

  it('maps network failure, invalid JSON, wrong shape and timeout', async () => {
    const network = () => Promise.reject(new TypeError('Failed to fetch'))
    expect((await failureOf(client(network).createScan(request))).reason).toBe('network')

    const html = () => Promise.resolve(new Response('<html>', { status: 200 }))
    expect((await failureOf(client(html).createScan(request))).reason).toBe('shape')

    const wrong = () => Promise.resolve(json({ scanned_repos: [], drift_matrix: [] }))
    expect((await failureOf(client(wrong).getScan(accepted))).reason).toBe('shape')

    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    expect((await failureOf(client(hang, 10).createScan(request))).reason).toBe('timeout')
  })

  it('reads /health', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ status: 'healthy' })))
    await expect(client(fetchImpl).getHealth()).resolves.toEqual({ status: 'healthy' })
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://backend.test/health')
  })
})

describe('pollPathFor', () => {
  it('uses a relative poll_url and refuses anything that leaves the backend', () => {
    expect(pollPathFor(accepted)).toBe('/api/v1/scans/scn_a1')
    expect(pollPathFor({ ...accepted, poll_url: null })).toBe('/api/v1/scans/scn_a1')
    expect(pollPathFor({ ...accepted, poll_url: 'https://evil.test/x' })).toBe('/api/v1/scans/scn_a1')
    expect(pollPathFor({ ...accepted, poll_url: '//evil.test/x' })).toBe('/api/v1/scans/scn_a1')
    expect(pollPathFor({ scan_id: 'a/b', status: 'QUEUED', poll_url: null })).toBe('/api/v1/scans/a%2Fb')
  })
})

describe('parseScan', () => {
  it('round-trips the demo record through JSON', () => {
    expect(parseScanRecord(JSON.parse(JSON.stringify(demoRecord())))).toEqual(demoRecord())
  })

  it('reads the in-progress example from the API contract', () => {
    const record = parseScanRecord({
      scan_id: 'scn_a1b2c3d4e5f6',
      status: 'ANALYZING',
      created_at: '2026-10-13T12:01:00.000Z',
      updated_at: '2026-10-13T12:01:05.000Z',
      progress: { stage: 'ANALYZING', percentage: 75, current_action: 'Evaluating SemVer disparity' },
      result: null,
    })
    expect(record.result).toBeNull()
    expect(record.progress).toEqual({ stage: 'ANALYZING', percentage: 75, current_action: 'Evaluating SemVer disparity' })
  })

  it('keeps absent optional fields as null instead of inventing values', () => {
    const record = parseScanRecord({
      scan_id: 's',
      status: 'COMPLETED',
      result: {
        drift_matrix: [
          {
            dependency_name: 'react',
            ecosystem: 'npm',
            declarations_by_repo: { a: { declared_range: '^18.2.0', source_file: 'package.json' } },
          },
        ],
      },
    })
    const result = record.result
    const row = result?.drift_matrix[0]
    expect(result?.summary).toBeNull()
    expect(result?.graph_summary).toBeNull()
    expect(result?.contract_analysis).toBeNull()
    expect(result?.code_impact).toBeNull()
    expect(result?.scanned_repositories).toEqual([])
    expect(row?.declarations_by_repo.a?.resolved_version).toBeNull()
    expect(row?.evidence).toBeNull()
    expect(row?.recommended_version).toBeNull()
    expect(row?.drift_disparity).toBe('')
    expect(row?.present_in_repos).toEqual(['a'])
    expect(record.duration_seconds).toBeNull()
  })

  it('keeps an unrecognized classification as the backend sent it', () => {
    const record = parseScanRecord({
      scan_id: 's',
      status: 'COMPLETED',
      result: { drift_matrix: [{ dependency_name: 'x', ecosystem: 'npm', drift_disparity: 'PATCH_DRIFT' }] },
    })
    expect(record.result?.drift_matrix[0]?.drift_disparity).toBe('PATCH_DRIFT')
  })

  it('rejects records it cannot identify', () => {
    expect(() => parseScanRecord({ status: 'COMPLETED' })).toThrow(ScanShapeError)
    expect(() => parseScanRecord({ scan_id: 's' })).toThrow(ScanShapeError)
    expect(() => parseScanAccepted({ status: 'QUEUED' })).toThrow(ScanShapeError)
    expect(() =>
      parseScanRecord({ scan_id: 's', status: 'COMPLETED', result: { drift_matrix: [{ ecosystem: 'npm' }] } }),
    ).toThrow(ScanShapeError)
  })
})

describe('error mapping', () => {
  it('maps each failure to the right state', () => {
    const kindOf = (failure: ApiFailure) => toUiError(failure).kind
    expect(kindOf(new ApiFailure('http', { status: 429 }))).toBe('rate-limited')
    expect(kindOf(new ApiFailure('http', { status: 502, serverMessage: 'GitHub rate limit exceeded' }))).toBe('rate-limited')
    expect(kindOf(new ApiFailure('http', { status: 404, errorCode: 'SCAN_NOT_FOUND' }))).toBe('scan-not-found')
    expect(kindOf(new ApiFailure('http', { status: 404 }))).toBe('endpoint-missing')
    expect(kindOf(new ApiFailure('http', { status: 422 }))).toBe('bad-request')
    expect(kindOf(new ApiFailure('http', { status: 500 }))).toBe('server-error')
    expect(kindOf(new ApiFailure('network'))).toBe('unreachable')
    expect(kindOf(new ApiFailure('timeout'))).toBe('timeout')
    expect(kindOf(new ApiFailure('shape'))).toBe('unexpected-response')
    expect(toUiError(new TypeError('boom')).kind).toBe('unexpected-response')
  })

  it('offers retry on every error', () => {
    for (const reason of ['network', 'timeout', 'shape', 'scan-failed'] as const) {
      expect(toUiError(new ApiFailure(reason)).actions).toContain('retry')
    }
  })

  it('reads contract and FastAPI error bodies', () => {
    expect(extractServerError({ error_code: 'X', message: 'a' })).toEqual({ errorCode: 'X', serverMessage: 'a' })
    expect(extractServerError({ detail: 'b' }).serverMessage).toBe('b')
    expect(extractServerError({ detail: [{ msg: 'c' }, { msg: 'd' }] }).serverMessage).toBe('c. d')
    expect(extractServerError(null)).toEqual({ errorCode: '', serverMessage: '' })
    expect(isCancelled(new ApiFailure('aborted'))).toBe(true)
    expect(isCancelled(new ApiFailure('network'))).toBe(false)
  })
})

describe('saved demo run', () => {
  const config = (fetchImpl: typeof fetch) => ({ baseUrl: 'http://backend.test', timeoutMs: 1_000, fetchImpl })
  const run = (fetchImpl: typeof fetch, updates: ScanUpdate[] = []) =>
    runScan(createSavedDemoClient(config(fetchImpl)), { repository_targets: [] }, {
      signal: new AbortController().signal,
      onUpdate: (update) => updates.push(update),
      pollIntervalMs: 1,
      timeoutMs: 1_000,
      maxPollFailures: 1,
    })

  it('requests GET /api/v1/demo and reads the saved record with the scan parser', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(savedDemo)))
    const record = await client(fetchImpl).getDemo()

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://backend.test/api/v1/demo')
    expect(init?.method).toBe('GET')
    expect(record).toEqual(parseScanRecord(savedDemo))
    expect(record.status).toBe('COMPLETED')
    expect(record.result?.scanned_repositories.map((repo) => repo.name)).toEqual(savedDemo.result.scanned_repositories.map((repo) => repo.name))
    expect(record.result?.drift_matrix.map((row) => row.dependency_name)).toEqual(savedDemo.result.drift_matrix.map((row) => row.dependency_name))
  })

  it('goes through the run loop as a finished scan: one request, nothing submitted, no polling', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json(savedDemo)))
    const updates: ScanUpdate[] = []
    const record = await run(fetchImpl, updates)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(record.scan_id).toBe(savedDemo.scan_id)
    expect(updates.map((update) => [update.scanId, update.status])).toEqual([[savedDemo.scan_id, 'COMPLETED']])
  })

  it('fails, instead of showing anything, when the backend has no saved run or cannot be reached', async () => {
    const missing = await failureOf(run(() => Promise.resolve(json({ error_code: 'DEMO_NOT_AVAILABLE', message: 'No saved demo run is available on this backend.', details: {} }, 404))))
    expect(missing).toMatchObject({ reason: 'http', status: 404, errorCode: 'DEMO_NOT_AVAILABLE', serverMessage: 'No saved demo run is available on this backend.' })
    const offline = await failureOf(run(() => Promise.reject(new TypeError('offline'))))
    expect(offline.reason).toBe('network')
  })

  it('refuses a saved record that is not a finished scan with a result', async () => {
    const unfinished = vi.fn<typeof fetch>(() => Promise.resolve(json({ ...savedDemo, status: 'ANALYZING', result: null })))
    expect((await failureOf(run(unfinished))).reason).toBe('shape')
    expect(unfinished).toHaveBeenCalledTimes(1)                                          // it is not polled as if it were a running scan
    expect((await failureOf(run(() => Promise.resolve(json({ ...savedDemo, result: null }))))).reason).toBe('shape')
    expect((await failureOf(run(() => Promise.resolve(new Response('<html>not json</html>', { status: 200 }))))).reason).toBe('shape')
    expect((await failureOf(run(() => Promise.resolve(json({ status: 'COMPLETED' }))))).reason).toBe('shape')
  })
})
