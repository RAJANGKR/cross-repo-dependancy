// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createDemoClient, demoRecord, type DemoVariant } from '../api/demoScan'
import { ApiFailure, toUiError } from '../api/errors'
import type { ScanRecord } from '../api/scanTypes'
import { AnnouncerProvider } from '../hooks/useAnnouncer'
import { useRoute } from '../hooks/useRoute'
import { sampleNotice, type SubmittedRepo } from '../hooks/useScan'
import { getStore, resetStoreForTests, updateStore } from '../lib/localStore'
import { newRow, type ScanTarget } from '../lib/targets'
import { AnalyzingState } from './analyzing/AnalyzingState'
import { ToastProvider } from './common/Controls'
import { RepoForm, type FormState } from './input/RepoForm'
import { ResultsScreen } from './results/ResultsScreen'
import { ErrorState } from './states/ErrorState'
// The scan the backend actually serves at GET /api/v1/demo, read from the backend's own file.
import savedDemo from '../../../backend/demo/demo_scan.json'
import rollouts from '../api/fixtures/rollout-results.json'

// The graph and chart libraries need real layout, which jsdom does not have.
vi.mock('./results/DependencyGraph', () => ({ default: () => <div data-testid="graph" /> }))
vi.mock('./results/DriftChart', () => ({ default: () => null }))

const clipboard = { writeText: vi.fn((_text: string) => Promise.resolve()), readText: vi.fn(() => Promise.resolve('https://github.com/pasted/from-clipboard')) }

beforeAll(() => {
  window.matchMedia = ((query: string) => ({
    matches: true, // reduced motion: numbers render at their final value
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('no network in tests')))
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
  // A plain in-memory Storage: newer Node versions ship a `localStorage` global that shadows jsdom's.
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const data = new Map<string, string>()
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size
      },
      dump: () => JSON.stringify([...data.entries()]),
    }
    Object.defineProperty(window, name, { value: storage, configurable: true })
    vi.stubGlobal(name, storage)
  }
})

beforeEach(() => {
  window.localStorage.clear()
  resetStoreForTests()
  // Most tests are not about the first-run tour.
  updateStore((store) => ({ ...store, settings: { ...store.settings, tourDone: true } }))
  clipboard.writeText.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('no network in tests')))
})

const SUBMITTED: SubmittedRepo[] = ['payment-service', 'core-service', 'customer-service'].map((name, index) => ({
  kind: 'github' as const,
  label: ['Payments', 'Core', 'Customers'][index] ?? name,
  url: `https://github.com/example-org/${name}`,
  name,
  ref: null,
  files: [],
}))

async function recordFor(variant: DemoVariant | null): Promise<ScanRecord> {
  const client = createDemoClient(variant)
  for (let poll = 0; poll < 10; poll += 1) {
    const record = await client.getScan({ scan_id: 'x', status: 'QUEUED', poll_url: null })
    if (record.result) return record
  }
  throw new Error('variant never completed')
}

const onScanAgain = vi.fn()

function Results({ record, submitted = SUBMITTED, source = 'demo' }: { record: ScanRecord; submitted?: SubmittedRepo[]; source?: 'demo' | 'live' }) {
  const route = useRoute()
  if (!record.result) throw new Error('record has no result')
  return (
    <AnnouncerProvider>
      <ToastProvider>
        <ResultsScreen record={record} result={record.result} source={source} submitted={submitted} search={route.search} onNewScan={() => undefined} onScanAgain={onScanAgain} onRunAgain={() => undefined} />
      </ToastProvider>
    </AnnouncerProvider>
  )
}

function Form({ onSubmit }: { onSubmit: (targets: ScanTarget[]) => void }) {
  const [form, setForm] = useState<FormState>({ tab: 'github', rows: [0, 1, 2].map(() => newRow()), projects: [] })
  return (
    <AnnouncerProvider>
      <ToastProvider>
        <RepoForm form={form} onChange={setForm} onSubmit={onSubmit} onLoadDemo={() => undefined} busy={false} error={null} onDismissError={() => undefined} />
      </ToastProvider>
    </AnnouncerProvider>
  )
}

const urlField = (index: number) => screen.getByLabelText(`GitHub repository URL ${index}`) as HTMLInputElement
const type = (index: number, value: string) => fireEvent.change(urlField(index), { target: { value } })
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const analyze = () => click(/Analyze repositories/)
const openView = (name: string) => fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Views' })[0] as HTMLElement).getByRole('button', { name: new RegExp(name) }))
const table = () => screen.getByRole('grid', { name: /Dependency comparison/ })

