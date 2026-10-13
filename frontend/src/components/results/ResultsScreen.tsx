import { ShieldCheck } from 'lucide-react'
import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import type { ScanRecord, ScanResult } from '../../api/scanTypes'
import type { SubmittedRepo } from '../../hooks/useScan'
import { navigate, ROUTE_PATHS } from '../../hooks/useRoute'
import { isDrifted } from '../../lib/classify'
import { buildMarkdown, downloadMarkdown, exportFileName, type DataSource } from '../../lib/exportMarkdown'
import {
  DEFAULT_FILTERS,
  filterDrifts,
  sortDrifts,
  valuesIn,
  viewStateFromSearch,
  viewStateToSearch,
  type DriftFilters,
  type SortKey,
} from '../../lib/filterSort'
import { computeOverview, repoNamesOf } from '../../lib/overview'
import { PreviewTag, SectionHeading } from '../common/Tags'
import { DetailPanel } from '../detail/DetailPanel'
import { LimitationsDialog } from '../states/LimitationsDialog'
import { CodeImpact } from './CodeImpact'
import { ContractAnalysis } from './ContractAnalysis'
import { DriftTable } from './DriftTable'
import { Filters } from './Filters'
import { Overview } from './Overview'
import { ReleaseEvidence } from './ReleaseEvidence'
import { Repositories } from './Repositories'
import { TopBar } from './TopBar'

const DependencyGraph = lazy(() => import('./DependencyGraph'))

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'graph', label: 'Graph' },
  { id: 'evidence', label: 'Release evidence' },
  { id: 'contracts', label: 'API contracts' },
  { id: 'code-impact', label: 'Code impact' },
  { id: 'repositories', label: 'Repositories and warnings' },
]

interface ResultsScreenProps {
  record: ScanRecord
  result: ScanResult
  source: DataSource
  /** What the user submitted, used for labels and to spot dropped repositories. */
  submitted: SubmittedRepo[]
  /** Current query string, the single source of truth for filters and selection. */
  search: string
  onNewScan: () => void
}

