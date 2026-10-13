// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { createDemoClient, demoRecord, type DemoVariant } from '../api/demoScan'
import { ApiFailure, toUiError } from '../api/errors'
import type { ScanRecord } from '../api/scanTypes'
import { AnnouncerProvider } from '../hooks/useAnnouncer'
import { useRoute } from '../hooks/useRoute'
import type { SubmittedRepo } from '../hooks/useScan'
import type { RepoInput } from '../lib/validateRepoUrl'
import { AnalyzingState } from './analyzing/AnalyzingState'
import { RepoForm } from './input/RepoForm'
import { ResultsScreen } from './results/ResultsScreen'
import { ErrorState } from './states/ErrorState'

// The graph and chart libraries need real layout, which jsdom does not have.
vi.mock('./results/DependencyGraph', () => ({ default: () => <div data-testid="graph" /> }))
vi.mock('./results/DriftChart', () => ({ default: () => null }))

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
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.history.replaceState(null, '', '/')
})

const SUBMITTED: SubmittedRepo[] = ['payment-service', 'core-service', 'customer-service'].map((name, index) => ({
  label: ['Payments', 'Core', 'Customers'][index] ?? name,
  url: `https://github.com/example-org/${name}`,
  name,
  ref: null,
}))

async function recordFor(variant: DemoVariant | null): Promise<ScanRecord> {
  const client = createDemoClient(variant)
  for (let poll = 0; poll < 10; poll += 1) {
    const record = await client.getScan({ scan_id: 'x', status: 'QUEUED', poll_url: null })
    if (record.result) return record
  }
  throw new Error('variant never completed')
}

function Results({ record, submitted = SUBMITTED }: { record: ScanRecord; submitted?: SubmittedRepo[] }) {
  const route = useRoute()
  if (!record.result) throw new Error('record has no result')
  return (
    <AnnouncerProvider>
      <ResultsScreen
        record={record}
        result={record.result}
        source="demo"
        submitted={submitted}
        search={route.search}
        onNewScan={() => undefined}
      />
    </AnnouncerProvider>
  )
}

function Form({ onSubmit }: { onSubmit: (repos: SubmittedRepo[]) => void }) {
  const [inputs, setInputs] = useState<RepoInput[]>([
    { label: 'Payment Service', url: '' },
    { label: '', url: '' },
    { label: 'Customer Service', url: '' },
  ])
  return (
    <AnnouncerProvider>
      <RepoForm
        inputs={inputs}
        onChange={setInputs}
        onSubmit={onSubmit}
        onLoadDemo={() => undefined}
        busy={false}
        error={null}
        onDismissError={() => undefined}
      />
    </AnnouncerProvider>
  )
}

const urlField = (index: number) => screen.getByLabelText(`GitHub repository URL ${index}`)
const type = (index: number, value: string) => fireEvent.change(urlField(index), { target: { value } })

describe('repository form', () => {
  it('has three repository fields and blocks an empty submission', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    expect(screen.getAllByLabelText(/GitHub repository URL/)).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: /Analyze repositories/ }))
    expect(screen.getAllByText('Enter a GitHub repository URL')).toHaveLength(3)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(urlField(1))
  })

  it('reports malformed and duplicate URLs', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    type(1, 'https://github.com/example-org/core-service')
    type(2, 'https://github.com/Example-Org/Core-Service/tree/dev')
    type(3, 'gitlab.com/x/y')
    fireEvent.click(screen.getByRole('button', { name: /Analyze repositories/ }))

    expect(screen.getByText('This repository is already listed above')).toBeTruthy()
    expect(screen.getByText(/Use a public repository URL/)).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits three valid repositories with labels and branch', () => {
    const onSubmit = vi.fn()
    render(<Form onSubmit={onSubmit} />)
    type(1, 'https://github.com/example-org/payment-service')
    type(2, 'https://github.com/example-org/core-service.git')
    type(3, 'https://github.com/example-org/customer-service/tree/release/2.x')
    fireEvent.click(screen.getByRole('button', { name: /Analyze repositories/ }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0]?.[0]).toEqual([
      { label: 'Payment Service', url: 'https://github.com/example-org/payment-service', name: 'payment-service', ref: null },
      { label: 'Core Service', url: 'https://github.com/example-org/core-service', name: 'core-service', ref: null },
      { label: 'Customer Service', url: 'https://github.com/example-org/customer-service', name: 'customer-service', ref: 'release/2.x' },
    ])
  })
})