describe('repository form', () => {
  it('starts with three rows and grows to ten, then stops', () => {
    render(<Form onSubmit={vi.fn()} />)
    expect(screen.getAllByLabelText(/GitHub repository URL/)).toHaveLength(3)
    for (let count = 3; count < 10; count += 1) click('Add repository')
    expect(screen.getAllByLabelText(/GitHub repository URL/)).toHaveLength(10)
    expect((screen.getByRole('button', { name: 'Add repository' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('removes, reorders and clears rows', () => {
    render(<Form onSubmit={vi.fn()} />)
    type(1, 'https://github.com/a/one')
    type(2, 'https://github.com/a/two')
    click('Move repository 1 down')
    expect(urlField(1).value).toBe('https://github.com/a/two')
    expect(urlField(2).value).toBe('https://github.com/a/one')
    click('Remove repository 3')
    expect(screen.getAllByLabelText(/GitHub repository URL/)).toHaveLength(2)
    click('Clear URL 1')
    expect(urlField(1).value).toBe('')

    click('Clear all')
    expect(urlField(2).value).toBe('https://github.com/a/one') // nothing happens until confirmed
    click('Clear 1 links and 0 pasted projects')
    expect(screen.getAllByLabelText(/GitHub repository URL/)).toHaveLength(3)
    expect(urlField(1).value).toBe('')
  })

  it('pastes from the clipboard into one field', async () => {
    render(<Form onSubmit={vi.fn()} />)
    await act(async () => {
      click('Paste into URL 2')
    })
    expect(urlField(2).value).toBe('https://github.com/pasted/from-clipboard')
  })

  it('blocks a scan with fewer than two repositories and says why', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    type(1, 'https://github.com/a/one')
    analyze()
    // Shown under the button and announced to screen readers.
    expect(screen.getAllByText(/Add at least 2 repositories or pasted projects/).length).toBeGreaterThan(0)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('reports malformed and duplicate links', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    type(1, 'https://github.com/example-org/core-service')
    type(2, 'https://github.com/Example-Org/Core-Service')
    type(3, 'gitlab.com/x/y')
    analyze()
    expect(screen.getByText('This repository and branch are already listed above')).toBeTruthy()
    expect(screen.getByText(/Use a public repository URL/)).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(urlField(2))
  })

  it('submits two repositories with labels and a branch from the branch field', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    // Labels start empty. One is typed here; the other falls back to the repository name.
    expect(screen.getAllByLabelText(/^Label [0-9]+, optional$/).map((field) => (field as HTMLInputElement).value)).toEqual(['', '', ''])
    fireEvent.change(screen.getByLabelText('Label 1, optional'), { target: { value: 'Billing API' } })
    type(1, 'https://github.com/example-org/payment-service')
    type(3, 'https://github.com/example-org/customer-service.git')
    fireEvent.change(screen.getByLabelText('Branch or tag 3'), { target: { value: 'release/2.x' } })
    analyze()
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      { kind: 'github', label: 'Billing API', name: 'payment-service', url: 'https://github.com/example-org/payment-service', ref: null, files: [] },
      { kind: 'github', label: 'customer-service', name: 'customer-service', url: 'https://github.com/example-org/customer-service', ref: 'release/2.x', files: [] },
    ])
  })

  it('sends pasted manifests and never writes them to browser storage', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    type(1, 'https://github.com/example-org/payment-service')
    fireEvent.click(screen.getByRole('tab', { name: /Paste manifests/ }))
    click('Add project')
    fireEvent.change(screen.getByLabelText('Project name 1'), { target: { value: 'billing' } })
    fireEvent.change(screen.getByLabelText(/Manifest content, file 1/), { target: { value: 'private-internal-lib==9.9.9\nflask==3.0.0' } })
    expect(screen.getByText('Detected from content')).toBeTruthy()
    analyze()

    const targets = onSubmit.mock.calls[0]?.[0] as ScanTarget[]
    expect(targets[1]).toEqual({ kind: 'pasted', label: 'billing', name: 'billing', url: null, ref: null, files: [{ filename: 'requirements.txt', content: 'private-internal-lib==9.9.9\nflask==3.0.0' }] })
    expect((window.localStorage as unknown as { dump: () => string }).dump()).not.toContain('private-internal-lib')
    expect(window.sessionStorage.length).toBe(0)
    expect(window.location.href).not.toContain('private-internal-lib')
  })

  it('inserts an example and adds or removes files in a pasted project', () => {
    render(<Form onSubmit={vi.fn()} />)
    fireEvent.click(screen.getByRole('tab', { name: /Paste manifests/ }))
    click('Add project')
    click('Insert example')
    expect((screen.getByLabelText(/Manifest content, file 1/) as HTMLTextAreaElement).value).toContain('"axios"')
    click('Add file')
    expect(screen.getAllByLabelText(/Manifest content/)).toHaveLength(2)
    click(/Remove file 2/)
    expect(screen.getAllByLabelText(/Manifest content/)).toHaveLength(1)
    click(/Remove project/)
    expect(screen.queryByLabelText('Project name 1')).toBeNull()
  })
})

describe('scan progress', () => {
  it('shows the current stage, the backend action and the percentage', () => {
    render(<AnalyzingState source="live" startedAt={Date.now()} scanId="scn_a1" status="PARSING" progress={{ stage: 'PARSING', percentage: 50, current_action: 'Parsing 4 manifests' }} repos={SUBMITTED} onCancel={() => undefined} />)
    expect(screen.getByText('Parsing 4 manifests')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    const stages = within(screen.getByRole('list', { name: 'Scan stages' })).getAllByRole('listitem')
    expect(stages.map((stage) => stage.getAttribute('aria-current'))).toEqual([null, null, 'step', null])
  })

  it('does not invent a percentage or a stage for an unknown status', () => {
    render(<AnalyzingState source="live" startedAt={Date.now()} scanId={null} status="RESOLVING" progress={null} repos={[]} onCancel={() => undefined} />)
    expect(screen.getByText('Status: RESOLVING')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  })
})

describe('console', () => {
  it('opens on the command center with KPIs, priority drifts and repository health', async () => {
    render(<Results record={demoRecord()} />)
    expect(screen.getByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(screen.getByText('Scan completed with warnings.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /See what was and was not analyzed/ }))
    expect(screen.getByRole('heading', { name: 'Repositories' })).toBeTruthy()
    openView('Command center')
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)
    for (const kpi of ['Active drifts', 'Shared libraries', 'Vulnerable versions', 'Pending review']) {
      expect(screen.getByRole('button', { name: new RegExp(`^(\\d+|Not available)${kpi}`) })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: /^6Active drifts/ })).toBeTruthy()
    const priority = screen.getByRole('region', { name: /Priority drifts \(6\)/ })
    expect(within(priority).getAllByRole('button', { name: 'Review drift' })).toHaveLength(6)
    expect(screen.getByText(/Grade: 100 minus 25 per confirmed break/)).toBeTruthy()
    expect(screen.getByTitle('Health score 28 of 100').textContent).toContain('F')
    expect(await screen.findByTestId('graph')).toBeTruthy()
  })

  it('navigates from a KPI card to the filtered drift table', () => {
    render(<Results record={demoRecord()} />)
    click(/Vulnerable versions/)
    expect(window.location.search).toContain('view=drifts')
    expect(screen.getByRole('button', { name: 'Has vulnerability' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(table()).getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual(['axiosnpm'])
  })

  it('shows declared and resolved versions separately in the table', () => {
    render(<Results record={demoRecord()} />)
    openView('Active drifts')
    const reactRow = within(table()).getByRole('rowheader', { name: /react/ }).closest('tr') as HTMLElement
    for (const text of ['^18.2.0', '18.2.0', 'Not resolved', 'Not declared', 'Major drift', 'Confirmed breaking']) {
      expect(within(reactRow).getByText(text)).toBeTruthy()
    }
    expect(within(table()).getByText('Payments')).toBeTruthy()
  })

  it('filters from the URL, reverses the sort and applies quick toggles', () => {
    window.history.replaceState(null, '', '/results?view=drifts&drift=MAJOR_DRIFT')
    render(<Results record={demoRecord()} />)
    const packages = () => within(table()).getAllByRole('rowheader').map((cell) => cell.textContent?.replace(/npm|Python/, ''))
    expect(packages()).toEqual(['react', 'pydantic', 'axios'])
    fireEvent.click(within(table()).getByRole('button', { name: 'Package' }))
    expect(packages()).toEqual(['axios', 'pydantic', 'react'])
    click('Has fix')
    expect(packages()).toEqual(['axios', 'pydantic', 'react'])
    fireEvent.click(screen.getByLabelText('Compact rows'))
    expect(getStore().settings.density).toBe('compact')
  })

  it('selects rows for bulk actions and marks them reviewed, with undo', () => {
    window.history.replaceState(null, '', '/results?view=drifts&drift=MAJOR_DRIFT')
    render(<Results record={demoRecord()} />)
    fireEvent.click(screen.getByLabelText('Select all shown packages'))
    expect(within(screen.getByRole('region', { name: 'Bulk actions' })).getByText('3 selected')).toBeTruthy()
    click('Mark reviewed')
    expect(Object.keys(getStore().reviews)).toHaveLength(3)
    click('Undo')
    expect(getStore().reviews).toEqual({})
  })

  it('saves and applies a filter view in this browser', () => {
    window.history.replaceState(null, '', '/results?view=drifts&risk=CONFIRMED_BREAKING')
    render(<Results record={demoRecord()} />)
    click(/Saved views \(0\)/)
    fireEvent.change(screen.getByLabelText('Name for this view'), { target: { value: 'Breaking' } })
    click('Save this view')
    expect(getStore().views).toEqual([{ name: 'Breaking', search: '?risk=CONFIRMED_BREAKING' }])
  })

  it('opens the detail panel with tabs, a copyable fix and review actions', async () => {
    render(<Results record={demoRecord()} />)
    fireEvent.click(within(screen.getByRole('region', { name: /Priority drifts/ })).getAllByRole('button', { name: 'Review drift' })[2] as HTMLElement)
    const dialog = screen.getByRole('dialog')
    expect(window.location.search).toContain('selected=npm%3Aaxios')
    expect(within(dialog).getByRole('heading', { name: 'axios' })).toBeTruthy()
    expect(within(dialog).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Evidence', 'Versions', 'Fix', 'Notes'])

    // Overview: score, confidence, missing signals, vulnerability and explanation label.
    expect(within(dialog).getByText('Generated from rules')).toBeTruthy()
    expect(within(dialog).getByText('Major version gap')).toBeTruthy()
    expect(within(dialog).getByRole('meter', { name: 'Confidence' }).getAttribute('aria-valuenow')).toBe('0.55')
    expect(within(dialog).getByText('No release notes were retrieved for these versions')).toBeTruthy()
    expect(within(dialog).getByRole('link', { name: 'GHSA-wf5p-g6vw-rhxx' }).getAttribute('href')).toBe('https://osv.dev/vulnerability/GHSA-wf5p-g6vw-rhxx')

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Evidence' }))
    expect(within(dialog).getByText(/not assessed, not that it is safe/)).toBeTruthy()
    expect(within(dialog).getByText(/Error handling may behave differently/)).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Versions' }))
    expect(within(dialog).getByText('Not resolved, no lockfile entry')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Fix' }))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy fix for Payments' }))
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('"axios": "^1.6.2"')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy as PR description' }))
    })
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toContain('## Align axios on ^1.6.2')

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Notes' }))
    expect((within(dialog).getByRole('button', { name: 'Dismiss' }) as HTMLButtonElement).disabled).toBe(true) // needs a reason
    fireEvent.click(within(dialog).getByRole('button', { name: 'Snooze 1 week' }))
    expect(getStore().reviews['npm:axios']?.status).toBe('snoozed')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }))
    expect(getStore().reviews['npm:axios']?.status).toBe('accepted')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens GitHub\'s editor with the fix copied, for a live scan', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<Results record={demoRecord()} source="live" />)
    openView('Fix plans')
    const button = screen.getAllByRole('button', { name: /Open pull request on GitHub for fastapi in Payments/ })[0] as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('"fastapi>=0.110.0",')
    expect(open).toHaveBeenCalledWith(
      'https://github.com/GoogleCloudPlatform/microservices-demo/edit/main/pyproject.toml',
      '_blank',
      'noopener,noreferrer',
    )
    expect(screen.getByText(/Paste it over the old line on GitHub, then choose Propose changes/)).toBeTruthy()
    open.mockRestore()
  })

  it('does not offer the GitHub editor for demo data', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<Results record={demoRecord()} />)
    openView('Fix plans')
    const button = screen.getAllByRole('button', { name: /Open pull request on GitHub for/ })[0] as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Not available for demo data')
    fireEvent.click(button)
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('hides source code in Executive view', () => {
    render(<Results record={demoRecord()} />)
    openView('Risk intelligence')
    expect(screen.getByText(/Matched on the literal URL string/)).toBeTruthy()
    click('executive')
    expect(screen.queryByText(/Matched on the literal URL string/)).toBeNull()
    expect(screen.getByText(/Source-code evidence is hidden in Executive view/)).toBeTruthy()
    expect(screen.getByText('No specification found')).toBeTruthy()
  })

  it('works through the review queue and fix plans', async () => {
    render(<Results record={demoRecord()} />)
    openView('Review queue')
    expect(screen.getByRole('button', { name: 'pending (6)' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0] as HTMLElement)
    expect(screen.getByRole('button', { name: 'pending (5)' })).toBeTruthy()
    click('Bulk accept')
    click('Accept 5 drifts')
    expect(screen.getByText('No drifts are waiting for review.')).toBeTruthy()
    click('accepted (6)')
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0] as HTMLElement)
    expect(screen.getByRole('button', { name: 'pending (1)' })).toBeTruthy()

    openView('Fix plans')
    expect(screen.getByText(/0 of 1\d fixes marked done|0 of \d fixes marked done/)).toBeTruthy()
    fireEvent.click(screen.getAllByLabelText('Mark fix as done')[0] as HTMLElement)
    expect(getStore().fixesDone).toHaveLength(1)
    await act(async () => {
      click('Copy all fixes')
    })
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toContain('## Payments')
  })

  it('compares two repositories and lists what was analyzed', () => {
    render(<Results record={demoRecord()} />)
    openView('Repositories')
    expect(screen.getAllByText('Analyzed')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Compare two repositories' })).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Show manifests'))
    expect(screen.getByText('package.json, package-lock.json, pyproject.toml')).toBeTruthy()
    click('Retry scan')
    expect(onScanAgain).toHaveBeenCalled()
  })

  it('changes settings and clears local data only after confirmation', () => {
    render(<Results record={demoRecord()} />)
    openView('Settings')
    fireEvent.change(screen.getByLabelText('theme'), { target: { value: 'dark' } })
    expect(document.documentElement.dataset.theme).toBeUndefined() // applied by App's useTheme, not here
    expect(getStore().settings.theme).toBe('dark')
    click('Clear local data')
    expect(getStore().settings.theme).toBe('dark')
    click(/^Delete 0 decisions/)
    expect(getStore().settings.theme).toBe('system')
    click('Undo')
    expect(getStore().settings.theme).toBe('dark')
  })

  it('opens the command palette and shortcuts from the keyboard', () => {
    render(<Results record={demoRecord()} />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    const palette = screen.getByRole('dialog')
    fireEvent.change(within(palette).getByRole('combobox'), { target: { value: 'fix plans' } })
    expect(within(palette).getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(within(palette).getByRole('combobox'), { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Fix plans' })).toBeTruthy()

    fireEvent.keyDown(document, { key: '?' })
    expect(within(screen.getByRole('dialog')).getByText('Open the command palette')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.keyDown(document, { key: '2' })
    expect(window.location.search).toContain('view=drifts')
  })

  it('shows data sources, notifications and a team message that is copied, not sent', async () => {
    render(<Results record={demoRecord()} />)
    click(/Data sources \(5 connected\)/)
    expect(within(screen.getByRole('dialog', { name: 'Data sources' })).getAllByText('Connected').length).toBeGreaterThan(0)
    click(/Notifications, 4 unread/)
    click('Mark all read')
    expect(screen.getByRole('button', { name: 'Notifications, 0 unread' })).toBeTruthy()
    click('Notify team')
    const dialog = screen.getByRole('dialog', { name: 'Notify team' })
    expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toContain('react: Major drift, Confirmed breaking')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Copy message' }))
    })
    expect(clipboard.writeText).toHaveBeenCalled()
  })

  it('runs the first-run tour once', () => {
    updateStore((store) => ({ ...store, settings: { ...store.settings, tourDone: false } }))
    render(<Results record={demoRecord()} />)
    const tour = screen.getByRole('dialog')
    expect(within(tour).getByText('Step 1 of 4')).toBeTruthy()
    fireEvent.click(within(tour).getByRole('button', { name: 'Next' }))
    expect(within(screen.getByRole('dialog')).getByText('Step 2 of 4')).toBeTruthy()
    click("Don't show again")
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(getStore().settings.tourDone).toBe(true)
  })

  it('renders when every optional field is absent, without showing zeroes', async () => {
    render(<Results record={await recordFor('minimal')} />)
    expect(screen.getByText('Scan completed.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Not availableVulnerable versions/ })).toBeTruthy()
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(3)
    click(/Data sources \(0 connected\)/)
    expect(screen.getByText(/did not report its data sources/)).toBeTruthy()
    openView('Risk intelligence')
    expect(screen.getByText(/did not return API contract analysis/)).toBeTruthy()
    expect(screen.getByText(/did not return call-site analysis/)).toBeTruthy()
    openView('Repositories')
    expect(screen.getAllByText(/Not in the results/)).toHaveLength(3)
    openView('Fix plans')
    expect(screen.getByText(/No fix lines are available/)).toBeTruthy()
  })

  it('keeps a partial result usable and says what was not analyzed', async () => {
    render(<Results record={await recordFor('partial')} />)
    expect(screen.getByText('Scan completed with warnings.')).toBeTruthy()
    expect(screen.getByText(/1 repository not fully analyzed/)).toBeTruthy()
    openView('Repositories')
    expect(screen.getByText(/No supported manifests were found/)).toBeTruthy()
    expect(screen.getByText(/could not be fetched \(404\)/)).toBeTruthy()
  })

  it('labels pasted input and says so when nothing has drifted', async () => {
    const pasted: SubmittedRepo[] = [...SUBMITTED.slice(0, 2), { kind: 'pasted', label: 'billing', name: 'billing', url: null, ref: null, files: [] }]
    render(<Results record={await recordFor('empty')} submitted={pasted} />)
    expect(screen.getByText(/Pasted input \(billing\): no code scan/)).toBeTruthy()
    openView('Active drifts')
    expect(screen.getByText('No drift found.')).toBeTruthy()
  })
})

describe('error state', () => {
  it('shows the backend message and code, offers a retry and copies the details', async () => {
    const onAction = vi.fn()
    const error = toUiError(new ApiFailure('scan-failed', { errorCode: 'SCAN_FAILED', serverMessage: 'Unexpected failure during dependency graph generation.' }))
    render(
      <ToastProvider>
        <ErrorState error={error} demo={false} onAction={onAction} />
      </ToastProvider>,
    )
    expect(screen.getByText('Error code: SCAN_FAILED')).toBeTruthy()
    click('Retry scan')
    expect(onAction).toHaveBeenCalledWith('retry')
    await act(async () => {
      click('Copy error details')
    })
    expect(clipboard.writeText.mock.calls.at(-1)?.[0]).toContain('SCAN_FAILED')
  })
})

/** Answers GET /auth/me as the backend would; every other request fails, as with no network. */
function stubAuth(reply: { configured: boolean; user: { login: string } | null; required?: boolean } | null) {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
    reply && String(input).endsWith('/auth/me')
      ? Promise.resolve(new Response(JSON.stringify({ required: true, ...reply }), { status: 200 }))
      : Promise.reject(new TypeError('no network in tests')),
  )
}

describe('sign-in is optional', () => {
  it('lets a signed-out visitor use the app and offers sign-in in the top bar', async () => {
    stubAuth({ configured: true, user: null, required: false })
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Analyze repositories/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load demo run' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Sign in to continue' })).toBeNull()
  })

  it('works with no backend at all', () => {
    render(<App />)
    expect(screen.getByRole('button', { name: /Analyze repositories/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Load demo run' })).toBeTruthy()
  })
})

describe('a backend that requires sign-in', () => {
  it('shows only the sign-in screen to a signed-out visitor', async () => {
    stubAuth({ configured: true, user: null })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeTruthy()
    expect(((await screen.findByRole('button', { name: 'Sign in with GitHub' })) as HTMLButtonElement).disabled).toBe(false)
    // No way around it: no form, no demo.
    expect(screen.queryByRole('button', { name: /Analyze repositories/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Load demo run' })).toBeNull()
  })

  it('also guards a direct link to the results', async () => {
    window.history.replaceState(null, '', '/results?view=drifts')
    stubAuth({ configured: true, user: null })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Sign in to continue' })).toBeTruthy()
  })

  it('says why sign-in is impossible when the backend has no GitHub app', async () => {
    stubAuth({ configured: false, user: null })
    render(<App />)
    expect(((await screen.findByRole('button', { name: 'Sign in with GitHub' })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/GitHub sign-in is not set up on the backend yet/)).toBeTruthy()
  })

})

describe('app', () => {
  it('plays the sample through polling to the console when there is no backend, says so, records history and applies the theme', async () => {
    vi.useFakeTimers()
    render(<App />) // signed out, with no backend: "Load demo run" still opens something, and labels it for what it is
    expect(document.documentElement.dataset.theme).toBeDefined()
    click('Load demo run')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(screen.getByRole('heading', { name: 'Playing the sample scan' })).toBeTruthy()
    expect(screen.getByText(/The saved demo scan could not be loaded: the backend could not be reached\./)).toBeTruthy()
    // A second submission while a scan is running is not possible: the form is gone.
    expect(screen.queryByRole('button', { name: /Analyze repositories/ })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(screen.getByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(window.location.pathname).toBe('/results')
    // Never passed off as the backend's saved scan: its own label, and the reason, on the results.
    expect(screen.getAllByText('Sample data').length).toBeGreaterThan(0)
    expect(screen.queryByText('Demo data')).toBeNull()
    expect(screen.getByText('Showing sample data')).toBeTruthy()
    expect(screen.getByText(sampleNotice(new ApiFailure('network')))).toBeTruthy()
    expect(getStore().history).toHaveLength(1)
    expect(getStore().history[0]).toMatchObject({ source: 'demo', drifted: 6 })

    click('New scan')
    expect(screen.getByRole('region', { name: 'Recent scans' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Run again' }) as HTMLButtonElement).disabled).toBe(true) // demo data is not re-run as a real scan
  })
})

/** Answers GET /api/v1/demo with `reply`; every other request fails, as with no network. Returns the requests made. */
function stubDemo(reply: () => Response) {
  const calls: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
    return url.endsWith('/api/v1/demo') ? Promise.resolve(reply()) : Promise.reject(new TypeError('no network in tests'))
  })
  return calls
}
const savedReply = () => new Response(JSON.stringify(savedDemo), { status: 200 })

describe('load demo run', () => {
  it('requests the saved scan from the backend and shows that scan, labelled as demo data', async () => {
    const calls = stubDemo(savedReply)
    render(<App />)
    click('Load demo run')
    expect(await screen.findByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(window.location.pathname).toBe('/results')

    // One request for the saved run. Nothing is submitted as a scan, and nothing is polled.
    expect(calls.filter((call) => call.includes('/api/v1/demo'))).toEqual(['GET /api/v1/demo'])
    expect(calls.some((call) => call.includes('/scans'))).toBe(false)

    // Labelled as demo data, and not as the sample or as a live scan.
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)
    expect(screen.queryByText('Sample data')).toBeNull()
    expect(screen.queryByText('Live scan')).toBeNull()
    expect(screen.queryByText('Showing sample data')).toBeNull()
    expect(screen.getByText(`Scan ${savedDemo.scan_id}`)).toBeTruthy()

    // What is on screen is the backend's record: its repositories and every one of its packages, none of the sample's.
    openView('Active drifts')
    const grid = within(table())
    const columns = grid.getAllByRole('columnheader').map((cell) => cell.textContent ?? '')
    for (const repo of savedDemo.result.scanned_repositories) expect(columns.some((text) => text.includes(repo.name))).toBe(true)
    const packages = grid.getAllByRole('rowheader').map((cell) => cell.textContent ?? '')
    expect(packages).toHaveLength(savedDemo.result.drift_matrix.length)
    for (const row of savedDemo.result.drift_matrix) expect(packages.some((text) => text.startsWith(row.dependency_name))).toBe(true)
    expect(document.body.textContent).not.toContain('payment-service')

    // It is a real record, so the hand-written sections of the sample are not shown for it.
    openView('Risk intelligence')
    expect(screen.getByText(/The backend did not return API contract analysis for this scan/)).toBeTruthy()
    expect(screen.queryByText('Preview format')).toBeNull()

    // A replayed scan offers no pull request, and history records it as demo data under its own repositories.
    openView('Fix plans')
    const button = screen.getAllByRole('button', { name: /Open pull request on GitHub for/ })[0] as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Not available for demo data')
    const drifted = savedDemo.result.drift_matrix.filter((row) => row.drift_disparity === 'MAJOR_DRIFT' || row.drift_disparity === 'MINOR_DRIFT').length
    expect(getStore().history[0]).toMatchObject({ source: 'demo', drifted })
    expect(getStore().history[0]?.targets.map((target) => target.label)).toEqual(savedDemo.result.scanned_repositories.map((repo) => repo.name))
  })

  it('shows the loading state while the saved scan is on its way', async () => {
    let answer: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      String(input).endsWith('/api/v1/demo') ? new Promise<Response>((resolve) => { answer = resolve }) : Promise.reject(new TypeError('no network in tests')))
    render(<App />)
    click('Load demo run')
    expect(await screen.findByRole('heading', { name: 'Loading the saved demo scan' })).toBeTruthy()
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Load demo run' })).toBeNull()             // it cannot be requested twice
    await act(async () => answer(savedReply()))
    expect(await screen.findByRole('heading', { name: 'Command center' })).toBeTruthy()
  })

  it.each([
    ['the backend has no saved run', () => new Response(JSON.stringify({ error_code: 'DEMO_NOT_AVAILABLE', message: 'No saved demo run is available on this backend.', details: {} }), { status: 404 }), 'No saved demo run is available on this backend'],
    ['the saved record is not a finished scan', () => new Response(JSON.stringify({ ...savedDemo, result: null }), { status: 200 }), 'the backend sent a record that could not be read as a finished scan'],
    ['the backend fails', () => new Response('Internal Server Error', { status: 500 }), 'the backend answered with status 500'],
  ])('falls back to the sample when %s, and says exactly that', async (_name, reply, reason) => {
    vi.useFakeTimers()
    const calls = stubDemo(reply)
    render(<App />)
    click('Load demo run')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(screen.getByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(calls.filter((call) => call.includes('/api/v1/demo'))).toHaveLength(1)
    expect(screen.getAllByText('Sample data').length).toBeGreaterThan(0)
    expect(screen.queryByText('Demo data')).toBeNull()
    const notice = screen.getByText(`The saved demo scan could not be loaded: ${reason}. Showing the sample built into the app instead: illustrative data, not the output of a real scan.`)
    expect(within(notice.closest('[role="status"]') as HTMLElement).getByText('Showing sample data')).toBeTruthy()
    // The notice stays with the results on every view.
    openView('Fix plans')
    expect(screen.getByText('Showing sample data')).toBeTruthy()
    expect((screen.getAllByRole('button', { name: /Open pull request on GitHub for/ })[0] as HTMLButtonElement).title).toBe('Not available for sample data')
    // The sample's hand-written sections keep their marker.
    openView('Risk intelligence')
    expect(screen.getAllByText('Preview format').length).toBeGreaterThan(0)
  })

  it('asks the backend again on "Scan again" after a fallback, instead of replaying the sample', async () => {
    vi.useFakeTimers()
    stubDemo(() => new Response('gone', { status: 503 }))
    render(<App />)
    click('Load demo run')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    expect(screen.getAllByText('Sample data').length).toBeGreaterThan(0)

    const calls = stubDemo(savedReply)       // the backend is back
    click('Scan again')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(calls).toContain('GET /api/v1/demo')
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)
    expect(screen.queryByText('Sample data')).toBeNull()
    expect(screen.queryByText('Showing sample data')).toBeNull()
  })
})

describe('assistant in the app', () => {
  /** A backend that serves the saved demo, a rollout analysis and the assistant; it keeps what the assistant was sent. */
  function stubBackend() {
    const asked: { message: string; history: unknown[]; context: { scan: { scanned_repositories: { name: string }[] } | null; scan_id: string; scan_source: string; rollout: { recommendation: string } | null; view: string } }[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/v1/demo')) return Promise.resolve(new Response(JSON.stringify(savedDemo), { status: 200 }))
      if (url.endsWith('/api/v1/rollout')) return Promise.resolve(new Response(JSON.stringify(rollouts.consumer_first), { status: 200 }))
      if (url.endsWith('/api/v1/assistant/chat')) {
        asked.push(JSON.parse(String(init?.body)))
        return Promise.resolve(new Response(JSON.stringify({ answer: `Answer ${asked.length} from the results.`, source: 'gemini', notice: '', used: {} }), { status: 200 }))
      }
      return Promise.reject(new TypeError('no network in tests'))
    })
    return asked
  }
  const assistant = () => within(screen.getByRole('dialog', { name: 'DriftLock assistant' }))

  it('is on the start page and asks for a scan before answering, without calling the backend', async () => {
    const asked = stubBackend()
    render(<App />)
    click('Open assistant')
    expect(assistant().getByText('No results yet')).toBeTruthy()
    fireEvent.click(assistant().getByRole('button', { name: 'Explain this scan' }))
    expect(assistant().getByText(/I can only answer questions about DriftLock results, and there are none yet\. Run a scan from the start page, or load the demo run/)).toBeTruthy()
    expect(asked).toEqual([])
  })

  it('answers about the scan on screen: the completed result goes to the backend with the question', async () => {
    const asked = stubBackend()
    render(<App />)
    click('Load demo run')
    expect(await screen.findByRole('heading', { name: 'Command center' })).toBeTruthy()
    click('Open assistant')
    expect(assistant().getByText(`Answering from: Demo data ${savedDemo.scan_id}`)).toBeTruthy()
    fireEvent.click(assistant().getByRole('button', { name: "What's the main problem?" }))
    expect(await assistant().findByText('Answer 1 from the results.')).toBeTruthy()

    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ message: "What's the main problem?", history: [], context: { scan_id: savedDemo.scan_id, scan_source: 'demo', rollout: null, view: 'results' } })
    expect(asked[0]?.context.scan?.scanned_repositories.map((repo) => repo.name)).toEqual(savedDemo.result.scanned_repositories.map((repo) => repo.name))

    // It stays available on the other views of the results, with its conversation.
    openView('Fix plans')
    expect(assistant().getByText('Answer 1 from the results.')).toBeTruthy()
    fireEvent.change(assistant().getByRole('textbox', { name: 'Ask about these results' }), { target: { value: 'Why?' } })
    fireEvent.click(assistant().getByRole('button', { name: 'Send' }))
    expect(await assistant().findByText('Answer 2 from the results.')).toBeTruthy()
    expect(asked[1]?.history).toEqual([{ role: 'user', content: "What's the main problem?" }, { role: 'assistant', content: 'Answer 1 from the results.' }])
  })

  it('is on the rollout planner and sends its analysis once there is one', async () => {
    const asked = stubBackend()
    render(<App />)
    click('Rollout planner')
    expect(await screen.findByRole('heading', { name: 'Which side should be deployed first?' })).toBeTruthy()
    click('Open assistant')
    expect(assistant().getByText('No results yet')).toBeTruthy()

    click('Fill in a public example')
    click('Analyze Rollout')
    expect(await screen.findByRole('region', { name: 'Recommendation' })).toBeTruthy()
    expect(assistant().getByText('Answering from: rollout analysis')).toBeTruthy()
    fireEvent.click(assistant().getByRole('button', { name: 'What should I do next?' }))
    expect(await assistant().findByText('Answer 1 from the results.')).toBeTruthy()
    expect(asked[0]?.context).toMatchObject({ scan: null, scan_id: '', rollout: { recommendation: 'CONSUMER_FIRST' }, view: 'rollout' })
  })
})

describe('your repositories in the app', () => {
  const LISTED = {
    installations: [{ id: 101, account: { login: 'alice', type: 'User', avatar_url: '' }, repository_selection: 'selected', suspended: false, missing_permissions: [], manage_url: 'https://github.com/settings/installations/101', repository_count: 2 }],
    repositories: [
      { id: 1, name: 'ledger', owner: 'alice', full_name: 'alice/ledger', private: true, language: 'Python', default_branch: 'main', updated_at: '2026-10-01T10:00:00Z', html_url: 'https://github.com/alice/ledger', archived: false, installation_id: 101 },
      { id: 2, name: 'site', owner: 'alice', full_name: 'alice/site', private: false, language: 'TypeScript', default_branch: 'main', updated_at: '2026-10-02T10:00:00Z', html_url: 'https://github.com/alice/site', archived: false, installation_id: 101 },
    ],
    complete: true, fetched_at: '2026-10-14T09:00:00Z', install_url: '/api/v1/auth/github/install', cached: false,
  }

  /** A backend with a signed-in user, a GitHub App, two granted repositories, and a scan endpoint that answers at once. */
  function stubSignedIn() {
    const posted: { repository_targets: { type: string; url: string; ref?: string | null }[] }[] = []
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/auth/me')) {
        return Promise.resolve(new Response(JSON.stringify({ configured: true, required: false, user: { login: 'alice', name: 'Alice', avatar_url: '' }, repository_access: { configured: true } }), { status: 200 }))
      }
      if (url.includes('/api/v1/github/repositories')) return Promise.resolve(new Response(JSON.stringify(LISTED), { status: 200 }))
      if (url.endsWith('/api/v1/scans') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return Promise.resolve(new Response(JSON.stringify(savedDemo), { status: 200 }))
      }
      return Promise.reject(new TypeError('no network in tests'))
    })
    return posted
  }

  it('goes from the start page to the picker, into the scan form with a ref, and into a scan', async () => {
    const posted = stubSignedIn()
    render(<App />)
    const card = await screen.findByRole('region', { name: 'Private repositories' })
    expect(within(card).getByText(/Scan your own repositories, private ones included/)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: /Choose from your repositories/ }))
    expect(window.location.pathname).toBe('/repositories')
    expect(await screen.findByRole('list', { name: 'Repositories' })).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alice/ledger' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alice/site' }))
    fireEvent.click(screen.getByRole('button', { name: /Add to scan form/ }))
    expect(window.location.pathname).toBe('/')
    const urls = screen.getAllByRole('textbox').filter((input) => input.id.endsWith('-url')) as HTMLInputElement[]
    expect(urls.map((input) => input.value)).toEqual(['https://github.com/alice/ledger', 'https://github.com/alice/site'])
    // A branch, tag or commit can still be set before scanning.
    const ref = screen.getAllByRole('textbox').find((input) => input.id.endsWith('-ref')) as HTMLInputElement
    fireEvent.change(ref, { target: { value: 'release/2.0' } })
    await act(async () => {
      click(/Analyze repositories/)
    })
    expect(await screen.findByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(posted[0]?.repository_targets).toEqual([
      { type: 'github', url: 'https://github.com/alice/ledger', ref: 'release/2.0' },
      { type: 'github', url: 'https://github.com/alice/site' },
    ])
  })

  it('scans the picked repositories directly from the picker', async () => {
    const posted = stubSignedIn()
    window.history.replaceState(null, '', '/repositories')
    render(<App />)
    expect(await screen.findByRole('list', { name: 'Repositories' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alice/ledger' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select alice/site' }))
    await act(async () => {
      click('Scan 2 repositories')
    })
    expect(await screen.findByRole('heading', { name: 'Command center' })).toBeTruthy()
    expect(posted[0]?.repository_targets.map((target) => target.url)).toEqual(['https://github.com/alice/ledger', 'https://github.com/alice/site'])
  })
})
