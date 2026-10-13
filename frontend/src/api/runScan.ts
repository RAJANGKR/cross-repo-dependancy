import { ApiFailure } from './errors'
import type { RequestOptions, ScanClient } from './scanClient'
import type { ScanAccepted, ScanCreateRequest, ScanProgress, ScanRecord } from './scanTypes'

export interface ScanUpdate {
  scanId: string
  status: string
  progress: ScanProgress | null
}

export interface RunScanOptions {
  signal: AbortSignal
  onUpdate: (update: ScanUpdate) => void
  pollIntervalMs: number
  /** Give up when no terminal status arrives within this time. */
  timeoutMs: number
  /** Consecutive failed polls tolerated before giving up. */
  maxPollFailures: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ApiFailure('aborted'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ApiFailure('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Returns the record when the scan is finished, or throws when it failed. */
function settle(record: ScanRecord): ScanRecord | null {
  if (record.status === 'FAILED') {
    throw new ApiFailure('scan-failed', {
      errorCode: record.error?.error_code,
      serverMessage: record.error?.message,
    })
  }
  if (record.status !== 'COMPLETED') return null
  // COMPLETED without a result cannot be shown as a successful scan.
  if (!record.result) throw new ApiFailure('shape')
  return record
}

/**
 * Runs one scan end to end: submits it, then polls until the status is
 * COMPLETED or FAILED. Polling stops on a terminal status, on cancel, on a
 * missing scan, on timeout, or after too many consecutive failed polls.
 * A single failed poll is retried, because one dropped request should not
 * throw away a scan that is still running.
 */
export async function runScan(
  client: ScanClient,
  request: ScanCreateRequest,
  options: RunScanOptions,
): Promise<ScanRecord> {
  const { signal, onUpdate, pollIntervalMs, timeoutMs, maxPollFailures } = options
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const requestOptions: RequestOptions = { signal }
  const startedAt = now()

  const submission = await client.createScan(request, requestOptions)
  let accepted: ScanAccepted
  if (submission.kind === 'record') {
    const { record } = submission
    onUpdate({ scanId: record.scan_id, status: record.status, progress: record.progress })
    const finished = settle(record)
    if (finished) return finished
    accepted = { scan_id: record.scan_id, status: record.status, poll_url: null }
  } else {
    accepted = submission.accepted
    onUpdate({ scanId: accepted.scan_id, status: accepted.status, progress: null })
  }

  let failures = 0
  for (;;) {
    await sleep(pollIntervalMs, signal)
    if (now() - startedAt > timeoutMs) throw new ApiFailure('timeout')

    let record: ScanRecord
    try {
      record = await client.getScan(accepted, requestOptions)
      failures = 0
    } catch (error) {
      const transient = error instanceof ApiFailure && (error.reason === 'network' || error.reason === 'timeout')
      if (!transient) throw error
      failures += 1
      if (failures >= maxPollFailures) throw error
      continue
    }

    onUpdate({ scanId: record.scan_id, status: record.status, progress: record.progress })
    const finished = settle(record)
    if (finished) return finished
  }
}
