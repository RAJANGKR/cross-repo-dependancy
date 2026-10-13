const ECOSYSTEM_LABELS: Record<string, string> = { npm: 'npm', python: 'Python', pypi: 'Python' }

export function ecosystemLabel(ecosystem: string): string {
  return ECOSYSTEM_LABELS[ecosystem.toLowerCase()] ?? (ecosystem || 'Unknown')
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Time not available'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Time not available'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'Duration not available'
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(1)} s`
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** Only https links are ever rendered from API text. */
export function safeHttpsUrl(url: string | null): string | null {
  return url && url.startsWith('https://') ? url : null
}

/** Host name of a link, for showing where release notes came from. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** "PAYMENT_SERVICE_DOWN" or "removed_operation" -> "Removed operation". */
export function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
}

export const NOT_AVAILABLE = 'Not available'
