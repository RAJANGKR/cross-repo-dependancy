import { describe, expect, it } from 'vitest'
import { demoRecord } from '../api/demoScan'
import { parseScanRecord } from '../api/parseScan'
import type { DependencyDrift, ScanResult } from '../api/scanTypes'
import { MAX_PASTED_FILE_BYTES } from '../config'
import { alreadyOnRecommended, computeKpis, diffScans, fixLine, fixPlan, fixPlanText, fixesFor, prDescription, priorityDrifts, repoHealth, teamMessage, toHistoryEntry } from './insights'
import { activeReview, emptyStore, sanitize, STORE_VERSION, type Review } from './localStore'
import { checkForm, detectManifest, newFile, newProject, newRow, ROW_ERRORS, toScanRequest, type PastedProject, type RepoRow } from './targets'

const result = demoRecord().result as ScanResult
const rows = result.drift_matrix
const find = (name: string) => rows.find((row) => row.dependency_name === name) as DependencyDrift
const row = (url: string, ref = '', label = ''): RepoRow => ({ ...newRow(0), url, ref, label })
const project = (name: string, content: string): PastedProject => ({ ...newProject(), name, files: [{ ...newFile(), content, filename: detectManifest(content) }] })
const review = (status: Review['status'], until: string | null = null): Review => ({ status, reason: '', note: '', assignee: '', until, updatedAt: '' })

describe('checkForm', () => {
  it('needs at least two targets and ignores empty rows', () => {
    expect(checkForm([row(''), row(''), row('')], []).blocked).toMatch(/at least 2/)
    expect(checkForm([row('https://github.com/a/one'), row('')], []).blocked).toMatch(/at least 2/)
    const ok = checkForm([row('https://github.com/a/one'), row(''), row('https://github.com/a/two.git/')], [])
    expect(ok.blocked).toBeNull()
    expect(ok.rowErrors).toEqual([null, null, null])
    expect(ok.targets.map((target) => target.url)).toEqual(['https://github.com/a/one', 'https://github.com/a/two'])
  })

  it('accepts up to ten targets and blocks the eleventh', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => row(`https://github.com/a/r${index}`))
    expect(checkForm(many(10), []).blocked).toBeNull()
    expect(checkForm(many(11), []).blocked).toMatch(/at most 10/)
  })

  it('flags malformed and duplicate links, and allows two branches of one repository', () => {
    const check = checkForm([row('https://github.com/A/One'), row('gitlab.com/x'), row('https://github.com/a/one'), row('https://github.com/a/one', 'dev')], [])
    expect(check.rowErrors).toEqual([null, ROW_ERRORS.malformed, ROW_ERRORS.duplicate, null])
    expect(check.blocked).toMatch(/2 highlighted links/)
  })

  it('takes the branch from the URL before the branch field', () => {
    const [first, second] = checkForm([row('https://github.com/a/one/tree/feature/x', 'ignored'), row('https://github.com/a/two', ' release/2.x ')], []).targets
    expect(first?.ref).toBe('feature/x')
    expect(second?.ref).toBe('release/2.x')
  })

  it('builds pasted targets and mixes them with GitHub ones', () => {
    const check = checkForm([row('https://github.com/a/one')], [project('billing', '{"dependencies":{"axios":"^0.27.2"}}')])
    expect(check.blocked).toBeNull()
    expect(toScanRequest(check.targets)).toEqual({
      repository_targets: [
        { type: 'github', url: 'https://github.com/a/one' },
        { type: 'pasted', name: 'billing', files: [{ filename: 'package.json', content: '{"dependencies":{"axios":"^0.27.2"}}' }] },
      ],
    })
  })

  it('rejects unnamed, duplicate, empty, oversized and undetected pasted projects', () => {
    const errors = (item: PastedProject, rowsIn: RepoRow[] = []) => checkForm(rowsIn, [item]).projectErrors[item.id]
    expect(errors(project('', 'flask==3.0.0'))?.name).toBe('Enter a project name')
    expect(errors(project('one', 'flask==3.0.0'), [row('https://github.com/a/one')])?.name).toMatch(/already used/)
    expect(errors(project('x', ''))?.name).toBe('Paste at least one manifest')
    const big = project('x', `{"name":"${'a'.repeat(MAX_PASTED_FILE_BYTES)}"}`)
    expect(Object.values(errors(big)?.files ?? {})[0]).toMatch(/200 KB/)
    const unknown = project('x', 'hello world, this is prose')
    expect(Object.values(errors(unknown)?.files ?? {})[0]).toMatch(/Could not detect/)
    expect(checkForm([row('https://github.com/a/one'), row('https://github.com/a/two')], [unknown]).blocked).toMatch(/pasted project/)
  })
})

