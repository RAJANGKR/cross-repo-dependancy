import { describe, expect, it, vi } from 'vitest'
import { createDemoClient, demoRecord } from './demoScan'
import { ApiFailure, toUiError } from './errors'
import { runScan, type RunScanOptions, type ScanUpdate } from './runScan'
import type { ScanClient } from './scanClient'
import type { ScanCreateRequest, ScanRecord } from './scanTypes'

const request: ScanCreateRequest = {
  repository_targets: [
    { type: 'github', url: 'https://github.com/example-org/payment-service' },
    { type: 'github', url: 'https://github.com/example-org/core-service' },
    { type: 'github', url: 'https://github.com/example-org/customer-service' },
  ],
}

function options(overrides: Partial<RunScanOptions> = {}): RunScanOptions & { updates: ScanUpdate[] } {
  const updates: ScanUpdate[] = []
  return {
    updates,
    signal: new AbortController().signal,
    onUpdate: (update) => updates.push(update),
    pollIntervalMs: 0,
    timeoutMs: 60_000,
    maxPollFailures: 3,
    sleep: () => Promise.resolve(),
    ...overrides,
  }
}

function inProgress(status: string): ScanRecord {
  return { ...demoRecord(), status, completed_at: null, duration_seconds: null, result: null }
}

/** A client that answers polls from a scripted list, repeating the last entry. */
function scripted(polls: Array<ScanRecord | ApiFailure>): ScanClient & { getScan: ReturnType<typeof vi.fn> } {
  let index = 0
  return {
    createScan: async () => ({
      kind: 'accepted',
      accepted: { scan_id: 'scn_1', status: 'QUEUED', poll_url: '/api/v1/scans/scn_1' },
    }),
    getScan: vi.fn(async () => {
      const next = polls[Math.min(index, polls.length - 1)]
      index += 1
      if (next instanceof ApiFailure) throw next
      if (!next) throw new Error('script is empty')
      return next
    }),
    getHealth: async () => ({ status: 'ok' }),
  }
}

async function failureOf(promise: Promise<unknown>): Promise<ApiFailure> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  )
  if (!(error instanceof ApiFailure)) throw new Error('Expected an ApiFailure')
  return error
}

describe('runScan', () => {
  it('walks QUEUED, FETCHING, PARSING, ANALYZING and returns the completed record', async () => {
    const run = options()
    const record = await runScan(createDemoClient(), request, run)

    expect(record.status).toBe('COMPLETED')
    expect(record.result?.drift_matrix.length).toBeGreaterThan(0)
    expect(run.updates.map((update) => update.status)).toEqual([
      'QUEUED',
      'FETCHING',
      'PARSING',
      'ANALYZING',
      'COMPLETED',
    ])
    expect(run.updates[1]?.progress?.percentage).toBe(25)
  })

  it('stops polling once the scan is terminal', async () => {
    const client = scripted([inProgress('FETCHING'), demoRecord(), demoRecord()])
    await runScan(client, request, options())
    expect(client.getScan).toHaveBeenCalledTimes(2)
  })

  it('reports a FAILED scan with the backend message and stops', async () => {
    const failed: ScanRecord = {
      ...inProgress('FAILED'),
      error: { error_code: 'SCAN_FAILED', message: 'Unexpected failure during dependency graph generation.' },
    }
    const client = scripted([inProgress('ANALYZING'), failed])
    const failure = await failureOf(runScan(client, request, options()))

    expect(failure.reason).toBe('scan-failed')
    expect(toUiError(failure)).toMatchObject({ kind: 'scan-failed', code: 'SCAN_FAILED' })
    expect(toUiError(failure).message).toContain('dependency graph')
    expect(client.getScan).toHaveBeenCalledTimes(2)
  })

  it('keeps a partial result instead of treating it as a failure', async () => {
    const record = await runScan(createDemoClient('partial'), request, options())
    expect(record.status).toBe('COMPLETED')
    expect(record.result?.warnings.length).toBeGreaterThan(0)
    expect(record.result?.scanned_repositories.some((repo) => repo.manifest_count === 0)).toBe(true)
    expect(record.result?.drift_matrix.length).toBeGreaterThan(0)
  })

  it('stops when the scan record is missing', async () => {
    const failure = await failureOf(runScan(createDemoClient('notfound'), request, options()))
    expect(toUiError(failure).kind).toBe('scan-not-found')
  })

  it('retries a dropped poll and still completes', async () => {
    const client = scripted([new ApiFailure('network'), inProgress('PARSING'), new ApiFailure('timeout'), demoRecord()])
    const record = await runScan(client, request, options())
    expect(record.status).toBe('COMPLETED')
    expect(client.getScan).toHaveBeenCalledTimes(4)
  })

  it('gives up after repeated network failures', async () => {
    const client = scripted([new ApiFailure('network')])
    const failure = await failureOf(runScan(client, request, options({ maxPollFailures: 3 })))
    expect(toUiError(failure).kind).toBe('unreachable')
    expect(client.getScan).toHaveBeenCalledTimes(3)
  })

  it('times out when no terminal status arrives', async () => {
    let clock = 0
    const failure = await failureOf(
      runScan(
        createDemoClient('timeout'),
        request,
        options({ timeoutMs: 5_000, now: () => clock, sleep: async () => void (clock += 2_000) }),
      ),
    )
    expect(failure.reason).toBe('timeout')
  })

  it('does not poll when submission fails', async () => {
    for (const [variant, kind] of [
      ['error400', 'bad-request'],
      ['ratelimit', 'rate-limited'],
      ['offline', 'unreachable'],
    ] as const) {
      const failure = await failureOf(runScan(createDemoClient(variant), request, options()))
      expect(toUiError(failure).kind).toBe(kind)
    }
  })

  it('accepts a synchronous record from the submit call without polling', async () => {
    const client = scripted([demoRecord()])
    client.createScan = async () => ({ kind: 'record', record: demoRecord() })
    const record = await runScan(client, request, options())
    expect(record.status).toBe('COMPLETED')
    expect(client.getScan).not.toHaveBeenCalled()
  })

  it('rejects a COMPLETED record that has no result', async () => {
    const client = scripted([{ ...demoRecord(), result: null }])
    expect((await failureOf(runScan(client, request, options()))).reason).toBe('shape')
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const client = scripted([inProgress('FETCHING')])
    const pending = runScan(
      client,
      request,
      options({
        signal: controller.signal,
        sleep: (_ms, signal) =>
          signal.aborted ? Promise.reject(new ApiFailure('aborted')) : Promise.resolve(controller.abort()),
      }),
    )
    expect((await failureOf(pending)).reason).toBe('aborted')
  })
})
