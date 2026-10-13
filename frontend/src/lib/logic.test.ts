import { describe, expect, it } from 'vitest'
import { createDemoClient, demoRecord } from '../api/demoScan'
import type { DependencyDrift, ScanResult } from '../api/scanTypes'
import { buildGraph, defaultGraphView, repoNodeId } from './buildGraph'
import { driftMeta, riskMeta } from './classify'
import { buildMarkdown, exportFileName } from './exportMarkdown'
import { DEFAULT_FILTERS, filterDrifts, viewStateFromSearch, viewStateToSearch } from './filterSort'
import { nextStepFor, registryUrl } from './nextStep'
import { computeOverview, repoNamesOf } from './overview'
import { parseRepoUrl, REPO_ERRORS, validateRepoInputs } from './validateRepoUrl'

function demoResult(): ScanResult {
  const result = demoRecord().result
  if (!result) throw new Error('demo record has no result')
  return result
}

async function variantResult(variant: 'partial' | 'empty' | 'minimal'): Promise<ScanResult> {
  const client = createDemoClient(variant)
  for (let poll = 0; poll < 10; poll += 1) {
    const record = await client.getScan({ scan_id: 'x', status: 'QUEUED', poll_url: null })
    if (record.result) return record.result
  }
  throw new Error('variant never completed')
}

const rows = demoResult().drift_matrix
const names = (list: DependencyDrift[]) => list.map((row) => row.dependency_name)

describe('parseRepoUrl', () => {
  it('accepts repository URLs, with or without a branch', () => {
    expect(parseRepoUrl('https://github.com/pallets/flask')).toMatchObject({ owner: 'pallets', repo: 'flask', ref: null })
    expect(parseRepoUrl('  https://github.com/pallets/flask.git/ ')?.url).toBe('https://github.com/pallets/flask')
    expect(parseRepoUrl('https://github.com/a/b/tree/feature/x-1')).toMatchObject({
      url: 'https://github.com/a/b',
      ref: 'feature/x-1',
    })
  })

  it('rejects everything else', () => {
    for (const bad of [
      '',
      'github.com/a/b',
      'http://github.com/a/b',
      'https://gitlab.com/a/b',
      'https://github.com/a',
      'https://github.com/a/',
      'https://github.com/a/b/blob/main/x.py',
      'https://github.com/a/b/issues',
      'https://github.com/a/b/tree',
      'https://github.com/a/b?tab=readme',
      'https://github.com/a b/c',
    ]) {
      expect(parseRepoUrl(bad), bad).toBeNull()
    }
  })
})

describe('validateRepoInputs', () => {
  const input = (url: string) => ({ label: '', url })

  it('passes three distinct repositories', () => {
    const result = validateRepoInputs([
      input('https://github.com/a/one'),
      input('https://github.com/a/two'),
      input('https://github.com/a/three/tree/dev'),
    ])
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([null, null, null])
  })

  it('flags missing, malformed and duplicate inputs separately', () => {
    const result = validateRepoInputs([
      input('https://github.com/a/one'),
      input('not a url'),
      input(''),
    ])
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual([null, REPO_ERRORS.malformed, REPO_ERRORS.missing])

    const duplicate = validateRepoInputs([
      input('https://github.com/A/One'),
      input('https://github.com/a/one/tree/dev'),
      input('https://github.com/a/two'),
    ])
    expect(duplicate.errors).toEqual([null, REPO_ERRORS.duplicate, null])
  })
})