describe('scan progress', () => {
  it('shows the current stage, the backend action and the percentage', () => {
    render(
      <AnalyzingState
        source="live"
        startedAt={Date.now()}
        scanId="scn_a1"
        status="PARSING"
        progress={{ stage: 'PARSING', percentage: 50, current_action: 'Parsing 4 manifests' }}
        repos={SUBMITTED}
        onCancel={() => undefined}
      />,
    )
    expect(screen.getByText('Parsing 4 manifests')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')
    const stages = within(screen.getByRole('list', { name: 'Scan stages' })).getAllByRole('listitem')
    expect(stages.map((stage) => stage.getAttribute('aria-current'))).toEqual([null, null, 'step', null])
    expect(stages[0]?.textContent).toContain('done')
  })

  it('does not invent a percentage or a stage for an unknown status', () => {
    render(
      <AnalyzingState source="live" startedAt={Date.now()} scanId={null} status="RESOLVING" progress={null} repos={[]} onCancel={() => undefined} />,
    )
    expect(screen.getByText('Status: RESOLVING')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  })
})

describe('results dashboard', () => {
  it('renders a full scan with warnings, the comparison table and optional sections', () => {
    render(<Results record={demoRecord()} />)

    expect(screen.getByText('Scan completed with warnings.')).toBeTruthy()
    expect(screen.getAllByText('Demo data').length).toBeGreaterThan(0)

    const table = screen.getByRole('grid', { name: /Dependency comparison/ })
    const reactRow = within(table).getByRole('rowheader', { name: /react/ }).closest('tr') as HTMLElement
    expect(within(reactRow).getByText('^18.2.0')).toBeTruthy()
    expect(within(reactRow).getByText('18.2.0')).toBeTruthy()
    expect(within(reactRow).getByText('Not resolved')).toBeTruthy()
    expect(within(reactRow).getByText('Not declared')).toBeTruthy()
    expect(within(reactRow).getByText('Major drift')).toBeTruthy()
    expect(within(reactRow).getByText('Confirmed breaking')).toBeTruthy()
    // Column headers carry the user's labels.
    expect(within(table).getByText('Payments')).toBeTruthy()

    expect(screen.getByText('No specification found')).toBeTruthy()
    expect(screen.getByText('Specification unreadable')).toBeTruthy()
    expect(screen.getByText(/Matched on the literal URL string/)).toBeTruthy()
    expect(screen.getAllByText('AI interpretation').length).toBeGreaterThan(0)
  })

  it('opens the detail panel for a package and closes it with Escape', () => {
    render(<Results record={demoRecord()} />)
    const table = screen.getByRole('grid', { name: /Dependency comparison/ })
    fireEvent.click(within(table).getByRole('rowheader', { name: /axios/ }))

    const dialog = screen.getByRole('dialog')
    expect(window.location.search).toContain('selected=npm%3Aaxios')
    expect(within(dialog).getByRole('heading', { name: 'axios' })).toBeTruthy()
    expect(within(dialog).getByText('Not resolved, no lockfile entry')).toBeTruthy()
    expect(within(dialog).getByText(/not assessed, not that it is safe/)).toBeTruthy()
    expect(within(dialog).getByText(/Error handling may behave differently/)).toBeTruthy()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('filters from the URL and reverses the sort from a column header', () => {
    window.history.replaceState(null, '', '/results?drift=MAJOR_DRIFT')
    render(<Results record={demoRecord()} />)
    const table = screen.getByRole('grid', { name: /Dependency comparison/ })
    const packages = () => within(table).getAllByRole('rowheader').map((cell) => cell.textContent?.replace(/npm|Python/, ''))

    expect(packages()).toEqual(['react', 'pydantic', 'axios'])
    fireEvent.click(within(table).getByRole('button', { name: 'Package' }))
    expect(packages()).toEqual(['axios', 'pydantic', 'react'])
    fireEvent.click(within(table).getByRole('button', { name: 'Package' }))
    expect(packages()).toEqual(['react', 'pydantic', 'axios'])
  })

  it('renders when every optional field is absent, without showing zeroes', async () => {
    render(<Results record={await recordFor('minimal')} />)

    expect(screen.getByText('Scan completed.')).toBeTruthy()
    expect(screen.getAllByText('Not available').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText(/did not return API contract analysis/)).toBeTruthy()
    expect(screen.getByText(/did not return call-site analysis/)).toBeTruthy()
    expect(screen.getByText(/tallied from the rows/)).toBeTruthy()
    expect(screen.getAllByText(/No release evidence was returned/).length).toBe(3)
    // Submitted repositories the backend said nothing about are still listed.
    expect(screen.getAllByText(/Not in the results/)).toHaveLength(3)
  })

  it('keeps a partial result usable and says what was not analyzed', async () => {
    render(<Results record={await recordFor('partial')} />)
    expect(screen.getByText('Scan completed with warnings.')).toBeTruthy()
    expect(screen.getByText(/1 repository not fully analyzed/)).toBeTruthy()
    expect(screen.getByText(/No supported manifests were found/)).toBeTruthy()
    expect(screen.getByText(/could not be fetched \(404\)/)).toBeTruthy()
    expect(within(screen.getByRole('grid', { name: /Dependency comparison/ })).getByRole('rowheader', { name: /pydantic/ })).toBeTruthy()
  })

  it('says so when nothing has drifted', async () => {
    render(<Results record={await recordFor('empty')} />)
    expect(screen.getByText('No drift found.')).toBeTruthy()
    expect(screen.getByText(/no release notes to compare/)).toBeTruthy()
  })
})

describe('error state', () => {
  it('shows the backend message and code, and offers a retry', () => {
    const onAction = vi.fn()
    const error = toUiError(
      new ApiFailure('scan-failed', { errorCode: 'SCAN_FAILED', serverMessage: 'Unexpected failure during dependency graph generation.' }),
    )
    render(<ErrorState error={error} demo={false} onAction={onAction} />)
    expect(screen.getByText('Scan failed')).toBeTruthy()
    expect(screen.getByText(/dependency graph generation/)).toBeTruthy()
    expect(screen.getByText('Error code: SCAN_FAILED')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry scan' }))
    expect(onAction).toHaveBeenCalledWith('retry')
  })
})

describe('app', () => {
  it('plays the demo scan from the input screen through polling to the dashboard', async () => {
    vi.useFakeTimers()
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Load demo run' }))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(800)
    })
    expect(screen.getByRole('heading', { name: 'Playing the demo scan' })).toBeTruthy()
    // A second submission while a scan is running is not possible: the form is gone.
    expect(screen.queryByRole('button', { name: /Analyze repositories/ })).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(screen.getByRole('heading', { name: 'What the scan found' })).toBeTruthy()
    expect(window.location.pathname).toBe('/results')
  })
})
