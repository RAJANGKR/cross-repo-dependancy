import { describe, expect, it } from 'vitest'
import { demoRecord } from '../api/demoScan'
import type { ScanResult } from '../api/scanTypes'
import { githubEditUrl } from './insights'

const base = demoRecord().result as ScanResult

function result(overrides: { url?: string | null; ref?: string | null; kind?: string } = {}): ScanResult {
  return {
    ...base,
    scanned_repositories: [{ name: 'service-a', url: overrides.url === undefined ? 'https://github.com/acme/service-a' : overrides.url, manifest_count: 1, total_dependencies: 1 }],
    repository_details: [
      { name: 'service-a', kind: overrides.kind ?? 'github', ref: overrides.ref === undefined ? 'main' : overrides.ref, commit: null, manifests: [], code_scanned: true, error: null },
    ],
  }
}

describe('githubEditUrl', () => {
  it('builds GitHub\'s edit page for the manifest on the branch that was scanned', () => {
    expect(githubEditUrl(result(), 'service-a', 'requirements.txt')).toBe('https://github.com/acme/service-a/edit/main/requirements.txt')
    expect(githubEditUrl(result({ ref: 'feature/upgrade-httpx' }), 'service-a', 'web/package.json')).toBe(
      'https://github.com/acme/service-a/edit/feature/upgrade-httpx/web/package.json',
    )
  })

  it('uses the repository, not a /tree/ sub-folder link, as the base', () => {
    const scoped = result({ url: 'https://github.com/acme/mono/tree/main/services/a' })
    expect(githubEditUrl(scoped, 'service-a', 'services/a/package.json')).toBe('https://github.com/acme/mono/edit/main/services/a/package.json')
  })

  it('encodes unusual characters instead of letting them change the URL', () => {
    expect(githubEditUrl(result({ ref: 'fix #12' }), 'service-a', 'my app/package.json')).toBe(
      'https://github.com/acme/service-a/edit/fix%20%2312/my%20app/package.json',
    )
  })

  it('offers no link when one cannot be trusted', () => {
    expect(githubEditUrl(result({ url: null }), 'service-a', 'package.json')).toBeNull() // pasted, no repository
    expect(githubEditUrl(result({ kind: 'pasted' }), 'service-a', 'package.json')).toBeNull()
    expect(githubEditUrl(result({ ref: null }), 'service-a', 'package.json')).toBeNull() // branch unknown
    expect(githubEditUrl(result({ url: 'https://gitlab.com/acme/service-a' }), 'service-a', 'package.json')).toBeNull()
    expect(githubEditUrl(result(), 'service-a', '')).toBeNull()
    expect(githubEditUrl(result(), 'service-a', '../../etc/passwd')).toBeNull()
    expect(githubEditUrl(result(), 'unknown-repo', 'package.json')).toBeNull()
  })
})
