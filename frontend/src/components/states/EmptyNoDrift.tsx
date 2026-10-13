import { ShieldCheck } from 'lucide-react'
import type { ReportSummary } from '../../api/types'
import { plural } from '../../lib/formatters'

export function EmptyNoDrift({ summary }: { summary: ReportSummary }) {
  return (
    <section aria-labelledby="no-drift-title" className="rounded-lg border border-success/30 bg-success-tint px-6 py-12 text-center">
      <ShieldCheck aria-hidden="true" className="mx-auto size-10 text-success" strokeWidth={1.5} />
      <h2 id="no-drift-title" className="mt-6 font-display text-4xl tracking-tight">
        No drift found
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-lg text-foreground/80">
        {plural(summary.dependencies, 'dependency', 'dependencies')} across{' '}
        {plural(summary.repos, 'project')} use matching versions.
      </p>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
        Only direct dependencies were checked. Transitive dependencies can still differ.
      </p>
    </section>
  )
}
