import { Download, FileJson, FileText, Link2, Printer, Rows3, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { ScanRecord, ScanResult } from '../../api/scanTypes'
import type { SubmittedRepo } from '../../hooks/useScan'
import { navigate, ROUTE_PATHS } from '../../hooks/useRoute'
import { isDrifted } from '../../lib/classify'
import { buildMarkdown, downloadText, exportFileName, type DataSource } from '../../lib/exportMarkdown'
import { DEFAULT_FILTERS, filterDrifts, sortDrifts, valuesIn, viewStateFromSearch, viewStateToSearch, type DriftFilters, type SortKey } from '../../lib/filterSort'
import { fixesFor, fixPlan, fixPlanText, githubEditUrl, needsReview } from '../../lib/insights'
import { log, setReview, updateStore, useStore, type HistoryEntry } from '../../lib/localStore'
import { computeOverview, repoNamesOf } from '../../lib/overview'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { ConfirmButton, Menu, MenuItem, Switch, useCopy, useToast } from '../common/Controls'
import { PreviewTag, SectionHeading } from '../common/Tags'
import { CommandCenter } from '../console/CommandCenter'
import { CommandPalette, cycleTheme, setSetting, Shell, ShortcutsDialog, Tour, VIEW_META, VIEWS, type PaletteCommand, type View } from '../console/Shell'
import { ActivityView, FixPlans, RepoCompare, ReviewQueue, SettingsView } from '../console/Workflows'
import { DetailPanel } from '../detail/DetailPanel'
import { LimitationsDialog } from '../states/LimitationsDialog'
import { CodeImpact } from './CodeImpact'
import { ContractAnalysis } from './ContractAnalysis'
import { DriftTable } from './DriftTable'
import { Filters } from './Filters'
import { Overview } from './Overview'
import { ReleaseEvidence } from './ReleaseEvidence'
import { Repositories } from './Repositories'

const DependencyGraph = lazy(() => import('./DependencyGraph'))
const PAGE_SIZE = 50
const QUICK = [
  ['drifted', 'Drifted only'],
  ['vulnerable', 'Has vulnerability'],
  ['review', 'Needs review'],
  ['fix', 'Has fix'],
] as const
type Quick = (typeof QUICK)[number][0]

interface ResultsScreenProps {
  record: ScanRecord
  result: ScanResult
  source: DataSource
  /** Why this data is on screen instead of what was asked for (the sample in place of the saved demo run). */
  notice?: string | null
  /** What the user submitted, used for labels and to spot dropped repositories. */
  submitted: SubmittedRepo[]
  /** Current query string: the single source of truth for view, filters and selection. */
  search: string
  onNewScan: () => void
  /** Re-runs the same targets. */
  onScanAgain: () => void
  /** Restores a history entry's repositories in the form. */
  onRunAgain: (entry: HistoryEntry) => void
}

export function ResultsScreen({ record, result, source, notice, submitted, search, onNewScan, onScanAgain, onRunAgain }: ResultsScreenProps) {
  const store = useStore()
  const { settings, reviews } = store
  const toast = useToast()
  const copy = useCopy()
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const [quick, setQuick] = useState<Quick[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [pages, setPages] = useState(1)
  const [compareRepo, setCompareRepo] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'palette' | 'shortcuts' | 'limitations' | 'tour' | null>(settings.tourDone ? null : 'tour')
  const [viewName, setViewName] = useState('')

  const rows = result.drift_matrix
  const params = useMemo(() => new URLSearchParams(search), [search])
  const view: View = VIEWS.find((name) => name === params.get('view')) ?? VIEWS.find((name) => name === settings.defaultView) ?? 'command'
  const { filters, selected } = useMemo(() => viewStateFromSearch(search), [search])
  const overview = useMemo(() => computeOverview(result), [result])
  const repos = useMemo(() => repoNamesOf(result), [result])
  const executive = settings.mode === 'executive'

  const visible = useMemo(() => {
    let list = filterDrifts(rows, filters, repoFilter)
    if (quick.includes('drifted')) list = list.filter((row) => isDrifted(row.drift_disparity))
    if (quick.includes('vulnerable')) list = list.filter((row) => row.vulnerabilities.length > 0)
    if (quick.includes('review')) list = list.filter((row) => needsReview(row, reviews))
    if (quick.includes('fix')) list = list.filter((row) => fixesFor(row).length > 0)
    return list
  }, [rows, filters, repoFilter, quick, reviews])
  const page = visible.slice(0, pages * PAGE_SIZE)

  const repoLabel = useCallback(
    (name: string) => submitted.find((repo) => repo.name.toLowerCase() === name.toLowerCase())?.label ?? name,
    [submitted],
  )

  // Only a scan that was just run offers a pull request: a saved run may be out of date, and the sample's files do not exist.
  const editUrlFor = useCallback(
    (repo: string, sourceFile: string) => (source === 'live' ? githubEditUrl(result, repo, sourceFile) : null),
    [source, result],
  )
  const editUnavailableReason =
    source === 'live' ? 'Only available for GitHub repositories whose branch the scan reported' : `Not available for ${source} data`

  const go = useCallback((next: string) => navigate(`${ROUTE_PATHS.results}${next}`, { replace: true }), [])
  const setView = useCallback(
    (next: View) => {
      const query = new URLSearchParams(search)
      query.set('view', next)
      go(`?${query.toString()}`)
      window.scrollTo?.(0, 0)
    },
    [search, go],
  )
  const setFilters = useCallback((next: DriftFilters) => go(viewStateToSearch({ filters: next, selected }, search)), [go, selected, search])
  const select = useCallback((id: string | null) => go(viewStateToSearch({ filters, selected: id }, search)), [go, filters, search])
  const onSort = useCallback(
    (key: SortKey) => setFilters({ ...filters, sort: key, reversed: filters.sort === key ? !filters.reversed : false }),
    [setFilters, filters],
  )

  const selectedRow = selected ? (rows.find((row) => row.id === selected) ?? null) : null
  const selectedIndex = selectedRow ? visible.findIndex((row) => row.id === selectedRow.id) : -1
  const step = useCallback(
    (offset: number) => {
      const target = visible[selectedIndex + offset]
      if (selectedIndex !== -1 && target) select(target.id)
    },
    [visible, selectedIndex, select],
  )

  useEffect(() => {
    const handleHash = () => {
      if (window.location.hash === '#repositories' && view !== 'repos') {
        setView('repos')
      }
    }
    handleHash()
    window.addEventListener('hashchange', handleHash)
    return () => window.removeEventListener('hashchange', handleHash)
  }, [view, setView])

  const ordered = () => sortDrifts(rows, filters.sort, filters.reversed)
  const exportMarkdown = () => {
    downloadText(buildMarkdown(record, ordered(), source), exportFileName(new Date()), 'text/markdown')
    log('export', 'Markdown report exported')
  }
  const exportJson = (subset?: typeof rows) => {
    const body = subset ? { ...record, result: { ...result, drift_matrix: subset } } : record
    downloadText(JSON.stringify({ data_source: source, ...body }, null, 2), exportFileName(new Date()).replace('.md', '.json'), 'application/json')
    log('export', subset ? `${subset.length} selected packages exported as JSON` : 'JSON report exported')
  }

  const pickedRows = rows.filter((row) => picked.includes(row.id))
  const markReviewed = () => {
    const before = store.reviews
    for (const row of pickedRows) setReview(row.id, { status: 'accepted', until: null })
    toast(`${pickedRows.length} packages marked reviewed`, () => updateStore((current) => ({ ...current, reviews: before })))
    setPicked([])
  }

  const commands = useMemo<PaletteCommand[]>(
    () => [
      ...VIEWS.map((name) => ({ id: `view:${name}`, group: 'View' as const, label: VIEW_META[name].label, run: () => setView(name) })),
      { id: 'a:scan', group: 'Action', label: 'Scan again', run: onScanAgain },
      { id: 'a:new', group: 'Action', label: 'Start a new scan', run: onNewScan },
      { id: 'a:md', group: 'Action', label: 'Export report as Markdown', run: exportMarkdown },
      { id: 'a:json', group: 'Action', label: 'Export report as JSON', run: () => exportJson() },
      { id: 'a:print', group: 'Action', label: 'Print report', run: () => window.print() },
      { id: 'a:theme', group: 'Action', label: 'Switch theme', run: cycleTheme },
      { id: 'a:link', group: 'Action', label: 'Copy link to this view', run: () => void copy(window.location.href, 'Link') },
      { id: 'a:keys', group: 'Action', label: 'Show keyboard shortcuts', run: () => setDialog('shortcuts') },
      ...rows.map((row) => ({ id: `p:${row.id}`, group: 'Package' as const, label: row.dependency_name, run: () => select(row.id) })),
    ],
    // The export helpers close over the same values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, setView, select, onScanAgain, onNewScan, copy, record, source, filters.sort, filters.reversed],
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      const typing = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setDialog('palette')
        return
      }
      if (typing || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === '?') setDialog('shortcuts')
      else if (event.key === 't' && dialog === null && !selected) cycleTheme()
      else if (event.key === 'j' && selected) step(1)
      else if (event.key === 'k' && selected) step(-1)
      else if (dialog === null && !selected) {
        if (event.key === '/') {
          event.preventDefault()
          setView('drifts')
          setTimeout(() => document.querySelector<HTMLInputElement>('input[type="search"]')?.focus(), 50)
        } else if (/^[1-8]$/.test(event.key)) {
          const next = VIEWS[Number(event.key) - 1]
          if (next) setView(next)
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog, selected, step, setView])

  const graph = (tall: boolean) => (
    <Suspense fallback={<div aria-hidden="true" className="h-[420px] animate-pulse rounded-lg bg-muted" />}>
      <DependencyGraph rows={rows} repos={repos} repoLabel={repoLabel} selectedId={selected} repo={repoFilter} tall={tall} onSelectPackage={select} onToggleRepo={(name) => setRepoFilter((current) => (current === name ? null : name))} />
    </Suspense>
  )

  const exportMenu = (
    <Menu label="Export report" trigger={<><Download aria-hidden="true" />Export report</>}>
      {(close) => (
        <>
          <MenuItem onClick={() => { close(); exportMarkdown() }}><FileText aria-hidden="true" />Markdown</MenuItem>
          <MenuItem onClick={() => { close(); exportJson() }}><FileJson aria-hidden="true" />JSON</MenuItem>
          <MenuItem onClick={() => { close(); window.print() }}><Printer aria-hidden="true" />Print</MenuItem>
          <MenuItem onClick={() => { close(); void copy(window.location.href, 'Link') }}><Link2 aria-hidden="true" />Copy link</MenuItem>
        </>
      )}
    </Menu>
  )

  const noDrift = rows.length > 0 && !rows.some((row) => isDrifted(row.drift_disparity))
  // The sample's contract and code-impact sections are hand-written in a provisional shape; a saved run is real backend output.
  const preview = source === 'sample' ? <PreviewTag /> : undefined
  const pasted = submitted.filter((target) => target.kind === 'pasted')

  return (
    <Shell
      view={view}
      onView={setView}
      source={source}
      result={result}
      scanning={false}
      onScanAgain={onScanAgain}
      onNewScan={onNewScan}
      onOpenPalette={() => setDialog('palette')}
      onOpenShortcuts={() => setDialog('shortcuts')}
      badges={{
        drifts: rows.filter((row) => isDrifted(row.drift_disparity)).length,
        review: rows.filter((row) => needsReview(row, reviews)).length,
        fixes: fixPlan(rows, repos).reduce((sum, group) => sum + group.items.filter(({ row, fix }) => !store.fixesDone.includes(`${row.id}@${fix.repo}`)).length, 0),
      }}
    >
      {notice && (
        <Banner tone="warning" role="status" title="Showing sample data" className="mb-4">
          {notice}
        </Banner>
      )}
      {pasted.length > 0 && (
        <p className="mb-4 rounded-md border border-border bg-info-tint px-4 py-2 text-sm">
          Pasted input ({pasted.map((target) => target.label).join(', ')}): no code scan, and resolved versions only where a lockfile was pasted.
        </p>
      )}

      {view === 'command' && (
        <>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="font-display text-3xl tracking-tight lg:text-4xl">Command center</h1>
              <p className="mt-1 text-sm text-muted-foreground">Scan {record.scan_id}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 print:hidden">
              <Button size="sm" variant="ghost" onClick={() => setDialog('limitations')}>
                Limitations
              </Button>
              {exportMenu}
            </div>
          </div>
          <div className="mb-6">
            <Overview
              overview={overview}
              warningCount={result.warnings.length + result.skipped_items.length}
              onOpenRepositories={() => setView('repos')}
            />
          </div>
          <CommandCenter
            result={result}
            repos={repos}
            repoLabel={repoLabel}
            renderGraph={graph}
            onOpen={select}
            onGo={(next, preset) => {
              if (preset) setQuick([preset])
              setView(next)
            }}
            onCompare={(repo) => {
              setCompareRepo(repo)
              setView('repos')
            }}
          />
        </>
      )}

      {view === 'drifts' && (
        <section aria-labelledby="drifts-title">
          <SectionHeading id="drifts-title" eyebrow="Dependency drift" title="Active drifts" aside={<span className="print:hidden">{exportMenu}</span>}>
            Declared range is what each manifest allows. Resolved version is what its lockfile pins. A major gap is a
            version difference, not a confirmed break.
          </SectionHeading>
          {rows.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-6 py-12 text-center text-muted-foreground">The backend returned no dependencies for this scan. Check Repositories for what was analyzed.</p>
          ) : (
            <div className="space-y-5">
              {noDrift && (
                <p className="flex items-start gap-3 rounded-md border border-success/30 bg-success-tint px-4 py-3 text-sm">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>
                    <span className="font-medium">No drift found.</span> Every shared package uses matching versions. Only direct dependencies were compared.
                  </span>
                </p>
              )}
              <Filters
                filters={filters}
                onChange={setFilters}
                ecosystems={valuesIn(rows, 'ecosystem')}
                drifts={valuesIn(rows, 'drift_disparity')}
                risks={valuesIn(rows, 'compatibility_risk')}
                repo={repoFilter}
                repoLabel={repoLabel}
                onClearRepo={() => setRepoFilter(null)}
                onClearAll={() => {
                  setRepoFilter(null)
                  setQuick([])
                  setFilters({ ...DEFAULT_FILTERS, sort: filters.sort, reversed: filters.reversed })
                }}
                shown={visible.length}
                total={rows.length}
              />
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                <div role="group" aria-label="Quick filters" className="flex flex-wrap gap-2">
                  {QUICK.map(([key, label]) => {
                    const on = quick.includes(key)
                    return (
                      <button key={key} type="button" aria-pressed={on} onClick={() => { setQuick(on ? quick.filter((item) => item !== key) : [...quick, key]); setPages(1) }} className={`h-8 rounded-full border px-3 text-xs transition-colors ${on ? 'border-foreground bg-foreground text-background' : 'border-border bg-card hover:border-foreground/40'}`}>
                        {label}
                      </button>
                    )
                  })}
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Switch checked={settings.density === 'compact'} onChange={(compact) => setSetting('density', compact ? 'compact' : 'comfortable')} label="Compact rows" />
                  <Menu label="Saved views" trigger={<><Rows3 aria-hidden="true" />Saved views ({store.views.length})</>} wide>
                    {(close) => (
                      <>
                        <p className="text-xs text-muted-foreground">Filter sets, saved in this browser.</p>
                        <div className="mt-2 flex gap-2">
                          <input aria-label="Name for this view" value={viewName} onChange={(event) => setViewName(event.target.value)} placeholder="Name this view" className="h-8 min-w-0 flex-1 rounded-full border border-input bg-card px-3 text-xs" />
                          <Button size="sm" disabled={viewName.trim() === ''} onClick={() => { updateStore((current) => ({ ...current, views: [...current.views.filter((item) => item.name !== viewName.trim()), { name: viewName.trim(), search: viewStateToSearch({ filters, selected: null }, '') }] })); toast(`View "${viewName.trim()}" saved`); setViewName('') }}>
                            <Save aria-hidden="true" />
                            Save this view
                          </Button>
                        </div>
                        <ul className="mt-2 space-y-1">
                          {store.views.length === 0 && <li className="text-xs text-muted-foreground">No saved views yet.</li>}
                          {store.views.map((item) => (
                            <li key={item.name} className="flex items-center gap-1">
                              <MenuItem onClick={() => { close(); setFilters(viewStateFromSearch(item.search).filters) }}>{item.name}</MenuItem>
                              <ConfirmButton size="sm" variant="ghost" aria-label={`Delete view ${item.name}`} confirmLabel={`Delete "${item.name}"`} onConfirm={() => updateStore((current) => ({ ...current, views: current.views.filter((other) => other.name !== item.name) }))}>
                                <Trash2 aria-hidden="true" />
                              </ConfirmButton>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </Menu>
                </div>
              </div>
              {picked.length > 0 && (
                <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary px-4 py-2 text-sm print:hidden">
                  <span>{picked.length} selected</span>
                  <Button size="sm" onClick={markReviewed}>
                    Mark reviewed
                  </Button>
                  <Button size="sm" onClick={() => void copy(fixPlanText(fixPlan(pickedRows, repos), repoLabel) || 'No fix lines are available for the selected packages.', 'Fixes')}>
                    Copy fixes
                  </Button>
                  <Button size="sm" onClick={() => exportJson(pickedRows)}>
                    Export selected
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPicked([])}>
                    Clear selection
                  </Button>
                </div>
              )}
              <DriftTable
                rows={page}
                repos={repos}
                repoLabel={repoLabel}
                selectedId={selected}
                onSelect={select}
                sort={filters.sort}
                reversed={filters.reversed}
                onSort={onSort}
                compact={settings.density === 'compact'}
                picked={picked}
                onPick={setPicked}
              />
              {visible.length > page.length && (
                <Button onClick={() => setPages(pages + 1)}>
                  Load {Math.min(PAGE_SIZE, visible.length - page.length)} more of {visible.length}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {view === 'risk' && (
        <div className="space-y-16">
          <section aria-labelledby="evidence-title">
            <SectionHeading id="evidence-title" eyebrow="Risk intelligence" title="What to do about each drifted package">
              One next action and one reason per package. Missing evidence is stated and is never read as proof of safety.
            </SectionHeading>
            <ReleaseEvidence rows={rows} warnings={result.warnings} repoLabel={repoLabel} onOpen={select} />
          </section>
          <section aria-labelledby="contracts-title">
            <SectionHeading id="contracts-title" eyebrow="API contract analysis" title="Changes between OpenAPI specifications" aside={result.contract_analysis ? preview : undefined} />
            <ContractAnalysis entries={result.contract_analysis} repoLabel={repoLabel} />
          </section>
          <section aria-labelledby="code-impact-title">
            <SectionHeading id="code-impact-title" eyebrow="Code impact" title="Where your code is affected" aside={result.code_impact ? preview : undefined} />
            {executive ? (
              <p className="rounded-lg border border-dashed border-border px-6 py-8 text-muted-foreground">
                Source-code evidence is hidden in Executive view. {result.code_impact ? `${result.code_impact.length} locations were found.` : 'No code scan ran.'} Switch to Technical to see them.
              </p>
            ) : (
              <CodeImpact items={result.code_impact} repoLabel={repoLabel} onOpenDependency={(name) => { const match = rows.find((row) => row.dependency_name === name); if (match) select(match.id) }} />
            )}
          </section>
        </div>
      )}

      {view === 'review' && <ReviewQueue rows={rows} repoLabel={repoLabel} onOpen={select} />}
      {view === 'fixes' && (
        <FixPlans rows={rows} repos={repos} repoLabel={repoLabel} onOpen={select} editUrlFor={editUrlFor} editUnavailableReason={editUnavailableReason} />
      )}
      {view === 'activity' && <ActivityView onRunAgain={onRunAgain} />}
      {view === 'repos' && (
        <section id="repositories" aria-labelledby="repositories-title">
          <SectionHeading id="repositories-title" eyebrow="Coverage" title="Repositories" aside={<Button size="sm" onClick={onScanAgain}>Retry scan</Button>}>
            What was and was not analyzed. Retry re-runs every repository, because the backend scans them together.
          </SectionHeading>
          <Repositories result={result} submitted={submitted} />
          <RepoCompare key={compareRepo ?? 'none'} result={result} repos={repos} repoLabel={repoLabel} initial={compareRepo} onOpen={select} />
        </section>
      )}
      {view === 'settings' && <SettingsView onRestartTour={() => setDialog('tour')} />}

      {selectedRow && (
        <DetailPanel
          key={selectedRow.id}
          row={selectedRow}
          repos={repos}
          repoLabel={repoLabel}
          codeImpact={result.code_impact}
          executive={executive}
          editUrlFor={editUrlFor}
          editUnavailableReason={editUnavailableReason}
          position={selectedIndex === -1 ? null : { index: selectedIndex, total: visible.length }}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => select(null)}
        />
      )}
      {dialog === 'limitations' && <LimitationsDialog onClose={() => setDialog(null)} />}
      {dialog === 'shortcuts' && <ShortcutsDialog onClose={() => setDialog(null)} />}
      {dialog === 'palette' && <CommandPalette commands={commands} onClose={() => setDialog(null)} />}
      {dialog === 'tour' && !selectedRow && (
        <Tour
          onClose={(dontShowAgain) => {
            if (dontShowAgain) setSetting('tourDone', true)
            setDialog(null)
          }}
        />
      )}
    </Shell>
  )
}