describe('detectManifest', () => {
  it('recognizes each supported file and refuses to guess', () => {
    expect(detectManifest('{"name":"x","dependencies":{}}')).toBe('package.json')
    expect(detectManifest('{"lockfileVersion":3,"packages":{}}')).toBe('package-lock.json')
    expect(detectManifest('# c\nflask==3.0.0\nrequests>=2.25,<3\n-r base.txt')).toBe('requirements.txt')
    expect(detectManifest('[project]\nname = "x"')).toBe('pyproject.toml')
    expect(detectManifest('[[package]]\nname = "x"\nversion = "1"')).toBe('poetry.lock')
    expect(detectManifest('<project><dependencies/></project>')).toBe('pom.xml')
    for (const unclear of ['', '{broken', '{"a":1}', 'just some words here']) expect(detectManifest(unclear), unclear).toBeNull()
  })
})

describe('fix lines', () => {
  const base = find('lodash')
  const withFile = (source_file: string, name = 'pkg', recommended: string | null = '2.0.0'): DependencyDrift => ({
    ...base,
    dependency_name: name,
    recommended_version: recommended,
    declarations_by_repo: { a: { declared_range: '^1.0.0', resolved_version: '1.0.0', dep_type: 'runtime', source_file } },
  })

  it('writes the exact line for each manifest type from the recommended version only', () => {
    expect(fixLine(withFile('web/package.json'), 'a')).toBe('"pkg": "2.0.0"')
    expect(fixLine(withFile('requirements-dev.txt'), 'a')).toBe('pkg==2.0.0')
    expect(fixLine(withFile('pyproject.toml'), 'a')).toBe('"pkg==2.0.0",')
    expect(fixLine(withFile('pom.xml', 'org.x:lib'), 'a')).toContain('<groupId>org.x</groupId>\n  <artifactId>lib</artifactId>\n  <version>2.0.0</version>')
  })

  it('writes a recommended range as given instead of pinning it', () => {
    expect(fixLine(withFile('requirements.txt', 'pkg', '>=2.0,<3'), 'a')).toBe('pkg>=2.0,<3')
    expect(fixLine(withFile('package.json', 'pkg', '^2.0.0'), 'a')).toBe('"pkg": "^2.0.0"')
    expect(fixLine(withFile('pom.xml', 'g:a', '[2.0,3.0)'), 'a')).toBeNull()
  })

  it('offers nothing without a recommendation, an unknown file, or a missing repository', () => {
    expect(fixLine(withFile('package.json', 'pkg', null), 'a')).toBeNull()
    expect(fixLine(withFile('Gemfile'), 'a')).toBeNull()
    expect(fixLine(withFile('package.json'), 'other')).toBeNull()
  })

  it('skips repositories already on the recommended version', () => {
    const onIt = { ...withFile('package.json'), recommended_version: '1.0.0' }
    expect(alreadyOnRecommended(onIt, 'a')).toBe(true)
    expect(fixesFor(onIt)).toEqual([])
    expect(fixesFor(withFile('package.json'))).toEqual([{ repo: 'a', file: 'package.json', line: '"pkg": "2.0.0"' }])
  })

  it('groups the plan by repository, lowest risk first', () => {
    const plan = fixPlan(rows, ['payment-service', 'core-service', 'customer-service'])
    const payment = plan.find((group) => group.repo === 'payment-service')
    expect(payment?.items.map(({ row: item }) => item.dependency_name)).toEqual(['fastapi', 'lodash', 'requests', 'axios'])
    expect(payment?.items.every(({ fix }) => fix.repo === 'payment-service')).toBe(true)
    expect(fixPlanText(plan, (name) => name.toUpperCase())).toContain('## PAYMENT-SERVICE\n- [ ] pyproject.toml: "fastapi>=0.110.0",')
  })

  it('builds a PR description from scan data only', () => {
    const text = prDescription(find('react'), (name) => name)
    expect(text).toContain('## Align react on ^18.2.0')
    expect(text).toContain('| customer-service | `^17.0.2` | not resolved |')
    expect(text).toContain('Release notes: "Automatic batching')
    expect(prDescription(find('axios'), (name) => name)).toContain('Known vulnerability in payment-service: GHSA-wf5p-g6vw-rhxx')
  })
})

describe('repository health', () => {
  it('follows the documented formula', () => {
    // payment-service: react confirmed (25), pydantic suspected (15), axios unknown (8), requests unknown (8),
    // fastapi and lodash other drift (3 each), one vulnerability (10) = 72 lost.
    expect(repoHealth(rows, 'payment-service')).toMatchObject({ score: 28, grade: 'F', drifted: 6, findings: 2, vulnerabilities: 1 })
    expect(repoHealth(rows, 'core-service')).toMatchObject({ score: 74, grade: 'C', drifted: 3 })
    expect(repoHealth(rows, 'nobody')).toMatchObject({ score: 100, grade: 'A', drifted: 0 })
  })
})

