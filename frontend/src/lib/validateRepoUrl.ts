const PREFIX = 'https://github.com/'
const SEGMENT = /^[A-Za-z0-9._-]+$/

export interface ParsedRepo {
  /** `https://github.com/{owner}/{repo}`, without a branch. */
  url: string
  owner: string
  repo: string
  /** Branch, tag or commit from a /tree/ link. May contain slashes. */
  ref: string | null
  /** Case-insensitive identity of the repository, used to block duplicates. */
  key: string
}

/**
 * Accepts only `https://github.com/{owner}/{repo}` with an optional
 * `/tree/{ref...}`. Returns null for anything else: other hosts, http, extra
 * paths such as /blob/ or /issues, or an empty owner or repo.
 */
export function parseRepoUrl(input: string): ParsedRepo | null {
  let value = input.trim()
  if (!value.startsWith(PREFIX)) return null
  if (/[\s?#]/.test(value)) return null

  if (value.endsWith('/')) value = value.slice(0, -1)
  const parts = value.slice(PREFIX.length).split('/')
  const owner = parts[0] ?? ''
  let repo = parts[1] ?? ''
  let ref: string | null = null

  if (parts.length === 2) {
    if (repo.endsWith('.git')) repo = repo.slice(0, -4)
  } else {
    if (parts[2] !== 'tree' || parts.length < 4) return null
    const refParts = parts.slice(3)
    if (refParts.some((part) => part === '')) return null
    ref = refParts.join('/')
  }

  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null
  if (repo === '.' || repo === '..' || owner === '.' || owner === '..') return null

  return {
    url: `${PREFIX}${owner}/${repo}`,
    owner,
    repo,
    ref,
    key: `${owner}/${repo}`.toLowerCase(),
  }
}

export interface RepoInput {
  label: string
  url: string
}

export interface RepoInputValidation {
  /** One entry per input: an error sentence, or null when the field is fine. */
  errors: Array<string | null>
  parsed: Array<ParsedRepo | null>
  valid: boolean
}

export const REPO_ERRORS = {
  missing: 'Enter a GitHub repository URL',
  malformed: 'Use a public repository URL such as https://github.com/owner/repo',
  duplicate: 'This repository is already listed above',
} as const

/** Validates the repository fields together: missing, malformed and duplicate. */
export function validateRepoInputs(inputs: readonly RepoInput[]): RepoInputValidation {
  const parsed = inputs.map((input) => (input.url.trim() === '' ? null : parseRepoUrl(input.url)))
  const seen = new Set<string>()
  const errors = inputs.map((input, index) => {
    if (input.url.trim() === '') return REPO_ERRORS.missing
    const repo = parsed[index]
    if (!repo) return REPO_ERRORS.malformed
    if (seen.has(repo.key)) return REPO_ERRORS.duplicate
    seen.add(repo.key)
    return null
  })
  return { errors, parsed, valid: errors.every((error) => error === null) }
}
