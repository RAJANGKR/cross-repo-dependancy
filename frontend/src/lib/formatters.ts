import type { CodeHit, RepoInfo } from '../api/types'

const ECOSYSTEM_LABELS: Record<string, string> = { npm: 'npm', pypi: 'PyPI', maven: 'Maven' }

export function ecosystemLabel(ecosystem: string): string {
  return ECOSYSTEM_LABELS[ecosystem.toLowerCase()] ?? (ecosystem || 'Unknown')
}

/** "pypi:pydantic" -> "pydantic"; "maven:group:artifact" -> "artifact". */
export function libraryLabel(id: string): string {
  const withoutEcosystem = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  const lastColon = withoutEcosystem.lastIndexOf(':')
  return lastColon === -1 ? withoutEcosystem : withoutEcosystem.slice(lastColon + 1)
}

export function ecosystemOfId(id: string): string {
  return id.includes(':') ? id.slice(0, id.indexOf(':')) : ''
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Time not available'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Time not available'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'Duration not available'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function formatConfidence(confidence: number | null): string {
  return confidence === null ? 'Not available' : confidence.toFixed(2)
}

export function formatPoints(points: number): string {
  return points > 0 ? `+${points}` : points < 0 ? `−${Math.abs(points)}` : '0'
}

export function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

export const LOW_CONFIDENCE_THRESHOLD = 0.5

const MISSING_SIGNAL_SENTENCES: Record<string, string> = {
  changelog:
    'No changelog found, so this result relies on version numbers and vulnerability data',
  vulnerabilities: 'Vulnerability data could not be checked for this library',
  osv: 'Vulnerability data could not be checked for this library',
  code_usage: 'The code-usage scan did not run, so there is no evidence from your source code',
  import_map: 'Import locations could not be mapped, so the blast radius is unknown',
  range_overlap: 'Version ranges could not be compared, so overlap was not taken into account',
  semver: 'A version could not be read as semver, so the size of the gap is uncertain',
  registry: 'The public registry had no data for this library',
}

/** Turns a `signals_missing` key into a plain sentence. */
export function missingSignalSentence(key: string): string {
  const known = MISSING_SIGNAL_SENTENCES[key.toLowerCase()]
  if (known) return known
  return `The "${key.replace(/_/g, ' ')}" signal was not available for this result`
}

/** Explains a `code_usage.note` or an unavailable scan in plain words. */
export function codeUsageNoteSentence(note: string): string {
  const lower = note.toLowerCase()
  if (lower.includes('pasted')) {
    return 'Scan unavailable for pasted input: there is no source code to read'
  }
  if (lower.includes('import mapping unavailable')) {
    return 'Import mapping was unavailable, so usage locations are not shown'
  }
  return note.charAt(0).toUpperCase() + note.slice(1)
}

export function isCandidateHit(hit: CodeHit): boolean {
  return hit.tier === 3 || hit.rule_status.toLowerCase() === 'candidate'
}

export type Tier = 1 | 2 | 3

export const TIER_LABELS: Record<Tier, string> = {
  1: 'Import map',
  2: 'Verified rule',
  3: 'Candidate rule',
}

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  2: 'Names confirmed in official docs.',
  3: 'AI-suggested names checked against the changelog.',
  1: 'Where the library is used, with no claim about what broke.',
}

/** "`validator` is deprecated, use `field_validator`". Status wording is verbatim. */
export function hitSentence(hit: CodeHit): string {
  const rule = hit.rule || 'This name'
  const status = hit.status || 'flagged'
  const base = `${rule} is ${status}`
  return hit.replacement ? `${base}, use ${hit.replacement}` : base
}

/** Only https links are ever rendered from API text. */
export function safeHttpsUrl(url: string | null): string | null {
  return url && url.startsWith('https://') ? url : null
}

const SAFE_OSV_ID = /^[A-Za-z0-9._-]+$/

export function osvUrl(id: string): string | null {
  return SAFE_OSV_ID.test(id) ? `https://osv.dev/vulnerability/${id}` : null
}

export function githubUrlOf(repo: RepoInfo): string | null {
  return repo.origin === 'github' && repo.url.startsWith('https://github.com/') ? repo.url : null
}

function numericParts(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/.exec(version.trim())
  return match?.[1] ? match[1].split('.').map(Number) : null
}

/** Numeric comparison of dotted versions. Unreadable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  if (!left || !right) return 0
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