describe('computeOverview', () => {
  const value = (result: ScanResult, key: string) =>
    computeOverview(result).metrics.find((metric) => metric.key === key)?.value

  it('reads counts from the backend summary', () => {
    const result = demoResult()
    expect(value(result, 'repos')).toBe(3)
    expect(value(result, 'dependencies')).toBe(12)
    expect(value(result, 'major')).toBe(3)
    expect(value(result, 'minor')).toBe(3)
    expect(value(result, 'in-sync')).toBe(3)
    expect(value(result, 'single')).toBe(3)
    expect(value(result, 'findings')).toBe(2)
    expect(value(result, 'warnings')).toBe(3)
    expect(computeOverview(result).derived).toBe(false)
  })

  it('tallies from the rows when there is no summary, and says so', async () => {
    const overview = computeOverview(await variantResult('minimal'))
    const metric = (key: string) => overview.metrics.find((item) => item.key === key)?.value
    expect(overview.derived).toBe(true)
    expect(metric('major')).toBe(3)
    // Nothing in the data supports these, so they stay unavailable, not zero.
    expect(metric('repos')).toBeNull()
    expect(metric('dependencies')).toBeNull()
  })

  it('leaves every count unavailable when there is no data at all', () => {
    const empty: ScanResult = { ...demoResult(), summary: null, drift_matrix: [], scanned_repositories: [] }
    const overview = computeOverview(empty)
    for (const key of ['repos', 'dependencies', 'in-sync', 'minor', 'major', 'single', 'findings']) {
      expect(overview.metrics.find((metric) => metric.key === key)?.value, key).toBeNull()
    }
    expect(overview.distribution).toBeNull()
  })

  it('separates a clean scan from one with warnings', async () => {
    expect(computeOverview(await variantResult('empty')).hasWarnings).toBe(false)
    const partial = computeOverview(await variantResult('partial'))
    expect(partial.hasWarnings).toBe(true)
    expect(partial.incompleteRepos.map((repo) => repo.name)).toEqual(['customer-service'])
  })

  it('lists repositories from rows when the backend omits them', async () => {
    expect(repoNamesOf(await variantResult('minimal'))).toEqual(['payment-service', 'customer-service', 'core-service'])
  })
})

describe('filterDrifts', () => {
  it('sorts by drift, then risk, by default', () => {
    expect(names(filterDrifts(rows, DEFAULT_FILTERS)).slice(0, 3)).toEqual(['react', 'pydantic', 'axios'])
  })

  it('filters by name, ecosystem, drift, risk and repository', () => {
    expect(names(filterDrifts(rows, { ...DEFAULT_FILTERS, query: 'REA' }))).toEqual(['react'])
    expect(filterDrifts(rows, { ...DEFAULT_FILTERS, ecosystems: ['python'] }).every((row) => row.ecosystem === 'python')).toBe(true)
    expect(filterDrifts(rows, { ...DEFAULT_FILTERS, drifts: ['MAJOR_DRIFT'] })).toHaveLength(3)
    expect(names(filterDrifts(rows, { ...DEFAULT_FILTERS, risks: ['CONFIRMED_BREAKING'] }))).toEqual(['react'])
    expect(filterDrifts(rows, DEFAULT_FILTERS, 'core-service')).toHaveLength(5)
  })

  it('sorts by name and reverses', () => {
    const byName = names(filterDrifts(rows, { ...DEFAULT_FILTERS, sort: 'name' }))
    expect(byName).toEqual([...byName].sort())
    expect(names(filterDrifts(rows, { ...DEFAULT_FILTERS, sort: 'name', reversed: true }))).toEqual([...byName].reverse())
  })

  it('round-trips through the URL and keeps unrelated params', () => {
    const state = {
      filters: { ...DEFAULT_FILTERS, query: 'ax', drifts: ['MAJOR_DRIFT'], risks: ['NONE'], sort: 'risk' as const, reversed: true },
      selected: 'npm:axios',
    }
    const search = viewStateToSearch(state, '?mock=partial')
    expect(search).toContain('mock=partial')
    expect(viewStateFromSearch(search)).toEqual(state)
    expect(viewStateToSearch({ filters: DEFAULT_FILTERS, selected: null }, '')).toBe('')
    expect(viewStateFromSearch('?sort=nonsense').filters).toEqual(DEFAULT_FILTERS)
  })
})

