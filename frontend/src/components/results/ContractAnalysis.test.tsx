// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import raw from '../../api/fixtures/contract-analysis.json'
import rawImpact from '../../api/fixtures/contract-impact-eval.json'
import { parseScanRecord } from '../../api/parseScan'
import { CONTRACT_STATES, EVIDENCE_TIERS, type ContractAnalysisEntry } from '../../api/scanTypes'
import { contractMeta, evidenceBadge, evidenceMeta, TONE_STYLES } from '../../lib/classify'
import { buildMarkdown } from '../../lib/exportMarkdown'
import { candidateAction, entryHeadline, entryRank, sectionSummary, suggestedAction, summarizeChange } from '../../lib/contractSummary'
import { ContractAnalysis } from './ContractAnalysis'

afterEach(cleanup)

/**
 * `contract-analysis.json` is real output of the FastAPI backend for mocked
 * repositories. backend/tests/test_contracts.py fails when the backend's
 * output and this file differ, so the two sides cannot drift apart silently.
 */
function parsed(source: unknown = raw) {
  const record = parseScanRecord({
    scan_id: 'scn_1', status: 'COMPLETED', created_at: 'a', updated_at: 'b', completed_at: 'c', duration_seconds: 1,
    progress: null, error: null,
    result: {
      scanned_repositories: [], summary: null, drift_matrix: [], graph_summary: null, warnings: [], skipped_items: [],
      contract_analysis: source, code_impact: null,
    },
  })
  if (!record.result?.contract_analysis) throw new Error('contract analysis was not parsed')
  return { result: record.result, entries: record.result.contract_analysis }
}

const find = (entries: ContractAnalysisEntry[], provider: string, consumer = '') =>
  entries.find((entry) => entry.provider_repo === provider && entry.consumer_repo === consumer) as ContractAnalysisEntry

/** One card per entry. Cards are found by their heading, because entries that need attention are listed first. */
const cards = () => screen.getAllByRole('listitem').filter((item) => item.querySelector(':scope > div h3'))
const cardFor = (provider: string, consumer = '') =>
  cards().find((item) => item.querySelector('h3')?.textContent === provider + (consumer ? `consumed by${consumer}` : '')) as HTMLElement
/** The rows of the one entry on screen: one per contract change. */
const changeRows = () => within(screen.getByRole('list', { name: 'Contract changes' })).getAllByRole('listitem')
/** True when an element sits inside a collapsed disclosure, so a reader has to open it to see it. */
const collapsed = (element: Element) => element.closest('details:not([open])') !== null && element.closest('summary') === null

