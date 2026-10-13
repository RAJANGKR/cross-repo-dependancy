import { useCallback, useEffect, useMemo, useState } from 'react'
import { InputScreen } from './components/input/InputScreen'
import { AnalyzingState } from './components/analyzing/AnalyzingState'
import { ErrorState, NoResults } from './components/states/ErrorState'
import { TopBar } from './components/results/TopBar'
import { SummaryCards } from './components/results/SummaryCards'
import { Filters } from './components/results/Filters'
import DependencyGraph from './components/results/DependencyGraph'
import { DriftTable } from './components/results/DriftTable'
import { ProjectStatusStrip, SkippedList, WarningsBanner } from './components/results/ProjectStatusStrip'
import { LimitationsDialog } from './components/states/LimitationsDialog'
import { EmptyNoDrift } from './components/states/EmptyNoDrift'
import { useProjectInput, ProjectInputProvider } from './hooks/useProjectInput'
import { AnalysisProvider, useAnalysis } from './hooks/useAnalysis'
import { ROUTE_PATHS, carrySearch, navigate, useRoute } from './hooks/useRoute'
import { buildAnalyzeRequest } from './lib/projectInput'
import { DEFAULT_FILTERS, ecosystemsIn, filterDrifts, viewStateFromSearch, viewStateToSearch } from './lib/filterSort'
import { buildMarkdown, downloadMarkdown, exportFileName } from './lib/exportMarkdown'