describe('buildGraph', () => {
  const repos = ['payment-service', 'core-service', 'customer-service']

  it('shows drifted packages by default, with one edge per declaration', () => {
    expect(defaultGraphView(rows)).toBe('drifted')
    const layout = buildGraph(rows, repos, 'drifted')
    const packages = layout.nodes.filter((node) => node.kind === 'package')
    expect(packages).toHaveLength(6)
    expect(layout.edges).toHaveLength(12)
    expect(layout.hiddenPackages).toBe(6)
    expect(layout.edges.every((edge) => edge.source.startsWith('repo:'))).toBe(true)
  })

  it('marks shared and single-repository packages', () => {
    const layout = buildGraph(rows, repos, 'all')
    const node = (name: string) => layout.nodes.find((item) => item.label === name)
    expect(layout.nodes.filter((item) => item.kind === 'package')).toHaveLength(12)
    expect(node('react')?.shared).toBe(true)
    expect(node('express')?.shared).toBe(false)
    expect(layout.nodes.some((item) => item.id === repoNodeId('core-service'))).toBe(true)
  })

  it('never overlaps nodes within a column', () => {
    const layout = buildGraph(rows, repos, 'all')
    for (const kind of ['repo', 'package'] as const) {
      const ys = layout.nodes.filter((node) => node.kind === kind).map((node) => node.y).sort((a, b) => a - b)
      for (let index = 1; index < ys.length; index += 1) {
        expect((ys[index] ?? 0) - (ys[index - 1] ?? 0)).toBeGreaterThanOrEqual(44)
      }
    }
  })

  it('falls back to another view when nothing has drifted', async () => {
    expect(defaultGraphView((await variantResult('empty')).drift_matrix)).toBe('shared')
    expect(buildGraph([], repos, 'all').nodes).toEqual([])
  })
})

describe('classification and suggestions', () => {
  it('never describes NONE or UNKNOWN_IMPACT as safe', () => {
    expect(riskMeta('NONE').label).toBe('No issue identified')
    expect(riskMeta('NONE').description).toMatch(/not proof/i)
    expect(riskMeta('UNKNOWN_IMPACT').description).toMatch(/not a sign of safety/i)
    expect(driftMeta('MAJOR_DRIFT').description).toMatch(/not whether anything breaks/i)
  })

  it('shows unrecognized values as sent', () => {
    expect(driftMeta('PATCH_DRIFT')).toMatchObject({ label: 'PATCH_DRIFT', known: false, tone: 'neutral' })
  })

  it('suggests a step only for drifted packages', () => {
    const find = (name: string) => rows.find((row) => row.dependency_name === name) as DependencyDrift
    expect(nextStepFor(find('react'))).toMatch(/code change/)
    expect(nextStepFor(find('axios'))).toMatch(/unassessed, not safe/)
    expect(nextStepFor(find('typescript'))).toBeNull()
    expect(nextStepFor(find('express'))).toBeNull()
  })

  it('builds registry links only for safe names', () => {
    expect(registryUrl({ dependency_name: '@scope/pkg', ecosystem: 'npm' })?.url).toBe('https://www.npmjs.com/package/@scope/pkg')
    expect(registryUrl({ dependency_name: 'pydantic', ecosystem: 'python' })?.url).toBe('https://pypi.org/project/pydantic/')
    expect(registryUrl({ dependency_name: 'a b?x=1', ecosystem: 'npm' })).toBeNull()
    expect(registryUrl({ dependency_name: 'x', ecosystem: 'cargo' })).toBeNull()
  })
})

describe('buildMarkdown', () => {
  it('labels demo data on the first line and keeps declared and resolved apart', () => {
    const markdown = buildMarkdown(demoRecord(), rows, 'demo')
    expect(markdown.split('\n')[0]).toBe('> Demo data, not a live scan')
    expect(markdown).toContain('| Repository | Declared range | Resolved version | Source file |')
    expect(markdown).toContain('| customer-service | `^17.0.2` | Not resolved | package.json |')
    expect(markdown).toContain('AI interpretation:')
    expect(markdown).toContain('none available. This is not proof of compatibility.')
    expect(markdown).toContain('## Limitations')
  })

  it('does not label a live scan as demo, and omits sections the backend did not send', async () => {
    const result = await variantResult('minimal')
    const markdown = buildMarkdown({ ...demoRecord(), result }, result.drift_matrix, 'live')
    expect(markdown.startsWith('# DriftLock scan report')).toBe(true)
    expect(markdown).toContain('Dependencies analyzed: Not available')
    expect(markdown).not.toContain('## API contract analysis')
    expect(markdown).not.toContain('## Code impact')
  })

  it('names the file by date', () => {
    expect(exportFileName(new Date(2026, 9, 3))).toBe('driftlock-report-2026-10-03.md')
  })
})