describe('contract analysis from the real backend', () => {
  it('parses every entry and finding without losing a field the UI reads', () => {
    const { entries } = parsed()
    expect(entries).toHaveLength(raw.length)
    // Between them, the two fixtures of real backend output contain every status this dashboard knows.
    const statuses = [...entries, ...parsed(rawImpact).entries].map((entry) => entry.status)
    expect(new Set(statuses)).toEqual(new Set(CONTRACT_STATES))
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
    const items = cards()
    expect(items).toHaveLength(entries.length)
    const card = cardFor

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
    // Shared paths without a host or naming signal are not presented as a consumer relationship.
    const ambiguous = within(card('orders-v2', 'catalog'))
    expect(ambiguous.getByText(/a shared path does not establish a provider-consumer relationship/)).toBeTruthy()
    expect(ambiguous.queryByText(/finding/)).toBeNull()
    expect(within(card('orders-v2', 'mobile-bff')).getByText(/Tied to this API by: .*server host orders\.acme\.example/)).toBeTruthy()
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
    // An unverified consumer's possible references are exported as such, with their location.
    const catalog = markdown.slice(markdown.indexOf('- orders-v2 to catalog: Relationship unverified'), markdown.indexOf('- orders-v2 to mobile-bff'))
    expect(catalog.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(6)
    expect(catalog).toContain('  - Possible reference: New required request field GET `/orders`, query parameter status, src/client.js:3')
    expect(catalog).toContain('  - No usage found: New required request field POST `/orders`, request field currency')
    expect(catalog).not.toMatch(/Required value not sent|Reads changed field/)
    expect(markdown).toContain('Removed path:  `/orders/{id}/refunds`')
  })

  it('parses evidence tiers and field-level rows from the backend', () => {
    const { entries } = parsed()
    const checkout = find(entries, 'orders-v2', 'checkout')
    expect(checkout.consumer_impact).toHaveLength(6)
    const row = (field: string, method: string) => checkout.consumer_impact?.find((item) => item.field === field && item.method === method)
    expect(row('id', 'GET')).toMatchObject({ evidence_tier: 'T2_FIELD_MATCH', usage: 'READS_CHANGED_FIELD', file: 'src/checkout.js', line: 7, field_in: 'response_body' })
    expect(row('currency', 'POST')).toMatchObject({ evidence_tier: 'T2_FIELD_MATCH', usage: 'OMITS_REQUIRED_FIELD', line: 10 })
    expect(row('status', 'GET')).toMatchObject({ evidence_tier: 'T2_FIELD_MATCH', usage: 'SENDS_REQUIRED_FIELD' })
    expect(row('[].id', 'GET')).toMatchObject({ evidence_tier: 'T1_OPERATION_MATCH', usage: 'FIELD_NOT_READ' })
    expect(row('', 'DELETE')).toMatchObject({ evidence_tier: 'NO_USAGE_FOUND', file: '', line: null })
    expect(checkout.findings.find((finding) => finding.field === 'id')).toMatchObject({ evidence_tier: 'T2_FIELD_MATCH', source_file: 'src/checkout.js', source_line: 7 })
    // Specification-level findings are tier zero, and only analyzed consumers carry evidence rows.
    expect(find(entries, 'orders-v2').findings.every((finding) => finding.evidence_tier === 'T0_DETECTED')).toBe(true)
    expect(find(entries, 'orders-v2').consumer_impact).toBeUndefined()
    expect(find(entries, 'orders-v2', 'catalog').consumer_impact).toBeUndefined()
    // Every tier the backend sends is one this dashboard can describe.
    const sent = new Set(entries.flatMap((entry) => [
      ...entry.findings.map((finding) => finding.evidence_tier ?? ''),
      ...(entry.consumer_impact ?? []).map((item) => item.evidence_tier),
      ...(entry.candidate_impact ?? []).map((item) => item.evidence_tier),
    ]))
    expect(sent).toEqual(new Set(EVIDENCE_TIERS))
    expect([...sent].every((tier) => evidenceMeta(tier).known)).toBe(true)
  })

  it('shows the affected consumer, the changed field, the source line and the evidence status', () => {
    const { entries } = parsed()
    render(<ContractAnalysis entries={[find(entries, 'orders-v2', 'checkout')]} repoLabel={(name) => name} />)
    expect(screen.getByText('checkout')).toBeTruthy()
    const rows = changeRows()
    expect(rows).toHaveLength(6)
    const rowFor = (text: string) => rows.find((item) => within(item).queryByText(text)) as HTMLElement

    const read = within(rowFor('response field id'))
    expect(read.getByText('Reads changed field')).toBeTruthy()
    expect(read.getByText('Field-level evidence')).toBeTruthy()
    expect(read.getByText('src/checkout.js:7')).toBeTruthy()
    expect(read.getByText(/return String\(res\.data\.id\)/)).toBeTruthy()

    const omitted = within(rowFor('request field currency'))
    expect(omitted.getByText('Required value not sent')).toBeTruthy()
    expect(omitted.getByText(/does not send request field 'currency': it sends item/)).toBeTruthy()
    // A request that is seen to satisfy the new requirement does not get the badge of a field that is read.
    const satisfied = within(rowFor('query parameter status'))
    expect(satisfied.getByText('Sends required value').className).toContain(TONE_STYLES.neutral.text)
    expect(satisfied.queryByText('Reads changed field')).toBeNull()
    expect(read.getByText('Reads changed field').className).toContain(TONE_STYLES.high.text)

    // An operation match is labelled as exactly that, with the limit of the claim spelled out.
    const called = within(rowFor('response field [].id'))
    expect(called.getByText('Operation called')).toBeTruthy()
    expect(called.getByText('Operation-level evidence')).toBeTruthy()
    expect(called.getByText(/no read of 'id' was found/)).toBeTruthy()

    // The row also carries what the separate finding list used to show: the specification pointer next to the consumer source line.
    expect(screen.getAllByText('src/checkout.js:7')).toHaveLength(1)
    expect(read.getByText('/components/schemas/Order/properties/id/type')).toBeTruthy()
    expect(read.getByText(/checkout calls this operation at src\/checkout\.js:6 and reads the changed field at src\/checkout\.js:7/)).toBeTruthy()
    expect(screen.getByText(/Static analysis only: no row is a confirmed runtime failure/)).toBeTruthy()
  })

  it('never presents "no usage found" or "unresolved" as safe', () => {
    const { entries } = parsed()
    render(<ContractAnalysis entries={[find(entries, 'orders-v2', 'storefront')]} repoLabel={(name) => name} />)
    const table = screen.getByRole('list', { name: 'Contract changes' })
    const none = within(table).getAllByText('No usage found')
    expect(none).toHaveLength(4)
    for (const badge of none) {
      // Neutral, not the "low risk" colour: absence of a match is not evidence of safety.
      expect(badge.className).toContain(TONE_STYLES.neutral.text)
      expect(badge.className).not.toContain(TONE_STYLES.low.text)
    }
    expect(within(table).getAllByText(/This is not proof that it is unaffected/)).toHaveLength(4)
    expect(within(table).getAllByText('No location')).toHaveLength(4)

    const unresolved = within(within(table).getByText('Unresolved').closest('li') as HTMLElement)
    // Neutral: an unresolved row is neither a finding nor a compatibility verdict.
    expect(within(table).getByText('Unresolved').className).toContain(TONE_STYLES.neutral.text)
    expect(unresolved.getByText(/returned by getOrder\(\) and no caller was found in the inspected files/)).toBeTruthy()
    expect(unresolved.getByText('src/api.js:4')).toBeTruthy()
    expect(evidenceMeta('UNRESOLVED').tone).not.toBe('low')
    expect(evidenceMeta('NO_USAGE_FOUND').description).toMatch(/not proof/)
    expect(screen.queryByText(/\bsafe\b/i)).toBeNull()
    expect(screen.queryByText(/confirmed breaking/i)).toBeNull()
  })

  it('lists evidence tiers in the Markdown export', () => {
    const { result } = parsed()
    const markdown = buildMarkdown({ scan_id: 'scn_1', status: 'COMPLETED', created_at: null, updated_at: null, completed_at: null, duration_seconds: null, progress: null, result, error: null }, [], 'live')
    expect(markdown).toContain('  - Reads changed field: Changed response field type GET `/orders/{orderId}`, response field id, src/checkout.js:7')
    expect(markdown).toContain('  - Sends required value: New required request field GET `/orders`, query parameter status, src/checkout.js:13')
    expect(markdown).toContain('  - No usage found: Removed operation DELETE `/orders/{id}`')
    expect(markdown).toContain('  - Unresolved: Changed response field type GET `/orders/{orderId}`, response field id, src/api.js:4')
  })
})

/**
 * `contract-impact-eval.json` is real engine output for six consumers of the
 * evaluation fixtures (backend/tests/fixtures/contract_eval). The backend test
 * test_frontend_fixture_is_the_current_backend_output keeps it in step.
 */
describe('evidence states are told apart', () => {
  const entries = () => parsed(rawImpact).entries
  const consumer = (name: string) => entries().find((entry) => entry.consumer_repo === name) as ContractAnalysisEntry
  const show = (name: string) => render(<ContractAnalysis entries={[consumer(name)]} repoLabel={(label) => label} />)
  const rowWith = (text: string) => within(screen.getByRole('list', { name: 'Contract changes' })).getByText(text).closest('li') as HTMLElement

  it('gives each kind of evidence its own label, and only real findings a warning tone', () => {
    const badges = {
      reads: evidenceBadge('T2_FIELD_MATCH', 'READS_CHANGED_FIELD'),
      omits: evidenceBadge('T2_FIELD_MATCH', 'OMITS_REQUIRED_FIELD'),
      sends: evidenceBadge('T2_FIELD_MATCH', 'SENDS_REQUIRED_FIELD'),
      maySend: evidenceBadge('T2_FIELD_MATCH', 'MAY_SEND_REQUIRED_FIELD'),
      removed: evidenceBadge('T1_OPERATION_MATCH', 'CALLS_OPERATION'),
      called: evidenceBadge('T1_OPERATION_MATCH', 'FIELD_NOT_READ'),
      unresolved: evidenceBadge('UNRESOLVED', 'NOT_DETERMINED'),
      none: evidenceBadge('NO_USAGE_FOUND', 'NO_USAGE_FOUND'),
    }
    // Reading a changed field, definitely sending, possibly sending, unresolved and no usage are five different labels.
    const labels = [badges.reads, badges.sends, badges.maySend, badges.unresolved, badges.none].map((meta) => meta.label)
    expect(new Set(labels).size).toBe(5)
    expect(labels).toEqual(['Reads changed field', 'Sends required value', 'Required value sent on some paths', 'Unresolved', 'No usage found'])
    expect([badges.reads.tone, badges.omits.tone, badges.removed.tone]).toEqual(['high', 'high', 'high'])
    expect(badges.maySend.tone).toBe('medium')
    // Satisfied, unresolved and no-usage rows are neutral: not alarming, and not the "low risk" colour either.
    expect([badges.sends.tone, badges.unresolved.tone, badges.none.tone]).toEqual(['neutral', 'neutral', 'neutral'])
    for (const meta of Object.values(badges)) {
      expect(meta.tone).not.toBe('low')
      expect(`${meta.label} ${meta.description}`).not.toMatch(/\bsafe\b|compatible|no impact/i)
    }
    expect(badges.none.description).toMatch(/not proof that the consumer is unaffected/)
    expect(badges.unresolved.description).toMatch(/neither a finding nor an all-clear/)
    // A usage this dashboard does not know falls back to the tier; an unknown tier is shown as sent.
    expect(evidenceBadge('T2_FIELD_MATCH', 'SOMETHING_NEW').label).toBe('Field-level evidence')
    expect(evidenceBadge('T9_NEW', 'SOMETHING_NEW')).toMatchObject({ label: 'T9_NEW', known: false })
    // Every usage the backend sent in both fixtures has a label of its own.
    const sent = [...parsed().entries, ...entries()].flatMap((entry) => (entry.consumer_impact ?? []).map((row) => row.usage))
    expect(sent.every((usage) => evidenceBadge('', usage).known)).toBe(true)
  })

  it('shows a field that is read', () => {
    show('py_reads_field')
    const row = within(rowWith('response field customer.legacy_id'))
    expect(row.getByText('Reads changed field').className).toContain(TONE_STYLES.high.text)
    expect(row.getByText('app.py:12')).toBeTruthy()
  })

  it('shows a required field that is definitely sent without alarm and without calling it a finding', () => {
    show('axios_interceptor')
    const row = within(rowWith('request field currency'))
    const badge = row.getByText('Sends required value')
    expect(badge.className).toContain(TONE_STYLES.neutral.text)
    expect(badge.className).not.toContain(TONE_STYLES.high.text)
    expect(row.getByText(/added by a request interceptor at src\/setup\.js:3/)).toBeTruthy()
    // It is listed as evidence, not among the findings below the table.
    expect(consumer('axios_interceptor').findings.some((finding) => finding.field === 'currency')).toBe(false)
    expect(screen.getAllByText('request field currency')).toHaveLength(1)
  })

  it('shows a required field that may be sent as exactly that', () => {
    show('conditional_field')
    const row = within(rowWith('request field currency'))
    expect(row.getByText('Required value sent on some paths').className).toContain(TONE_STYLES.medium.text)
    expect(row.queryByText('Sends required value')).toBeNull()
    expect(row.getByText(/is set only on some paths before this request \(line 11\), so a request without it is possible/)).toBeTruthy()
    expect(row.getByText('billing.py:12')).toBeTruthy()
  })

  it('shows an unknown HTTP method as unresolved, not as a call to the removed operation', () => {
    show('unknown_method')
    const row = within(rowWith('/customers/{id}/sessions'))
    expect(row.getByText('Unresolved').className).toContain(TONE_STYLES.neutral.text)
    expect(row.getByText(/its HTTP method could not be determined/)).toBeTruthy()
    expect(screen.queryByText('Calls removed operation')).toBeNull()
    expect(screen.queryByText(/no longer defines/)).toBeNull()
  })

  it('shows a consumer with runtime-built URLs as unresolved, not as unverified and not as analyzed', () => {
    const entry = consumer('dynamic_url_concat')
    expect(entry.status).toBe('UNRESOLVED')
    expect(contractMeta('UNRESOLVED')).toMatchObject({ known: true, label: 'Unresolved', tone: 'neutral' })
    show('dynamic_url_concat')
    expect(screen.getByText(/This is neither a match nor an absence of usage\./, { exact: false })).toBeTruthy()
    const rows = changeRows()
    expect(rows).toHaveLength(6)
    for (const row of rows) {
      expect(within(row).getByText('Unresolved').className).toContain(TONE_STYLES.neutral.text)
      expect(within(row).getByText('client.py:9')).toBeTruthy()
    }
    expect(screen.queryByText('Relationship unverified')).toBeNull()
    expect(screen.queryByText('Analyzed')).toBeNull()
    expect(screen.queryByText(/\d+ findings?/)).toBeNull()
    expect(screen.queryByText('No usage found')).toBeNull()
  })

  it('shows an operation match as an operation match', () => {
    show('js_calls_only')
    const row = within(rowWith('response field customer.legacy_id'))
    expect(row.getByText('Operation called').className).toContain(TONE_STYLES.medium.text)
    expect(row.queryByText('Reads changed field')).toBeNull()
  })

  it('never states safety or compatibility anywhere in these results', () => {
    render(<ContractAnalysis entries={entries()} repoLabel={(label) => label} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bsafe\b|is compatible|no impact|confirmed breaking/i)
    const markdown = buildMarkdown(
      { scan_id: 'scn_1', status: 'COMPLETED', created_at: null, updated_at: null, completed_at: null, duration_seconds: null, progress: null, result: parsed(rawImpact).result, error: null },
      [], 'live')
    expect(markdown).toContain('- billing-v2 to dynamic_url_concat: Unresolved')
    expect(markdown).toContain('  - Required value sent on some paths: New required request field POST `/invoices`, request field currency, billing.py:12')
    expect(markdown).toContain('  - Sends required value: New required request field POST `/invoices`, request field currency, src/invoices.js:5')
    expect(markdown).toContain('  - Unresolved: Removed operation DELETE `/customers/{id}/sessions`, src/sessions.js:5')
  })
})

describe('contract changes at a glance', () => {
  const show = (provider: string, consumer = '') => render(<ContractAnalysis entries={[find(parsed().entries, provider, consumer)]} repoLabel={(name) => name} />)
  /** The row for one change: its path, and when several changes share a path, its method and the element that changed. */
  const rowAt = (path: string, method = '', subject = '') =>
    changeRows().find(
      (row) => within(row).queryByText(path) && (!method || within(row).queryByText(method)) && (!subject || row.querySelector('p code')?.textContent === subject),
    ) as HTMLElement

  it('summarizes each change as endpoint, what changed and a suggested action', () => {
    show('orders-v2')
    const status = within(rowAt('/orders', 'GET', 'status'))
    expect(status.getByText('changed from optional to required')).toBeTruthy()
    expect(status.getByText('(query parameter)')).toBeTruthy()
    expect(status.getByText('status')).toBeTruthy()
    expect(status.getByText('Verify that consumers send status before upgrading.')).toBeTruthy()

    const removed = within(rowAt('/orders/{id}', 'DELETE'))
    expect(removed.getByText('operation removed')).toBeTruthy()
    expect(removed.getByText('Verify that no consumer still calls it before upgrading.')).toBeTruthy()
    expect(within(rowAt('/orders/{id}/refunds')).getByText('path removed (POST)')).toBeTruthy()

    const typed = within(rowAt('/orders/{orderId}', 'GET'))
    expect(typed.getByText('changed type from integer to string')).toBeTruthy()
    expect(typed.getByText('Verify that consumers handle the new type of id before upgrading.')).toBeTruthy()

    // The three summary lines of every row are readable without opening anything.
    for (const row of changeRows()) {
      const action = within(row).getByText('Suggested action:', { exact: false })
      expect(collapsed(action)).toBe(false)
      expect(collapsed(row.querySelector('p') as Element)).toBe(false)
    }
  })

  it('keeps JSON pointers, raw values and long descriptions one click away, not removed', () => {
    show('orders-v2')
    const row = rowAt('/orders/{id}/refunds')
    const details = row.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    const pointer = within(row).getByText('/paths/~1orders~1{id}~1refunds')
    const impact = within(row).getByText(/Potential impact: Potentially breaking for clients that still call this path/)
    for (const hidden of [pointer, impact, within(row).getByText('operations: POST'), within(row).getByText('path not present'), within(row).getByText('openapi.yaml')]) {
      expect(collapsed(hidden)).toBe(true)
    }
    // Opening the disclosure reveals them.
    fireEvent.click(within(row).getByText('View evidence'))
    details.open = true // jsdom does not toggle <details> on click in every version; the attribute is what the browser sets
    expect(collapsed(pointer)).toBe(false)
    expect(collapsed(impact)).toBe(false)
    // The comparison basis is behind its own disclosure in the card.
    const basis = screen.getByText(/same API by matching normalized info\.title, order by info\.version/)
    expect(collapsed(basis)).toBe(true)
    expect(screen.getAllByText('How this was determined').length).toBe(1)
  })

  it('gives every card one next action and one short reason', () => {
    show('orders-v2')
    expect(screen.getByText('Verify consumers before upgrading to the newer version.')).toBeTruthy()
    expect(screen.getByText('6 potentially breaking changes detected between the two specification versions.')).toBeTruthy()
    cleanup()
    show('orders-v2', 'checkout')
    const action = screen.getByText('Review 2 affected calls in this consumer before upgrading the provider.')
    expect(collapsed(action)).toBe(false)
    expect(screen.getByText('Its source code uses 2 of the 6 changed elements.')).toBeTruthy()
    // Consumer rows speak about this consumer's code.
    expect(screen.getByText('Check that this code handles the new type before the provider is upgraded.')).toBeTruthy()
    expect(screen.getByText('Send currency in this request before the provider is upgraded.')).toBeTruthy()
    expect(screen.getByText('No change needed for this request. It already sends the value.')).toBeTruthy()
  })

  it('keeps unknown, unverified and no-usage states explicit and visible', () => {
    const { entries } = parsed()
    render(<ContractAnalysis entries={entries} repoLabel={(name) => name} />)
    // Relationship unverified: the badge and the reason are on the card, not folded away.
    const unverified = cardFor('orders-v2', 'catalog')
    const badge = within(unverified).getByText('Relationship unverified')
    expect(collapsed(badge)).toBe(false)
    // Its code has strings matching two changed elements: the card says so, and still concludes nothing.
    const why = within(unverified).getByText('Its code has a possible reference to 2 of 6 changed elements, but nothing ties those calls to this API.')
    expect(collapsed(why)).toBe(false)
    expect(within(unverified).getByText('Confirm manually whether this repository calls the API.')).toBeTruthy()
    // An unverified repository with nothing matching keeps the plain reason.
    const nothing = cardFor('orders-v2', 'inventory')
    expect(collapsed(within(nothing).getByText('Its relationship to the provider could not be verified, so nothing was concluded.'))).toBe(false)
    expect(within(nothing).queryByRole('list', { name: 'Possible references to contract changes' })).toBeNull()
    // The backend's full explanation is still there, in the disclosure.
    expect(collapsed(within(unverified).getByText(/a shared path does not establish a provider-consumer relationship/))).toBe(true)

    // No usage found: explicit on the row, never worded as nothing to do.
    const reports = cardFor('orders-v2', 'reports')
    expect(within(reports).getByText('Confirm manually whether this consumer uses the changed operations.')).toBeTruthy()
    const none = within(reports).getAllByText('No usage found')
    expect(none).toHaveLength(6)
    expect(none.every((item) => !collapsed(item) && item.className.includes(TONE_STYLES.neutral.text))).toBe(true)
    const manual = within(reports).getAllByText('Confirm manually. No call was found, which is not proof that this consumer is unaffected.')
    expect(manual).toHaveLength(6)
    expect(manual.every((item) => !collapsed(item))).toBe(true)

    // Unresolved rows say so and ask for a manual review.
    const storefront = cardFor('orders-v2', 'storefront')
    const unresolved = within(storefront).getByText('Unresolved')
    expect(collapsed(unresolved)).toBe(false)
    expect(within(unresolved.closest('li') as HTMLElement).getByText('Review this call manually. The analysis could not follow it.')).toBeTruthy()

    // Not compared, malformed and missing specifications each keep their own label.
    for (const [provider, label] of [['inventory', 'Not compared'], ['broken-spec', 'Specification unreadable'], ['service-a', 'No specification found']] as const) {
      expect(collapsed(within(cardFor(provider)).getByText(label))).toBe(false)
    }
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\bsafe\b|is compatible|no impact/i)
  })

  it('opens with one sentence for the whole section and lists what needs attention first', () => {
    const { entries } = parsed()
    render(<ContractAnalysis entries={entries} repoLabel={(name) => name} />)
    expect(sectionSummary(entries)).toBe('6 potentially breaking changes found in 1 API comparison. Of 8 other repositories, 3 need review and 4 could not be settled.')
    expect(screen.getByText(sectionSummary(entries), { exact: false })).toBeTruthy()
    const order = cards().map((item) => item.querySelector('h3')?.textContent)
    expect(order[0]).toBe('orders-v2')                                        // the comparison that found changes
    expect(new Set(order.slice(1, 4))).toEqual(new Set(['orders-v2consumed bystorefront', 'orders-v2consumed bymobile-bff', 'orders-v2consumed bycheckout']))
    const ranks = entries.map(entryRank)
    expect(order.at(-1)).toBe(entries[ranks.lastIndexOf(Math.max(...ranks))]?.provider_repo)   // nothing-to-compare entries come last
    expect(cards()).toHaveLength(entries.length)                                // sorting hides nothing
  })

  it('does not say nothing was compared when a record only carries analyzed consumers', () => {
    const finding = { change_type: 'REMOVED_OPERATION', path: '/v1/sessions', method: 'DELETE', previous_value: 'operation present', new_value: 'operation removed', spec_file: 'openapi.yaml', json_pointer: '/paths/~1v1~1sessions/delete', severity: 'HIGH', impact: '' }
    const pair = { provider_repo: 'core', consumer_repo: 'payments', status: 'ANALYZED', spec_file: 'openapi.yaml', message: '', findings: [finding] }
    const missing = { provider_repo: 'customers', consumer_repo: '', status: 'SPEC_UNAVAILABLE', spec_file: '', message: '', findings: [] }
    expect(sectionSummary([pair, missing])).toBe('Contract changes were analyzed for 1 provider and consumer pair; 1 needs review.')
    expect(sectionSummary([missing])).toBe('No two versions of the same API were found in this scan, so no contract was compared.')
  })

  it('shows the possible references of an unverified consumer per change, as candidates', () => {
    const { entries } = parsed()
    const catalog = find(entries, 'orders-v2', 'catalog')
    // The parser keeps what the backend found: the rows, and the calls behind them.
    expect(catalog.status).toBe('RELATIONSHIP_UNVERIFIED')
    expect(catalog.findings).toEqual([])
    expect(catalog.consumer_impact).toBeUndefined()
    expect(catalog.candidate_impact).toHaveLength(6)
    const required = catalog.candidate_impact?.find((row) => row.field === 'status')
    expect(required).toMatchObject({ evidence_tier: 'POSSIBLE_REFERENCE', usage: 'OMITS_REQUIRED_FIELD', method: 'GET', path: '/orders', field_in: 'query', repository: 'catalog', file: 'src/client.js', line: 3 })
    expect(required?.references).toEqual([expect.objectContaining({ repository: 'catalog', file: 'src/client.js', line: 3, usage: 'OMITS_REQUIRED_FIELD' })])
    expect(catalog.possible_references?.map((ref) => `${ref.path} ${ref.file}:${ref.line}`)).toEqual(['/items src/client.js:2', '/orders src/client.js:3'])

    render(<ContractAnalysis entries={[catalog]} repoLabel={(name) => name} />)
    const card = within(cardFor('orders-v2', 'catalog'))
    expect(card.getByText('Relationship unverified')).toBeTruthy()                    // the status does not change
    expect(card.queryByRole('list', { name: 'Contract changes' })).toBeNull()         // candidates are not listed as changes that reach it
    const rows = within(card.getByRole('list', { name: 'Possible references to contract changes' })).getAllByRole('listitem').filter((item) => item.querySelector(':scope > div > p'))
    expect(rows).toHaveLength(6)

    const item = rows.find((candidate) => candidate.textContent?.includes('changed from optional to required')) as HTMLElement
    const row = within(item)
    // Repository file and line, the operation, the changed field, and what the call was seen to do.
    expect(item.querySelector('p')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('GET /orders')
    expect(row.getByText('status')).toBeTruthy()
    const badge = row.getByText('Possible reference')
    expect(badge.className).toContain(TONE_STYLES.neutral.text)                       // never styled as a finding
    expect(row.queryByText('Required value not sent')).toBeNull()                     // the usage does not become the badge
    expect(row.getAllByText('src/client.js:3').some((element) => !collapsed(element))).toBe(true)     // the location is on the row itself
    expect(row.getByText(/seen at this call: required value not sent/)).toBeTruthy()
    expect(row.getByText('Confirm whether this call reaches this API. If it does, send status in this request before the provider is upgraded.')).toBeTruthy()
    // The backend's own words, including what ties nothing to the API, are one click away.
    expect(collapsed(row.getByText(/it is a possible reference, and whether it reaches this API is unverified/))).toBe(true)
    expect(collapsed(within(row.getByRole('list', { name: 'Calls matching this operation' })).getByText(/src\/client\.js:3/))).toBe(true)

    // A change with no matching string says so, and suggests no all-clear.
    const none = rows.filter((item) => within(item).queryByText('No usage found'))
    expect(none).toHaveLength(4)
    expect(within(none[0] as HTMLElement).getByText('Confirm manually. No matching call was found, which is not proof that this repository is unaffected.')).toBeTruthy()
    expect(card.getByText(/they are candidates: none is counted as usage/)).toBeTruthy()

    // Every string that matches a path of the API is listed, collapsed, with its location.
    const possible = card.getByRole('list', { name: 'Possible references' })
    expect(collapsed(possible)).toBe(true)
    expect(card.getByText('View possible references (2)')).toBeTruthy()
    expect(within(possible).getByText(/matches \/items/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bsafe\b|is compatible|no impact|confirmed/i)
  })

  it('words a candidate by its relationship first, whatever the call was seen to do', () => {
    const change = { change_type: 'NEW_REQUIRED_REQUEST_FIELD', method: 'GET', path: '/orders', field: 'status', field_in: 'query', previous_value: 'query parameter status: optional', new_value: 'query parameter status: required' }
    for (const usage of ['OMITS_REQUIRED_FIELD', 'READS_CHANGED_FIELD', 'CALLS_OPERATION', 'MAY_SEND_REQUIRED_FIELD', 'SENDS_REQUIRED_FIELD', 'FIELD_NOT_READ', 'NOT_DETERMINED', 'SOMETHING_NEW']) {
      expect(candidateAction(change, 'POSSIBLE_REFERENCE', usage)).toMatch(/^Confirm whether this call reaches this API\. If it does, /)
      expect(evidenceBadge('POSSIBLE_REFERENCE', usage)).toMatchObject({ label: 'Possible reference', tone: 'neutral' })
    }
    expect(candidateAction(change, 'POSSIBLE_REFERENCE', 'SENDS_REQUIRED_FIELD')).toContain('this request already sends the value')
    expect(candidateAction(change, 'POSSIBLE_REFERENCE', 'NOT_DETERMINED')).toContain('the analysis could not settle what it does')
    expect(candidateAction(change, 'NO_USAGE_FOUND', 'NO_USAGE_FOUND')).toContain('not proof that this repository is unaffected')
    expect(evidenceMeta('POSSIBLE_REFERENCE').known).toBe(true)
  })

  it('shows candidate signals and runtime-built requests with their locations, without calling them a relationship', () => {
    const dynamic = find(parsed(rawImpact).entries, 'billing-v2', 'dynamic_url_concat')
    expect(dynamic.candidate_evidence).toEqual([{ signal: 'identifier naming the API (billing)', file: 'client.py', line: 9 }])
    expect(dynamic.dynamic_urls).toHaveLength(1)
    render(<ContractAnalysis entries={[dynamic]} repoLabel={(name) => name} />)
    const card = within(cardFor('billing-v2', 'dynamic_url_concat'))
    expect(card.getByText('Unresolved', { selector: 'h3 ~ span *, h3 ~ span' })).toBeTruthy()
    const signals = card.getByRole('list', { name: 'Candidate signals' })
    expect(collapsed(signals)).toBe(true)
    expect(signals.textContent).toBe('identifier naming the API (billing) at client.py:9')
    expect(card.getByText(/tie no particular call to it/)).toBeTruthy()
    const runtime = card.getByRole('list', { name: 'Requests built at runtime' })
    expect(collapsed(runtime)).toBe(true)
    expect(within(runtime).getByText(new RegExp(`${dynamic.dynamic_urls?.[0]?.file}:${dynamic.dynamic_urls?.[0]?.line}`))).toBeTruthy()
    expect(card.getByText('View requests built at runtime (1)')).toBeTruthy()
    expect(card.getByText('View possible references (1)')).toBeTruthy()
  })

  it('derives summaries only from what the backend sent', () => {
    const change = { change_type: 'NEW_REQUIRED_REQUEST_FIELD', method: 'GET', path: '/pets', field: 'status', field_in: 'query', previous_value: 'query parameter status: optional', new_value: 'query parameter status: required' }
    expect(summarizeChange(change)).toEqual({ endpoint: 'GET /pets', subject: 'status', change: 'changed from optional to required', location: 'query parameter' })
    expect(suggestedAction(change)).toBe('Verify that consumers send status before upgrading.')
    expect(summarizeChange({ ...change, previous_value: 'query parameter status: absent' }).change).toBe('is new and required')
    expect(summarizeChange({ ...change, field: '', field_in: 'request_body', previous_value: 'request body: absent', new_value: 'request body: required' }).change).toBe('a request body is now required')
    expect(summarizeChange({ ...change, change_type: 'CHANGED_RESPONSE_FIELD_TYPE', field: 'data.[].id', field_in: 'response_body', previous_value: '200 response field data[].id: integer', new_value: '200 response field data[].id: null | string' }))
      .toMatchObject({ subject: 'data.id', change: 'changed type from integer to null | string', location: 'response field' })
    // A change type this dashboard does not know is shown as the backend named it, with its values.
    const odd = { change_type: 'REQUIRED_FIELD_ADDED', method: 'POST', path: '/v1/invoices', previous_value: 'currency: optional', new_value: 'currency: required' }
    expect(summarizeChange(odd).change).toBe('Required field added: currency: optional to currency: required')
    expect(suggestedAction(odd)).toBe('Review this change with the consumers of this API before upgrading.')
    // Unknown and no-usage evidence never turns into "nothing to do".
    for (const usage of ['NOT_DETERMINED', 'NO_USAGE_FOUND', 'FIELD_NOT_READ', 'MAY_SEND_REQUIRED_FIELD']) {
      expect(suggestedAction(change, usage)).not.toMatch(/no change needed|no action/i)
    }
    expect(suggestedAction(change, 'NO_USAGE_FOUND')).toMatch(/not proof/)
    // Statuses without a comparison suggest nothing that was not established.
    const entry = (status: string, consumer = '') => ({ provider_repo: 'p', consumer_repo: consumer, status, spec_file: '', message: '', findings: [] })
    expect(entryHeadline(entry('SPEC_UNAVAILABLE')).action).toBeNull()
    expect(entryHeadline(entry('SOMETHING_NEW')).action).toBeNull()
    expect(entryHeadline(entry('UNRESOLVED', 'c')).why).toMatch(/no operation could be matched or excluded/)
    expect(entryHeadline(entry('RELATIONSHIP_UNVERIFIED', 'c')).why).toMatch(/nothing was concluded/)
  })
})
