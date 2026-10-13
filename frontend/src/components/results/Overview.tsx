import { CircleCheck, TriangleAlert } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { useCountUp } from '../../hooks/useUi'
import { TONE_STYLES } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { NOT_AVAILABLE, plural } from '../../lib/formatters'
import type { DistributionSlice, Metric, Overview as OverviewData } from '../../lib/overview'
import { driftIcon } from '../common/Badges'

const DriftChart = lazy(() => import('./DriftChart'))

function MetricValue({ value }: { value: number }) {
  const shown = useCountUp(value)
  return (
    <>
      {/* Screen readers get the final value, not each animation frame. */}
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{value}</span>
    </>
  )
}

function MetricCard({ metric }: { metric: Metric }) {
  return (
    <div className="bg-background p-5 lg:p-6">
      <dd className="font-display text-4xl tabular-nums tracking-tight lg:text-5xl">
        {metric.value === null ? (
          // A missing number is said to be missing. It is never shown as zero.
          <span className="font-sans text-base font-normal tracking-normal text-muted-foreground">{NOT_AVAILABLE}</span>
        ) : (
          <MetricValue value={metric.value} />
        )}
      </dd>
      <dt className="mt-2 text-sm text-muted-foreground">
        {metric.label}
        {metric.note && <span className="mt-0.5 block font-mono text-xs">{metric.note}</span>}
      </dt>
    </div>
  )
}

/** Stacked bar of packages by drift classification, with a legend carrying the same counts. */
function Distribution({ slices }: { slices: DistributionSlice[] | null }) {
  const total = slices?.reduce((sum, slice) => sum + slice.count, 0) ?? 0
  return (
    <section aria-labelledby="distribution-title" className="rounded-lg border border-border bg-background p-6">
      <h3 id="distribution-title" className="font-mono text-xs uppercase text-muted-foreground">
        Packages by drift
      </h3>
      {!slices ? (
        <p className="mt-4 text-sm text-muted-foreground">The backend did not return a drift breakdown.</p>
      ) : (
        <>
          <div
            role="img"
            aria-label={`Packages by drift: ${slices.map((slice) => `${slice.label} ${slice.count}`).join(', ')}`}
            className="mt-4 h-7"
          >
            {total === 0 ? (
              <div className="h-full rounded-sm bg-muted" />
            ) : (
              <Suspense fallback={<div className="h-full animate-pulse rounded-sm bg-muted" />}>
                <DriftChart slices={slices} total={total} />
              </Suspense>
            )}
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {slices.map((slice) => {
              const Icon = driftIcon(slice.key)
              return (
                <li key={slice.key} className="flex items-center gap-2">
                  <Icon aria-hidden="true" className={cx('size-4', TONE_STYLES[slice.tone].text)} />
                  <span>{slice.label}</span>
                  <span className="ml-auto font-mono tabular-nums">{slice.count}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

interface OverviewProps {
  overview: OverviewData
  warningCount: number
  onOpenRepositories?: () => void
}

/** Says plainly whether the scan finished clean or with caveats. */
function ScanStatus({ overview, warningCount, onOpenRepositories }: OverviewProps) {
  if (!overview.hasWarnings) {
    return (
      <p className="flex items-start gap-3 rounded-md border border-success/30 bg-success-tint px-4 py-3 text-sm">
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
        <span>
          <span className="font-medium">Scan completed.</span> The backend reported no warnings.
        </span>
      </p>
    )
  }
  const parts = [plural(warningCount, 'warning')]
  if (overview.incompleteRepos.length > 0) {
    parts.push(`${plural(overview.incompleteRepos.length, 'repository', 'repositories')} not fully analyzed`)
  }
  return (
    <p className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning-tint px-4 py-3 text-sm">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>
        <span className="font-medium">Scan completed with warnings.</span> {parts.join(', ')}. The results below
        cover only what could be analyzed.{' '}
        {onOpenRepositories ? (
          <button
            type="button"
            onClick={onOpenRepositories}
            className="inline cursor-pointer border-0 bg-transparent p-0 text-inherit font-inherit underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
          >
            See what was and was not analyzed
          </button>
        ) : (
          <a href="#repositories" className="underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
            See what was and was not analyzed
          </a>
        )}
      </span>
    </p>
  )
}

export function Overview({ overview, warningCount, onOpenRepositories }: OverviewProps) {
  return (
    <div className="space-y-6">
      <ScanStatus overview={overview} warningCount={warningCount} onOpenRepositories={onOpenRepositories} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
          {overview.metrics.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </dl>
        <Distribution slices={overview.distribution} />
      </div>
      {overview.derived && (
        <p className="text-sm text-muted-foreground">
          The backend sent no summary breakdown, so drift and risk counts were tallied from the rows it
          returned.
        </p>
      )}
    </div>
  )
}