export function ResultsScreen({ record, result, source, submitted, search, onNewScan }: ResultsScreenProps) {
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const [limitationsOpen, setLimitationsOpen] = useState(false)

  const rows = result.drift_matrix
  const { filters, selected } = useMemo(() => viewStateFromSearch(search), [search])
  const overview = useMemo(() => computeOverview(result), [result])
  const repos = useMemo(() => repoNamesOf(result), [result])
  const visible = useMemo(() => filterDrifts(rows, filters, repoFilter), [rows, filters, repoFilter])

  const repoLabel = useCallback(
    (name: string) => submitted.find((repo) => repo.name.toLowerCase() === name.toLowerCase())?.label ?? name,
    [submitted],
  )

  const setView = useCallback(
    (nextFilters: DriftFilters, nextSelected: string | null) =>
      navigate(`${ROUTE_PATHS.results}${viewStateToSearch({ filters: nextFilters, selected: nextSelected }, search)}`, {
        replace: true,
      }),
    [search],
  )
  const setFilters = useCallback((next: DriftFilters) => setView(next, selected), [setView, selected])
  const select = useCallback((id: string | null) => setView(filters, id), [setView, filters])

  const onSort = useCallback(
    (key: SortKey) => setFilters({ ...filters, sort: key, reversed: filters.sort === key ? !filters.reversed : false }),
    [setFilters, filters],
  )

  const selectedRow = selected ? (rows.find((row) => row.id === selected) ?? null) : null
  const selectedIndex = selectedRow ? visible.findIndex((row) => row.id === selectedRow.id) : -1
  const step = (offset: number) => {
    const target = visible[selectedIndex + offset]
    if (selectedIndex !== -1 && target) select(target.id)
  }

  const openByName = useCallback(
    (name: string) => {
      const match = rows.find((row) => row.dependency_name === name)
      if (match) select(match.id)
    },
    [rows, select],
  )

  const exportReport = () =>
    downloadMarkdown(
      buildMarkdown(record, sortDrifts(rows, filters.sort, filters.reversed), source),
      exportFileName(new Date()),
    )

  const noDrift = rows.length > 0 && !rows.some((row) => isDrifted(row.drift_disparity))
  const preview = source === 'demo' ? <PreviewTag /> : undefined

  return (
    <div className="min-h-screen">
      <TopBar
        record={record}
        source={source}
        onNewScan={onNewScan}
        onExport={exportReport}
        onOpenLimitations={() => setLimitationsOpen(true)}
      />

      <main className="mx-auto max-w-[1400px] space-y-20 px-4 pb-24 pt-10 sm:px-6 lg:px-8">
        <nav aria-label="Sections" className="-mb-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="text-foreground/70 underline decoration-transparent underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <section id="overview" aria-labelledby="overview-title" className="scroll-mt-28">
          <SectionHeading id="overview-title" eyebrow="Scan overview" title="What the scan found" />
          <Overview overview={overview} warningCount={result.warnings.length + result.skipped_items.length} />
        </section>

        <section id="dependencies" aria-labelledby="dependencies-title" className="scroll-mt-28">
          <SectionHeading id="dependencies-title" eyebrow="Dependency drift" title="Package by package">
            Declared range is what each manifest allows. Resolved version is what its lockfile pins. A major gap
            is a version difference, not a confirmed break: compatibility risk is assessed separately.
          </SectionHeading>
          {rows.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-6 py-12 text-center text-muted-foreground">
              The backend returned no dependencies for this scan. Check the repositories and warnings below.
            </p>
          ) : (
            <div className="space-y-6">
              {noDrift && (
                <p className="flex items-start gap-3 rounded-md border border-success/30 bg-success-tint px-4 py-3 text-sm">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                  <span>
                    <span className="font-medium">No drift found.</span> Every shared package uses matching
                    versions. Only direct dependencies were compared.
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
                  setFilters({ ...DEFAULT_FILTERS, sort: filters.sort, reversed: filters.reversed })
                }}
                shown={visible.length}
                total={rows.length}
              />
              <DriftTable
                rows={visible}
                repos={repos}
                repoLabel={repoLabel}
                selectedId={selected}
                onSelect={select}
                sort={filters.sort}
                reversed={filters.reversed}
                onSort={onSort}
              />
            </div>
          )}
        </section>

        <section id="graph" aria-labelledby="graph-title" className="scroll-mt-28">
          <SectionHeading id="graph-title" eyebrow="Topology" title="Who depends on what">
            Built from the dependencies each repository declares. It shows repository to package links only;
            calls between services are not inferred.
          </SectionHeading>
          <Suspense fallback={<div aria-hidden="true" className="h-[420px] animate-pulse rounded-lg bg-muted" />}>
            <DependencyGraph
              rows={rows}
              repos={repos}
              repoLabel={repoLabel}
              selectedId={selected}
              repo={repoFilter}
              onSelectPackage={select}
              onToggleRepo={(name) => setRepoFilter((current) => (current === name ? null : name))}
            />
          </Suspense>
        </section>

        <section id="evidence" aria-labelledby="evidence-title" className="scroll-mt-28">
          <SectionHeading id="evidence-title" eyebrow="Release evidence" title="What the release notes say">
            Quoted release notes are evidence. AI interpretation is labeled and kept separate. Where nothing was
            retrieved, that is stated: missing evidence is not proof of safety.
          </SectionHeading>
          <ReleaseEvidence rows={rows} warnings={result.warnings} repoLabel={repoLabel} onOpen={select} />
        </section>

        <section id="contracts" aria-labelledby="contracts-title" className="scroll-mt-28">
          <SectionHeading
            id="contracts-title"
            eyebrow="API contract analysis"
            title="Changes between OpenAPI specifications"
            aside={result.contract_analysis ? preview : undefined}
          />
          <ContractAnalysis entries={result.contract_analysis} repoLabel={repoLabel} />
        </section>

        <section id="code-impact" aria-labelledby="code-impact-title" className="scroll-mt-28">
          <SectionHeading
            id="code-impact-title"
            eyebrow="Code impact"
            title="Where your code is affected"
            aside={result.code_impact ? preview : undefined}
          />
          <CodeImpact items={result.code_impact} repoLabel={repoLabel} onOpenDependency={openByName} />
        </section>

        <section id="repositories" aria-labelledby="repositories-title" className="scroll-mt-28">
          <SectionHeading
            id="repositories-title"
            eyebrow="Coverage"
            title="What was and was not analyzed"
          />
          <Repositories result={result} submitted={submitted} />
        </section>
      </main>

      {selectedRow && (
        <DetailPanel
          key={selectedRow.id}
          row={selectedRow}
          repos={repos}
          repoLabel={repoLabel}
          codeImpact={result.code_impact}
          position={selectedIndex === -1 ? null : { index: selectedIndex, total: visible.length }}
          onPrevious={() => step(-1)}
          onNext={() => step(1)}
          onClose={() => select(null)}
        />
      )}
      {limitationsOpen && <LimitationsDialog onClose={() => setLimitationsOpen(false)} />}
    </div>
  )
}