function AppShell() {
  const route = useRoute()
  const { state: analysisState, loadDemo, runAnalysis, cancel, reset } = useAnalysis()
  const { state: inputState } = useProjectInput()
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const [limitationsOpen, setLimitationsOpen] = useState(false)

  const lastReport = analysisState.status === 'success' ? analysisState.report : null

  const onNavigateResults = useCallback(() => {
    navigate(ROUTE_PATHS.results + carrySearch(route.search), { replace: true })
  }, [route.search])

  const onNavigateInput = useCallback(() => {
    setProjectFilter(null)
    navigate(ROUTE_PATHS.input + carrySearch(route.search), { replace: true })
  }, [route.search])

  const analyze = useCallback(async () => {
    const payload = buildAnalyzeRequest(inputState)
    const submitted = [
      ...inputState.chips
        .filter((chip) => chip.parsed !== null)
        .map((chip) => ({ name: chip.parsed!.repo, origin: 'github' as const })),
      ...inputState.projects.map((project) => ({
        name: project.name.trim() || `Pasted project ${project.id}`,
        origin: 'pasted' as const,
      })),
    ]
    const didLoad = await runAnalysis(payload, submitted)
    if (didLoad) onNavigateResults()
  }, [inputState, onNavigateResults, runAnalysis])

  const demo = useCallback(async () => {
    const didLoad = await loadDemo()
    if (didLoad) onNavigateResults()
  }, [loadDemo, onNavigateResults])

  const report = analysisState.status === 'success' ? analysisState.report : null
  const availableDrifts = report?.drifts ?? []
  const visibleDrifts = useMemo(
    () => filterDrifts(availableDrifts, filters, projectFilter),
    [availableDrifts, filters, projectFilter],
  )
  const ecosystems = useMemo(() => ecosystemsIn(availableDrifts), [availableDrifts])

  const onFiltersChange = useCallback(
    (next: typeof filters) => {
      setFilters(next)
      const search = viewStateToSearch({ filters: next, selected: selectedId }, route.search)
      if (route.name === 'results') {
        navigate(ROUTE_PATHS.results + search, { replace: true })
      }
    },
    [route.name, route.search, selectedId],
  )

  const onSelectLibrary = useCallback(
    (libraryId: string) => {
      const next = selectedId === libraryId ? null : libraryId
      setSelectedId(next)
      if (route.name === 'results') {
        const search = viewStateToSearch({ filters, selected: next }, route.search)
        navigate(ROUTE_PATHS.results + search, { replace: true })
      }
    },
    [filters, route.name, route.search, selectedId],
  )

  const onToggleProject = useCallback(
    (name: string) => {
      const nextProject = projectFilter === name ? null : name
      setProjectFilter(nextProject)
      if (route.name === 'results') {
        const search = viewStateToSearch({ filters, selected: selectedId }, route.search)
        navigate(ROUTE_PATHS.results + search, { replace: true })
      }
    },
    [filters, projectFilter, route.name, route.search, selectedId],
  )

  const onExport = useCallback(() => {
    if (!report) return
    const markdown = buildMarkdown(report, visibleDrifts)
    downloadMarkdown(markdown, exportFileName(new Date()))
  }, [report, visibleDrifts])

  const onAnalyzeAgain = useCallback(() => {
    onNavigateInput()
  }, [onNavigateInput])

  const currentFromUrl = useMemo(() => viewStateFromSearch(route.search), [route.search])

  useEffect(() => {
    setFilters(currentFromUrl.filters)
    setSelectedId(currentFromUrl.selected)
  }, [currentFromUrl])

  const currentError =
    analysisState.status === 'error' && analysisState.mode === 'analyze' && route.name === 'input'
      ? analysisState.error
      : null

  if (analysisState.status === 'loading') {
    return (
      <AnalyzingState
        mode={analysisState.mode}
        startedAt={analysisState.startedAt}
        projects={analysisState.projects}
        onCancel={() => {
          cancel()
          onNavigateInput()
        }}
      />
    )
  }

  if (route.name === 'results') {
    if (analysisState.status === 'idle') {
      return <NoResults onStart={onNavigateInput} onLoadDemo={demo} />
    }

    if (analysisState.status === 'error') {
      return (
        <ErrorState
          error={analysisState.error}
          onAction={(action) => {
            if (action === 'retry') {
              void analyze()
              return
            }
            if (action === 'load-demo') {
              void demo()
              return
            }
            onNavigateInput()
          }}
        />
      )
    }

    if (analysisState.status === 'success') {
      const selectedDrift = visibleDrifts.find((drift) => drift.id === selectedId) ?? null
      const clearAll = () => {
        setFilters(DEFAULT_FILTERS)
        setSelectedId(null)
        setProjectFilter(null)
        navigate(ROUTE_PATHS.results, { replace: true })
      }

      return (
        <div className="min-h-screen bg-background">
          <TopBar
            meta={analysisState.report.meta}
            projectCount={analysisState.report.repos.length}
            onAnalyzeAgain={onAnalyzeAgain}
            onExport={onExport}
            onOpenLimitations={() => setLimitationsOpen(true)}
          />

          <main className="mx-auto max-w-[1400px] px-4 pb-24 pt-8 sm:px-6 lg:px-8">
            <div className="space-y-8">
              <SummaryCards summary={analysisState.report.summary} />
              <Filters
                filters={filters}
                onChange={onFiltersChange}
                ecosystems={ecosystems}
                project={projectFilter}
                onClearProject={() => setProjectFilter(null)}
                onClearAll={clearAll}
                shown={visibleDrifts.length}
                total={analysisState.report.drifts.length}
              />
              {analysisState.report.drifts.length === 0 ? (
                <EmptyNoDrift summary={analysisState.report.summary} />
              ) : visibleDrifts.length === 0 ? (
                <section className="rounded-lg border border-border bg-card p-6">
                  <p className="font-display text-3xl tracking-tight">No drifts match these filters</p>
                  <p className="mt-2 text-muted-foreground">Try clearing one or more filters to see the full report.</p>
                </section>
              ) : (
                <>
                  <DependencyGraph
                    graph={analysisState.report.graph}
                    drifts={analysisState.report.drifts}
                    selectedId={selectedId}
                    project={projectFilter}
                    onSelectLibrary={onSelectLibrary}
                    onToggleProject={onToggleProject}
                  />

                  <div className="space-y-6">
                    <DriftTable
                      drifts={visibleDrifts}
                      selectedId={selectedId}
                      onSelect={onSelectLibrary}
                      sort={filters.sort}
                      reversed={filters.reversed}
                      onSort={(sort) => {
                        const next = { ...filters, sort, reversed: false }
                        onFiltersChange(next)
                      }}
                    />

                    {selectedDrift && (
                      <section aria-live="polite" className="rounded-lg border border-border bg-card p-6">
                        <p className="font-mono text-xs uppercase text-muted-foreground">Selected drift</p>
                        <h2 className="mt-3 font-display text-3xl tracking-tight">{selectedDrift.library}</h2>
                        <p className="mt-2 text-muted-foreground">{selectedDrift.explanation?.text ?? 'No explanation provided.'}</p>
                      </section>
                    )}

                    <WarningsBanner warnings={analysisState.report.warnings} />
                    <ProjectStatusStrip repos={analysisState.report.repos} onRetry={() => void analyze()} />
                    <SkippedList skipped={analysisState.report.skipped} />
                  </div>
                </>
              )}
            </div>
          </main>

          {limitationsOpen && <LimitationsDialog onClose={() => setLimitationsOpen(false)} />}
        </div>
      )
    }
  }

  return (
    <InputScreen
      busy={false}
      inlineError={currentError}
      onDismissError={() => {
        reset()
        onNavigateInput()
      }}
      onAnalyze={() => void analyze()}
      onLoadDemo={() => void demo()}
      lastReport={lastReport}
    />
  )
}

export default function App() {
  return (
    <AnalysisProvider>
      <ProjectInputProvider>
        <AppShell />
      </ProjectInputProvider>
    </AnalysisProvider>
  )
}
