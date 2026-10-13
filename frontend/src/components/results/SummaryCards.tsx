import { lazy, Suspense } from 'react'
import { RISK_LEVELS, type ReportSummary } from '../../api/types'
import { useCountUp } from '../../hooks/useUi'
import { RISK_ICONS } from '../common/RiskBadge'
import { RISK_STYLES } from '../../lib/risk'
import { cx } from '../../lib/cx'

const RiskDistributionChart = lazy(() => import('./RiskDistributionChart'))

function MetricCard({ label, value, note }: { label: string; value: number; note?: string }) {
  const shown = useCountUp(value)
  return (
    <div className="bg-background p-6">
      <dd className="font-display text-5xl tabular-nums tracking-tight lg:text-6xl">
        {/* Screen readers get the final value, not each animation frame. */}
        <span aria-hidden="true">{shown}</span>
        <span className="sr-only">{value}</span>
      </dd>
      <dt className="mt-2 text-sm text-muted-foreground">
        {label}
        {note && <span className="block font-mono text-xs">{note}</span>}
      </dt>
    </div>
  )
}

/** Stacked bar of drifts by risk, with a text legend that carries the same counts. */
export function RiskDistribution({ byRisk }: { byRisk: ReportSummary['by_risk'] }) {
  const total = RISK_LEVELS.reduce((sum, level) => sum + byRisk[level], 0)
  const description = RISK_LEVELS.map((level) => `${level} ${byRisk[level]}`).join(', ')

  return (
    <section aria-labelledby="risk-distribution-title" className="rounded-lg border border-border bg-background p-6">
      <h2 id="risk-distribution-title" className="font-mono text-xs uppercase text-muted-foreground">
        Drifts by risk
      </h2>
      <div role="img" aria-label={`Drifts by risk: ${description}`} className="mt-4 h-7">
        {total === 0 ? (
          <div className="h-full rounded-sm bg-muted" />
        ) : (
          <Suspense fallback={<div className="h-full animate-pulse rounded-sm bg-muted" />}>
            <RiskDistributionChart byRisk={byRisk} total={total} />
          </Suspense>
        )}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {RISK_LEVELS.map((level) => {
          const Icon = RISK_ICONS[level]
          return (
            <li key={level} className="flex items-center gap-2">
              <Icon aria-hidden="true" className={cx('size-4', RISK_STYLES[level].text)} />
              <span>{level}</span>
              <span className="ml-auto font-mono tabular-nums">{byRisk[level]}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function SummaryCards({ summary }: { summary: ReportSummary }) {
  const highAndCritical = summary.by_risk.High + summary.by_risk.Critical
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        <MetricCard label="Projects" value={summary.repos} />
        <MetricCard label="Dependencies" value={summary.dependencies} note="Direct only" />
        <MetricCard label="Drifts found" value={summary.drifts} />
        <MetricCard label="High and Critical" value={highAndCritical} note="Combined" />
      </dl>
      <RiskDistribution byRisk={summary.by_risk} />
    </div>
  )
}
