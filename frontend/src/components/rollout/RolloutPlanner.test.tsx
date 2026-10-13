// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../../App'
import { ApiFailure } from '../../api/errors'
import raw from '../../api/fixtures/rollout-results.json'
import {
  analyzeRollout,
  parseRolloutResult,
  RECOMMENDATIONS,
  rolloutErrorMessage,
  STATE_STATUSES,
  type AnalyzeRollout,
  type RolloutRequest,
  type RolloutResult,
} from '../../api/rolloutClient'
import { routeNameOf } from '../../hooks/useRoute'
import { TONE_STYLES } from '../../lib/classify'
import { conciseReason, rolloutChangeLines } from '../../lib/rollout'
import { RolloutPlanner, SAMPLE_REQUEST, validateRollout, whyText } from './RolloutPlanner'

/**
 * `rollout-results.json` is what POST /api/v1/rollout returned for six scenarios
 * against a faked GitHub. backend/tests/test_rollout.py fails when the backend's
 * output and this file differ, so these tests render real responses.
 */
const SCENARIOS = raw as Record<string, unknown>
const result = (name: string): RolloutResult => parseRolloutResult(SCENARIOS[name])

beforeAll(() => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

const VALUES = {
  'Provider GitHub URL': 'https://github.com/acme/billing',
  'Provider deployed ref': 'v1',
  'Provider proposed ref': 'v2',
  'Consumer GitHub URL': 'https://github.com/acme/shop/',
  'Consumer deployed ref': ' main ',
  'Consumer proposed ref': 'next',
}

function fill(values: Record<string, string> = VALUES) {
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } })
}

const press = () => fireEvent.click(screen.getByRole('button', { name: /Analyze Rollout|Analyzing rollout/ }))

async function show(name: string) {
  const analyze = vi.fn<AnalyzeRollout>(() => Promise.resolve(result(name)))
  render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
  fill()
  press()
  await screen.findByRole('region', { name: 'Recommendation' })
  return analyze
}

const card = (title: string) => within(screen.getByRole('region', { name: title }))