describe('KPIs', () => {
  it('counts from real fields and respects reviews', () => {
    expect(computeKpis(result, {})).toEqual({ activeDrifts: 6, sharedLibraries: 9, vulnerableVersions: 1, pendingReview: 6 })
    const reviews = { 'npm:react': review('accepted'), 'npm:axios': review('snoozed', new Date(Date.now() + 1000).toISOString()), 'npm:lodash': review('snoozed', '2020-01-01T00:00:00Z') }
    expect(computeKpis(result, reviews).pendingReview).toBe(4) // the expired snooze counts as pending again
    expect(activeReview(reviews['npm:lodash'])).toBeNull()
  })

  it('reports vulnerable versions as unavailable when no lookup ran', () => {
    const bare: ScanResult = { ...result, data_sources: [], drift_matrix: rows.map((item) => ({ ...item, vulnerabilities: [] })) }
    expect(computeKpis(bare, {}).vulnerableVersions).toBeNull()
    expect(computeKpis({ ...bare, data_sources: [{ name: 'OSV', status: 'ok' }] }, {}).vulnerableVersions).toBe(0)
    expect(computeKpis({ ...bare, data_sources: [{ name: 'OSV', status: 'failed' }] }, {}).vulnerableVersions).toBeNull()
  })

  it('orders priority drifts by risk, then score', () => {
    expect(priorityDrifts(rows).map((item) => item.dependency_name)).toEqual(['react', 'pydantic', 'axios', 'requests', 'fastapi', 'lodash'])
    expect(teamMessage(rows, 2).split('\n')).toHaveLength(4)
    expect(teamMessage([])).toMatch(/no dependency drift/)
  })
})

describe('scan history', () => {
  const targets = [
    { kind: 'github' as const, label: 'A', name: 'a', url: 'https://github.com/x/a', ref: null, files: [] },
    { kind: 'pasted' as const, label: 'B', name: 'b', url: null, ref: null, files: [{ filename: 'package.json' as const, content: 'SECRET-CONTENT' }] },
  ]

  it('never stores pasted content', () => {
    const entry = toHistoryEntry('id', 'live', targets, result, new Date('2026-10-13T00:00:00Z'))
    expect(JSON.stringify(entry)).not.toContain('SECRET-CONTENT')
    expect(entry.targets[1]).toEqual({ kind: 'pasted', label: 'B', name: 'b', url: null, ref: null })
    expect(entry).toMatchObject({ drifted: 6, major: 3, findings: 2 })
  })

  it('diffs two scans', () => {
    const before = toHistoryEntry('1', 'live', targets, result)
    const after = { ...before, drifts: { ...before.drifts, 'npm:new': 'MAJOR_DRIFT|NONE', 'npm:react': 'MAJOR_DRIFT|NONE' } }
    delete (after.drifts as Record<string, string>)['npm:lodash']
    expect(diffScans(before, after)).toEqual({ added: ['npm:new'], resolved: ['npm:lodash'], changed: ['npm:react'] })
    expect(diffScans(before, before)).toEqual({ added: [], resolved: [], changed: [] })
  })
})

describe('local store', () => {
  it('falls back to an empty state for anything it does not recognize', () => {
    expect(sanitize(null)).toEqual(emptyStore())
    expect(sanitize({ version: 99, reviews: { x: 1 } })).toEqual(emptyStore())
    expect(sanitize('junk')).toEqual(emptyStore())
    const kept = sanitize({ version: STORE_VERSION, fixesDone: ['a', 5], history: 'nope', settings: { theme: 'dark' } })
    expect(kept.fixesDone).toEqual(['a'])
    expect(kept.history).toEqual([])
    expect(kept.settings).toMatchObject({ theme: 'dark', density: 'comfortable' })
  })
})

