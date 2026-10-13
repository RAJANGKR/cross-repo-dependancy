import { useEffect, useState } from 'react'
import { createScanClient } from '../api/scanClient'
import { API_BASE_URL, USE_MOCK } from '../config'

export type BackendHealth = 'checking' | 'online' | 'unreachable' | 'mock'

/** Checks `GET /health` once so the input screen can say whether the backend is up. */
export function useBackendHealth(): BackendHealth {
  const [health, setHealth] = useState<BackendHealth>(USE_MOCK ? 'mock' : 'checking')

  useEffect(() => {
    if (USE_MOCK) return
    const controller = new AbortController()
    const client = createScanClient({
      baseUrl: API_BASE_URL,
      timeoutMs: 5_000,
      fetchImpl: (input, init) => fetch(input, init),
    })
    client.getHealth({ signal: controller.signal }).then(
      () => setHealth('online'),
      () => {
        if (!controller.signal.aborted) setHealth('unreachable')
      },
    )
    return () => controller.abort()
  }, [])

  return health
}