describe('rollout form', () => {
  it('has the six inputs, the Analyze Rollout button, and analyzes nothing on its own', () => {
    const analyze = vi.fn<AnalyzeRollout>()
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    for (const label of Object.keys(VALUES)) expect((screen.getByLabelText(new RegExp(`^${label}`)) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Analyze Rollout' })).toBeTruthy()
    for (const tag of ['P0', 'P1', 'C0', 'C1']) expect(screen.getByText(tag)).toBeTruthy()
    expect(analyze).not.toHaveBeenCalled()
    expect(screen.queryByRole('region', { name: 'Recommendation' })).toBeNull()
  })

  it('names what is missing instead of sending an incomplete request', () => {
    const analyze = vi.fn<AnalyzeRollout>()
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    press()
    expect(screen.getAllByText('Enter a GitHub repository URL.')).toHaveLength(2)
    expect(screen.getAllByText('Enter the branch, tag or commit that is deployed now.')).toHaveLength(2)
    fill({ ...VALUES, 'Provider GitHub URL': 'https://github.com/acme/billing/tree/main' })
    press()
    expect(screen.getByText(/without \/tree\//)).toBeTruthy()
    expect(analyze).not.toHaveBeenCalled()
    expect(validateRollout(SAMPLE_REQUEST)).toEqual({})
  })

  it('offers a public example as editable values and does not run it', () => {
    const analyze = vi.fn<AnalyzeRollout>()
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    fireEvent.click(screen.getByRole('button', { name: 'Fill in a public example' }))
    expect((screen.getByLabelText(/^Provider proposed ref/) as HTMLInputElement).value).toBe(SAMPLE_REQUEST.provider.proposed_ref)
    fireEvent.change(screen.getByLabelText(/^Consumer proposed ref/), { target: { value: 'my-branch' } })
    expect((screen.getByLabelText(/^Consumer proposed ref/) as HTMLInputElement).value).toBe('my-branch')
    expect(analyze).not.toHaveBeenCalled()
  })

  it('sends the trimmed values, shows a loading state, then the result', async () => {
    let finish: (value: RolloutResult) => void = () => undefined
    const analyze = vi.fn<AnalyzeRollout>(() => new Promise((resolve) => (finish = resolve)))
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    fill()
    press()
    const expected: RolloutRequest = {
      provider: { url: 'https://github.com/acme/billing', current_ref: 'v1', proposed_ref: 'v2' },
      consumer: { url: 'https://github.com/acme/shop', current_ref: 'main', proposed_ref: 'next' },
    }
    expect(analyze.mock.calls[0]?.[0]).toEqual(expected)
    const button = screen.getByRole('button', { name: /Analyzing rollout/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toMatch(/Fetching the four refs from GitHub/)
    press() // a second press while busy does nothing
    expect(analyze).toHaveBeenCalledTimes(1)
    await act(async () => finish(result('consumer_first')))
    expect(await screen.findByRole('heading', { name: 'Deploy the consumer first' })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    expect((screen.getByRole('button', { name: 'Analyze Rollout' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('rollout results', () => {
  it('shows both orders side by side with the consumer-first recommendation and its evidence', async () => {
    await show('consumer_first')
    expect(screen.getByRole('heading', { name: 'Deploy the consumer first' })).toBeTruthy()
    const provider = card('Provider first')
    const consumer = card('Consumer first')
    expect(provider.getAllByText('Incompatible')[0]?.className).toContain(TONE_STYLES.critical.text)
    expect(consumer.getByText('Compatible').className).toContain(TONE_STYLES.low.text)
    expect(consumer.getByText('Recommended order')).toBeTruthy()
    expect(provider.queryByText('Recommended order')).toBeNull()
    // The two cards share one grid row.
    expect(screen.getByRole('region', { name: 'Provider first' }).parentElement).toBe(screen.getByRole('region', { name: 'Consumer first' }).parentElement)
    expect(screen.getByRole('region', { name: 'Provider first' }).parentElement?.className).toContain('lg:grid-cols-2')
    // Which refs each state pairs.
    expect(provider.getByText('Provider P1 (v2)')).toBeTruthy()
    expect(provider.getByText('Consumer C0 (main)')).toBeTruthy()
    expect(consumer.getByText('Provider P0 (v1)')).toBeTruthy()
    expect(consumer.getByText('Consumer C1 (next)')).toBeTruthy()
    // The evidence: what the consumer code does, and where.
    expect(provider.getByText('Required value not sent')).toBeTruthy()
    expect(provider.getByText(/does not send request field 'currency': it sends amount/)).toBeTruthy()
    expect(provider.getByText('src/api.js:5')).toBeTruthy()
    expect(card('Both deployed').getByText('Sends required value')).toBeTruthy()
    // The detected change, with before and after.
    const changes = within(screen.getByRole('region', { name: 'From P0 to P1' }))
    expect(changes.getByText('New required request field')).toBeTruthy()
    expect(changes.getByText('request field currency: optional')).toBeTruthy()
    expect(changes.getByText('request field currency: required')).toBeTruthy()
  })

  it('shows exactly which refs and commits were read', async () => {
    await show('consumer_first')
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('rowheader')[0]?.textContent)).toEqual(['P0v1', 'P1v2', 'C0main', 'C1next'])
    const expected = result('consumer_first').refs
    rows.forEach((row, index) => {
      expect(within(row).getByText(expected[index]?.repository ?? '')).toBeTruthy()
      expect(within(row).getByText((expected[index]?.commit ?? '').slice(0, 10))).toBeTruthy()
    })
    expect(within(rows[0] as HTMLElement).getByText('openapi.json')).toBeTruthy()
    expect(within(rows[2] as HTMLElement).getByText('1 source file')).toBeTruthy()
  })

  it('renders either, provider first and neither as what they are', async () => {
    await show('either')
    expect(screen.getByRole('heading', { name: 'Either order' })).toBeTruthy()
    expect(screen.getAllByText('Recommended order')).toHaveLength(2)
    expect(screen.getByText(/Other kinds of difference are not checked/)).toBeTruthy()
    cleanup()

    await show('provider_first')
    expect(screen.getByRole('heading', { name: 'Deploy the provider first' })).toBeTruthy()
    expect(card('Consumer first').getByText('Calls removed operation')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'In P1 but not in P0' })).getByText('/refunds')).toBeTruthy()
    cleanup()

    await show('neither')
    expect(screen.getByRole('heading', { name: 'Neither order' })).toBeTruthy()
    expect(card('Provider first').getAllByText('Incompatible').length).toBeGreaterThan(0)
    expect(card('Consumer first').getAllByText('Incompatible').length).toBeGreaterThan(0)
    expect(screen.queryByText('Recommended order')).toBeNull()
    // The end state is unknown, and says so, although both intermediate states are decided.
    expect(card('Both deployed').getAllByText('Unknown')[0]?.className).toContain(TONE_STYLES.neutral.text)
  })

  it('shows insufficient evidence as unresolved, in neutral styling, with the reasons', async () => {
    await show('unresolved')
    const banner = screen.getByRole('region', { name: 'Recommendation' })
    expect(within(banner).getByRole('heading', { name: 'Unresolved' })).toBeTruthy()
    expect(banner.className).toContain(TONE_STYLES.neutral.tint)
    expect(banner.className).not.toContain(TONE_STYLES.low.tint)
    expect(within(banner).getByText(/This is not a statement that the rollout is unsafe/)).toBeTruthy()
    for (const title of ['Provider first', 'Consumer first']) {
      const badge = card(title).getAllByText('Unknown')[0] as HTMLElement
      expect(badge.className).toContain(TONE_STYLES.neutral.text)
      expect(badge.className).not.toContain(TONE_STYLES.low.text)
      expect(card(title).getByText(/Unknown is not compatible/)).toBeTruthy()
      expect(card(title).getByText('Reads changed field')).toBeTruthy()
      expect(card(title).getByText('src/api.js:7')).toBeTruthy()
      expect(card(title).getByText('Could not be established')).toBeTruthy()
    }
    expect(screen.queryByText('Compatible')).toBeNull()
    expect(screen.queryByText('Recommended order')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Unresolved' })).getAllByRole('listitem').length).toBeGreaterThan(0)
  })

  it('shows a fetch or parse failure as an honest unknown, naming the ref', async () => {
    await show('fetch_failure')
    expect(within(screen.getByRole('region', { name: 'Recommendation' })).getByRole('heading', { name: 'Unresolved' })).toBeTruthy()
    const unresolved = within(screen.getByRole('region', { name: 'Unresolved' }))
    expect(unresolved.getByText('P1')).toBeTruthy()
    expect(unresolved.getByText(/No OpenAPI or Swagger file was found/)).toBeTruthy()
    expect(card('Provider first').getByText(/This state could not be evaluated/)).toBeTruthy()
    const p1 = within(screen.getByRole('table')).getAllByRole('row')[2] as HTMLElement
    expect(within(p1).getByText(/No OpenAPI or Swagger file was found/)).toBeTruthy()
    expect(screen.queryByText('Compatible')).toBeNull()
    expect(screen.queryByText('Incompatible')).toBeNull()
  })

  it('states its limits and never promises safety', async () => {
    for (const name of Object.keys(SCENARIOS)) {
      await show(name)
      const text = document.body.textContent ?? ''
      expect(text).toMatch(/Nothing was executed, and this is not a guarantee about production/)
      expect(text).toMatch(/What this does not cover/)
      expect(text).not.toMatch(/\bsafe to deploy\b|guaranteed|confirmed/i)
      cleanup()
    }
    expect(new Set(Object.keys(SCENARIOS).map((name) => result(name).recommendation))).toEqual(new Set(RECOMMENDATIONS))
    const seen = Object.keys(SCENARIOS).flatMap((name) => [result(name).provider_first.status, result(name).consumer_first.status])
    expect(new Set(seen)).toEqual(new Set(STATE_STATUSES))
  })
})

describe('rollout errors', () => {
  it('shows a network failure and keeps the form for another try', async () => {
    const analyze = vi.fn<AnalyzeRollout>(() => Promise.reject(new ApiFailure('network')))
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    fill()
    press()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('The backend could not be reached')).toBeTruthy()
    expect(within(alert).getByText(/Start the backend, then analyze again/)).toBeTruthy()
    expect((screen.getByLabelText(/^Provider deployed ref/) as HTMLInputElement).value).toBe('v1')
    expect(screen.queryByRole('region', { name: 'Recommendation' })).toBeNull()
  })

  it('shows what the backend said about a rejected request, and clears an old result first', async () => {
    const analyze = vi
      .fn<AnalyzeRollout>()
      .mockResolvedValueOnce(result('either'))
      .mockRejectedValueOnce(new ApiFailure('http', { status: 400, errorCode: 'INVALID_TARGETS', serverMessage: 'Provider URL: The owner or repository name is not valid' }))
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    fill()
    press()
    expect(await screen.findByRole('heading', { name: 'Either order' })).toBeTruthy()
    press()
    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('Provider URL: The owner or repository name is not valid')).toBeTruthy()
    // The earlier verdict is gone: it does not belong to the inputs that just failed.
    expect(screen.queryByRole('heading', { name: 'Either order' })).toBeNull()
  })

  it('explains the other failures in plain words', () => {
    expect(rolloutErrorMessage(new ApiFailure('timeout')).title).toBe('The analysis took too long')
    expect(rolloutErrorMessage(new ApiFailure('http', { status: 404 }), 'http://x').message).toMatch(/does not serve POST \/api\/v1\/rollout/)
    expect(rolloutErrorMessage(new ApiFailure('http', { status: 401, serverMessage: 'Sign in with GitHub to analyze a rollout.' })).message).toMatch(/Sign in with GitHub/)
    expect(rolloutErrorMessage(new ApiFailure('shape')).message).toMatch(/a partly read result could mislead/)
    expect(rolloutErrorMessage(new Error('boom')).title).toBe('The analysis did not finish')
  })
})

describe('rollout client', () => {
  const request: RolloutRequest = { provider: { url: 'https://github.com/a/b', current_ref: 'v1', proposed_ref: 'v2' }, consumer: { url: 'https://github.com/c/d', current_ref: 'x', proposed_ref: 'y' } }
  const answer = (status: number, body: unknown) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })))

  it('posts the request to the documented endpoint with the session cookie', async () => {
    const fetchImpl = answer(200, SCENARIOS.neither)
    const parsed = await analyzeRollout(request, { baseUrl: 'http://backend', fetchImpl: fetchImpl as unknown as typeof fetch })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://backend/api/v1/rollout')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual(request)
    expect(parsed.recommendation).toBe('NEITHER')
    expect(parsed.provider_first.evidence[0]).toMatchObject({ verdict: 'INCOMPATIBLE', usage: 'CALLS_OPERATION', file: 'src/api.js' })
  })

  it('turns error bodies and unreadable answers into failures, never into a result', async () => {
    const rejected = analyzeRollout(request, { fetchImpl: answer(400, { error_code: 'INVALID_TARGETS', message: 'Consumer URL: bad', details: {} }) as unknown as typeof fetch })
    await expect(rejected).rejects.toMatchObject({ reason: 'http', status: 400, serverMessage: 'Consumer URL: bad' })
    await expect(analyzeRollout(request, { fetchImpl: answer(200, { recommendation: 'EITHER' }) as unknown as typeof fetch })).rejects.toMatchObject({ reason: 'shape' })
    await expect(analyzeRollout(request, { fetchImpl: answer(200, { summary: 'no verdict' }) as unknown as typeof fetch })).rejects.toMatchObject({ reason: 'shape' })
    const offline = vi.fn(() => Promise.reject(new TypeError('offline')))
    await expect(analyzeRollout(request, { fetchImpl: offline as unknown as typeof fetch })).rejects.toMatchObject({ reason: 'network' })
  })

  it('keeps a status it does not know visible instead of mapping it to a known one', async () => {
    const odd = { ...(SCENARIOS.either as object), recommendation: 'SOMETHING_NEW' }
    const analyze = vi.fn<AnalyzeRollout>(() => Promise.resolve(parseRolloutResult(odd)))
    render(<RolloutPlanner onBack={() => undefined} analyze={analyze} />)
    fill()
    press()
    const banner = await screen.findByRole('region', { name: 'Recommendation' })
    expect(within(banner).getByRole('heading', { name: 'SOMETHING_NEW' })).toBeTruthy()
    expect(banner.className).toContain(TONE_STYLES.neutral.tint)
  })
})

describe('navigation', () => {
  it('serves the planner at /rollout and links to it from the start page', async () => {
    expect(routeNameOf('/rollout')).toBe('rollout')
    expect(routeNameOf('/rollout/')).toBe('rollout')
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('no network in tests')))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Rollout planner' }))
    expect(window.location.pathname).toBe('/rollout')
    expect(await screen.findByRole('heading', { name: 'Which side should be deployed first?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Analyze Rollout' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Dependency scan/ }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(screen.queryByRole('button', { name: 'Analyze Rollout' })).toBeNull()
  })
})

describe('rollout results at a glance', () => {
  /** True when an element sits inside a collapsed disclosure, so a reader has to open it to see it. */
  const collapsed = (element: Element) => element.closest('details:not([open])') !== null && element.closest('summary') === null

  it('puts the recommendation and its reason first, and keeps the caveat visible', async () => {
    await show('consumer_first')
    const banner = screen.getByRole('region', { name: 'Recommendation' })
    // Nothing in the results comes before the recommendation.
    expect(banner.parentElement?.firstElementChild).toBe(banner)
    expect(within(banner).getByText('Recommended next action')).toBeTruthy()
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent)
    expect(headings.indexOf('Deploy the consumer first')).toBeLessThan(headings.indexOf('The two rollout orders'))
    const why = within(banner).getByText('Why:')
    // The reason is the backend's summary, without its opening sentence that repeats the heading.
    expect(result('consumer_first').summary).toBe('Deploy the consumer first. That intermediate state is supported by the evidence; deploying the provider first is not.')
    expect(why.parentElement?.textContent).toBe('Why: That intermediate state is supported by the evidence; deploying the provider first is not.')
    // Nothing but that repeated sentence is ever dropped.
    for (const name of Object.keys(SCENARIOS)) {
      const summary = result(name).summary
      const shown = whyText({ PROVIDER_FIRST: 'Deploy the provider first', CONSUMER_FIRST: 'Deploy the consumer first', EITHER: 'Either order', NEITHER: 'Neither order', UNRESOLVED: 'Unresolved' }[result(name).recommendation] ?? '', summary)
      expect(summary.endsWith(shown)).toBe(true)
      expect(shown.split('. ').length).toBeLessThanOrEqual(2)                                 // one or two short sentences
      expect(summary.length - shown.length).toBeLessThanOrEqual('Deploy the consumer first. '.length)
    }
    expect(whyText('Unresolved', 'Unresolved.')).toBe('Unresolved.')                         // never left empty
    expect(collapsed(within(banner).getByText(/Nothing was executed, and this is not a guarantee about production/))).toBe(false)
  })

  it('gives each order its status and one concise reason', async () => {
    await show('consumer_first')
    const provider = card('Provider first')
    const reason = provider.getByText('The consumer does not send the required currency on POST /invoices.')
    expect(collapsed(reason)).toBe(false)
    expect(collapsed(provider.getAllByText('Incompatible')[0] as HTMLElement)).toBe(false)
    const consumer = card('Consumer first')
    expect(collapsed(consumer.getByText('No detected contract change affects this order.'))).toBe(false)
    expect(collapsed(consumer.getByText('Compatible'))).toBe(false)
    expect(collapsed(consumer.getByText('Recommended order'))).toBe(false)
    expect(card('Both deployed').getByText('The consumer already satisfies the one detected change.')).toBeTruthy()
    // The three outcomes differ by more than colour: each badge has its own icon and word.
    const icons = ['Provider first', 'Consumer first'].map((title) => screen.getByRole('region', { name: title }).querySelector('header svg')?.getAttribute('class'))
    expect(new Set(icons).size).toBe(2)
  })

  it('moves source evidence, line numbers and the full reasoning into "View evidence"', async () => {
    await show('consumer_first')
    const region = screen.getByRole('region', { name: 'Provider first' })
    const details = region.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    const provider = within(region)
    expect(provider.getByText('View evidence (1)')).toBeTruthy()
    const hidden = [
      provider.getByText('src/api.js:5'),
      provider.getByText(/does not send request field 'currency': it sends amount/),
      provider.getByText('Provider P1 (v2)'),
      provider.getByText(result('consumer_first').provider_first.reason, { exact: false }),
      provider.getByText(/axios\.post\(`\$\{API\}\/invoices`, \{ amount \}\)/),
    ]
    expect(hidden.every(collapsed)).toBe(true)
    fireEvent.click(provider.getByText('View evidence (1)'))
    details.open = true // what a browser does on that click
    expect(hidden.some(collapsed)).toBe(false)
  })

  it('summarizes contract changes in one line each and folds the extended details away', async () => {
    await show('consumer_first')
    const brief = within(screen.getByRole('list', { name: 'Contract changes in brief' }))
    expect(brief.getAllByRole('listitem')).toHaveLength(1)
    expect(brief.getByText('POST /invoices')).toBeTruthy()
    expect(brief.getByText('currency')).toBeTruthy()
    expect(brief.getByText('changed from optional to required')).toBeTruthy()
    expect(brief.getByText('Matters if the provider goes first')).toBeTruthy()
    expect(collapsed(brief.getByText('changed from optional to required'))).toBe(false)
    const detail = screen.getByRole('region', { name: 'From P0 to P1' })
    expect(collapsed(detail)).toBe(true)
    expect(within(detail).getByText(/requestBody/)).toBeTruthy()       // the JSON pointer is still there
    expect(screen.getByText('Show contract details')).toBeTruthy()
    cleanup()

    // Something P1 adds is worded as an addition, and tied to the order it matters for.
    await show('provider_first')
    const added = within(screen.getByRole('list', { name: 'Contract changes in brief' }))
    expect(added.getByText('/refunds')).toBeTruthy()
    expect(added.getByText('path added in P1 (POST)')).toBeTruthy()
    expect(added.getByText('Matters if the consumer goes first')).toBeTruthy()
    expect(added.queryByText(/removed/)).toBeNull()
  })

  it('folds commit SHAs and limitations away without removing them', async () => {
    await show('consumer_first')
    const table = screen.getByRole('table')
    expect(collapsed(table)).toBe(true)
    expect(screen.getByText('Show analyzed refs')).toBeTruthy()
    expect(within(table).getByText(result('consumer_first').refs[0]?.commit.slice(0, 10) ?? '')).toBeTruthy()
    const limits = screen.getByText('What this does not cover')
    expect(collapsed(limits)).toBe(false)                                          // the label is visible
    expect(collapsed(screen.getByText(/Only three kinds of contract change are detected/))).toBe(true)
    // The refs themselves stay on screen by name.
    expect(collapsed(screen.getByText(/Result for provider/))).toBe(false)
  })

  it('keeps unknown outcomes and unresolved counts visible', async () => {
    await show('unresolved')
    for (const title of ['Provider first', 'Consumer first', 'Both deployed']) {
      const region = card(title)
      const badge = region.getAllByText('Unknown')[0] as HTMLElement
      expect(collapsed(badge)).toBe(false)
      expect(badge.className).toContain(TONE_STYLES.neutral.text)
      expect(collapsed(region.getByText('The effect of 1 of 1 detected change on the consumer is not known.'))).toBe(false)
      expect(collapsed(region.getByText('An unknown order is not treated as compatible.'))).toBe(false)
    }
    const unresolved = within(screen.getByRole('region', { name: 'Unresolved' }))
    const count = unresolved.getByText(/1 point could not be established\. None of this is evidence of compatibility\./)
    expect(collapsed(count)).toBe(false)
    expect(unresolved.getByText('Show unresolved details (1)')).toBeTruthy()
    expect(collapsed(unresolved.getByRole('listitem'))).toBe(true)                 // the full explanation is one click away
    // A type change seen from both directions is one line, marked as mattering either way.
    const brief = within(screen.getByRole('list', { name: 'Contract changes in brief' }))
    expect(brief.getAllByRole('listitem')).toHaveLength(1)
    expect(brief.getByText('changed type from integer to string')).toBeTruthy()
    expect(brief.getByText('Matters in both orders')).toBeTruthy()
  })

  it('shows a ref that could not be read as a visible warning, not a folded detail', async () => {
    await show('fetch_failure')
    const warning = screen.getByRole('status')
    expect(within(warning).getByText('1 ref could not be read')).toBeTruthy()
    expect(within(warning).getByText('P1')).toBeTruthy()
    expect(warning.textContent).toMatch(/No OpenAPI or Swagger file was found/)
    expect(collapsed(warning)).toBe(false)
    expect(card('Provider first').getByText('This order could not be evaluated.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Contract changes in brief' })).toBeNull()
  })

  it('restates only what the response says', () => {
    const state = (name: string, key: 'provider_first' | 'consumer_first' | 'final') => result(name)[key]
    expect(conciseReason(state('neither', 'provider_first'))).toBe('The consumer calls /invoices/{id}/void, which the provider does not have in this state.')
    expect(conciseReason(state('neither', 'consumer_first'))).toBe('The consumer calls /invoices/{id}/cancel, which the provider does not have in this state.')
    expect(conciseReason(state('either', 'provider_first'))).toBe('No detected contract change affects this order.')
    expect(conciseReason(state('fetch_failure', 'consumer_first'))).toBe('This order could not be evaluated.')
    // A status this page does not know keeps the backend's own reason.
    expect(conciseReason({ ...state('either', 'provider_first'), status: 'SOMETHING_NEW', reason: 'as sent' })).toBe('as sent')
    // Every scenario: a compatible line is produced only for a compatible state.
    for (const name of Object.keys(SCENARIOS)) {
      for (const key of ['provider_first', 'consumer_first', 'final'] as const) {
        const text = conciseReason(state(name, key))
        expect(/satisfies|No detected contract change affects/.test(text)).toBe(state(name, key).status === 'COMPATIBLE')
      }
      expect(rolloutChangeLines(result(name).contract_changes).length).toBeLessThanOrEqual(result(name).contract_changes.length)
    }
  })
})
