const env = import.meta.env

/**
 * Base URL of the backend, without a trailing slash. `VITE_API_BASE_URL` is
 * the documented name; `VITE_API_URL` is still read so older .env files work.
 * This is the only backend configuration. No secrets belong in the frontend.
 */
export const API_BASE_URL: string = (
  env.VITE_API_BASE_URL ??
  env.VITE_API_URL ??
  'http://localhost:8000'
).replace(/\/+$/, '')

/**
 * Mock mode routes "Analyze repositories" through the bundled demo scan
 * instead of the backend, and labels everything "Demo data". Off by default:
 * only the literal string "true" turns it on.
 */
export const USE_MOCK: boolean = env.VITE_USE_MOCK === 'true'

/** A scan compares between this many targets (GitHub repositories plus pasted projects). */
export const MIN_REPOS = 2
export const MAX_REPOS = 10
/** Rows shown on a fresh form. */
export const INITIAL_REPO_ROWS = 3
export const MAX_PASTED_FILE_BYTES = 200 * 1024

export const REQUEST_TIMEOUT_MS = 20_000
export const POLL_INTERVAL_MS = 1_500
/** Polling gives up after this long without a terminal status. */
export const SCAN_TIMEOUT_MS = 180_000
/** Consecutive failed polls tolerated before the scan is reported unreachable. */
export const MAX_POLL_FAILURES = 3
export const DEMO_POLL_INTERVAL_MS = 700