describe('contract with the backend', () => {
  it('parses a record shaped like the FastAPI backend output', () => {
    // Shape taken from backend/tests/test_scans.py::test_create_poll_and_contract_keys.
    const record = parseScanRecord({
      scan_id: 'scn_1', status: 'COMPLETED', created_at: 'a', updated_at: 'b', completed_at: 'c', duration_seconds: 1.2,
      progress: { stage: 'COMPLETED', percentage: 100, current_action: 'Done' }, error: null,
      result: {
        scanned_repositories: [{ name: 'billing', url: null, manifest_count: 1, total_dependencies: 1 }],
        summary: { total_unique_dependencies: 1, shared_dependencies_count: 1, drift_count: 1, in_sync_count: 0, severity_counts: { MAJOR_DRIFT: 1 }, compatibility_risk_counts: { SUSPECTED_BREAKING: 1 } },
        drift_matrix: [{
          id: 'npm:axios', dependency_name: 'axios', ecosystem: 'npm', drift_disparity: 'MAJOR_DRIFT', compatibility_risk: 'SUSPECTED_BREAKING',
          declarations_by_repo: { billing: { declared_range: '^0.27.2', resolved_version: null, dep_type: 'runtime', source_file: 'package.json' } },
          present_in_repos: ['billing'], missing_in_repos: [], recommended_version: '1.6.8', evidence: null,
          score: 50, risk_level: 'High', breakdown: [{ signal: 'Major version gap', points: 50 }], confidence: 0.65,
          signals_missing: ['lockfile', 'code_scan'], vulnerabilities: [{ id: 'GHSA-x', summary: 's', fixed_in: '1.0.0', affects_repo: 'billing' }],
          explanation: { text: 'axios is used at 0.27.2 to 1.6.8.', source: 'template' },
        }],
        graph_summary: { total_nodes: 2, total_edges: 1, density: 0.5, highest_drift_nodes: ['axios'] },
        warnings: ['billing: pasted input'], skipped_items: [], contract_analysis: null, code_impact: null,
        data_sources: [{ name: 'OSV', status: 'ok' }],
        repository_details: [{ name: 'billing', kind: 'pasted', ref: null, commit: null, manifests: ['package.json'], code_scanned: false, error: null }],
      },
    })
    const drift = record.result?.drift_matrix[0]
    expect(drift).toMatchObject({ score: 50, risk_level: 'High', confidence: 0.65, signals_missing: ['lockfile', 'code_scan'] })
    expect(drift?.vulnerabilities[0]).toEqual({ id: 'GHSA-x', summary: 's', fixed_in: '1.0.0', affects_repo: 'billing' })
    expect(drift?.explanation).toEqual({ text: 'axios is used at 0.27.2 to 1.6.8.', source: 'template' })
    expect(record.result?.data_sources).toEqual([{ name: 'OSV', status: 'ok' }])
    expect(record.result?.repository_details[0]?.manifests).toEqual(['package.json'])
    expect(record.result?.scanned_repositories[0]?.url).toBeNull()
  })
})

describe('a real backend response', () => {
  // Captured from the FastAPI backend (POST /api/v1/scans, then GET the poll_url)
  // for three pasted projects. It is real output, not hand-written.
  it('parses without loss of the fields the UI reads', async () => {
    const { default: raw } = await import('../api/fixtures/backend-scan.json')
    const record = parseScanRecord(raw)
    const live = record.result as ScanResult
    expect(record.status).toBe('COMPLETED')
    expect(live.scanned_repositories.map((repo) => repo.name)).toEqual(['service-a', 'service-b', 'service-c'])
    expect(live.summary?.severity_counts).toEqual(raw.result.summary.severity_counts)
    expect(live.drift_matrix).toHaveLength(raw.result.drift_matrix.length)

    const axios = live.drift_matrix.find((item) => item.id === 'npm:axios') as DependencyDrift
    expect(axios).toMatchObject({ drift_disparity: 'MAJOR_DRIFT', ecosystem: 'npm' })
    expect(axios.declarations_by_repo['service-a']).toEqual({ declared_range: '^0.27.2', resolved_version: null, dep_type: 'runtime', source_file: 'package.json' })
    expect(typeof axios.score).toBe('number')
    expect(axios.confidence).toBeGreaterThan(0)
    expect(axios.signals_missing).toContain('code_scan')
    expect(axios.vulnerabilities.length).toBeGreaterThan(0)
    expect(axios.vulnerabilities.every((item) => item.id && item.affects_repo)).toBe(true)
    expect(axios.explanation?.source).toBe('template')
    expect(axios.recommended_version).toMatch(/^[0-9]/)
    expect(fixLine(axios, 'service-a')).toBe(`"axios": "${axios.recommended_version}"`)

    expect(live.code_impact).toBeNull() // pasted input: no code scan, and the UI says so
    expect(live.contract_analysis).toBeNull()
    expect(live.data_sources.find((item) => item.name === 'OSV')?.status).toBe('ok')
    expect(live.repository_details.every((item) => item.kind === 'pasted' && !item.code_scanned)).toBe(true)
    expect(computeKpis(live, {}).activeDrifts).toBe(live.summary?.drift_count)
    expect(repoHealth(live.drift_matrix, 'service-a').grade).toMatch(/^[A-F]$/)
  })
})
