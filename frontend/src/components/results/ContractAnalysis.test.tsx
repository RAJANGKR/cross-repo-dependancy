// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import raw from '../../api/fixtures/contract-analysis.json'
import { parseScanRecord } from '../../api/parseScan'
import { CONTRACT_STATES, type ContractAnalysisEntry } from '../../api/scanTypes'
import { contractMeta } from '../../lib/classify'
import { buildMarkdown } from '../../lib/exportMarkdown'
import { ContractAnalysis } from './ContractAnalysis'

afterEach(cleanup)

/**
 * `contract-analysis.json` is real output of the FastAPI backend for mocked
 * repositories. backend/tests/test_contracts.py fails when the backend's
 * output and this file differ, so the two sides cannot drift apart silently.
 */
function parsed() {
  const record = parseScanRecord({
    scan_id: 'scn_1', status: 'COMPLETED', created_at: 'a', updated_at: 'b', completed_at: 'c', duration_seconds: 1,
    progress: null, error: null,
    result: {
      scanned_repositories: [], summary: null, drift_matrix: [], graph_summary: null, warnings: [], skipped_items: [],
      contract_analysis: raw, code_impact: null,
    },
  })
  if (!record.result?.contract_analysis) throw new Error('contract analysis was not parsed')
  return { result: record.result, entries: record.result.contract_analysis }
}

const find = (entries: ContractAnalysisEntry[], provider: string, consumer = '') =>
  entries.find((entry) => entry.provider_repo === provider && entry.consumer_repo === consumer) as ContractAnalysisEntry

describe('contract analysis from the real backend', () => {
  it('parses every entry and finding without losing a field the UI reads', () => {
    const { entries } = parsed()
    expect(entries).toHaveLength(raw.length)
    expect(new Set(entries.map((entry) => entry.status))).toEqual(new Set(CONTRACT_STATES))
    // Every status the backend sends is one this dashboard knows how to describe.
    expect(entries.every((entry) => contractMeta(entry.status).known)).toBe(true)

    const compared = find(entries, 'orders-v2')
    expect(compared.status).toBe('ANALYZED')
    expect(compared.spec_file).toBe('docs/openapi.json')
    expect(compared.findings).toHaveLength(6)
    for (const finding of compared.findings) {
      expect(finding.change_type && finding.path && finding.previous_value && finding.new_value).toBeTruthy()
      expect(finding.spec_file && finding.json_pointer.startsWith('/') && finding.severity && finding.impact).toBeTruthy()
    }
    expect(compared.findings.find((finding) => finding.change_type === 'REMOVED_PATH')).toMatchObject({
      path: '/orders/{id}/refunds', method: '', previous_value: 'operations: POST', new_value: 'path not present', spec_file: 'openapi.yaml', severity: 'HIGH',
    })
    expect(find(entries, 'orders-v2', 'storefront').findings.map((finding) => finding.change_type).sort()).toEqual(['CHANGED_RESPONSE_FIELD_TYPE', 'REMOVED_PATH'])
  })

  it('renders compared, consumer, unverified and unavailable entries honestly', () => {
    const { entries } = parsed()
    render(<ContractAnalysis entries={entries} repoLabel={(name) => name} />)
    const items = screen.getAllByRole('listitem').filter((item) => item.querySelector('h3'))
    expect(items).toHaveLength(entries.length)
    const card = (provider: string, consumer = '') => items[entries.indexOf(find(entries, provider, consumer))] as HTMLElement

    const compared = within(card('orders-v2'))
    expect(compared.getByText('6 findings')).toBeTruthy()
    expect(compared.getByText(/same API by matching normalized info\.title, order by info\.version/)).toBeTruthy()
    expect(compared.getByText(/does not prove a runtime failure/)).toBeTruthy()
    expect(compared.getByText('Removed path')).toBeTruthy()
    expect(compared.getByText('/paths/~1orders~1{id}~1refunds')).toBeTruthy()
    expect(compared.getAllByText(/not a confirmed runtime failure/).length).toBe(6)

    const consumer = within(card('orders-v2', 'storefront'))
    expect(consumer.getByText('consumed by')).toBeTruthy()
    expect(consumer.getByText(/storefront references this endpoint at src\/api\.js:5/)).toBeTruthy()

    // A consumer with no changed endpoint shows the backend's reason, not a blanket "no changes".
    expect(within(card('orders-v2', 'reports')).getByText(/None of the changes between 1\.0\.0 and 2\.0\.0 touches an endpoint it references/)).toBeTruthy()
    // Unverified, not-compared, malformed and missing are each named, never shown as compatible.
    expect(within(card('orders-v2', 'inventory')).getByText(/unverified; it is not ruled out/)).toBeTruthy()
    expect(within(card('inventory')).getByText(/No other version of this API was found/)).toBeTruthy()
    expect(within(card('broken-spec')).getByText(/could not be parsed: not valid YAML/)).toBeTruthy()
    expect(within(card('service-a')).getByText(/No OpenAPI or Swagger file/)).toBeTruthy()
    expect(screen.queryByText(/confirmed breaking/i)).toBeNull()
  })

  it('is included in the Markdown export', () => {
    const { result } = parsed()
    const markdown = buildMarkdown({ scan_id: 'scn_1', status: 'COMPLETED', created_at: null, updated_at: null, completed_at: null, duration_seconds: null, progress: null, result, error: null }, [], 'live')
    expect(markdown).toContain('## API contract analysis')
    expect(markdown).toContain('- orders-v2 to storefront: Analyzed')
    expect(markdown).toContain('- orders-v2 to inventory: Relationship unverified')
    expect(markdown).toContain('Removed path:  `/orders/{id}/refunds`')
  })
})
