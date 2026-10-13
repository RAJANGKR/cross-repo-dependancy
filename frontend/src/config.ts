const env = import.meta.env

/** Base URL of the backend, without a trailing slash. */
export const API_URL: string = (env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/+$/, '')

/** Mock mode is the default; only the literal string "false" turns it off. */
export const USE_MOCK: boolean = (env.VITE_USE_MOCK ?? 'true') !== 'false'

export const REQUEST_TIMEOUT_MS = 120_000
export const MOCK_DELAY_MS = 1_500
export const MAX_PROJECTS = 10
export const MAX_PASTED_FILE_BYTES = 200 * 1024

/** Below this many remaining GitHub API calls the UI shows a gentle warning. */
export const RATE_LIMIT_LOW_THRESHOLD = 10
