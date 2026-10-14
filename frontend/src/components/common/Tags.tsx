import { Database, FlaskConical, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'
import { SOURCE_LABELS, type DataSource } from '../../lib/exportMarkdown'
import { ecosystemLabel } from '../../lib/formatters'

export function EcosystemTag({ ecosystem }: { ecosystem: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase text-muted-foreground">
      {ecosystemLabel(ecosystem)}
    </span>
  )
}

/** Small neutral label with an optional icon, for states and metadata. */
export function Tag({
  children,
  icon,
  tone = 'neutral',
}: {
  children: ReactNode
  icon?: ReactNode
  tone?: 'neutral' | 'warning' | 'success' | 'error'
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs [&_svg]:size-3',
        tone === 'neutral' && 'bg-secondary text-muted-foreground',
        tone === 'warning' && 'bg-warning-tint text-warning',
        tone === 'success' && 'bg-success-tint text-success',
        tone === 'error' && 'bg-risk-critical-tint text-risk-critical',
      )}
    >
      {icon}
      {children}
    </span>
  )
}

/** Where the data on screen came from. Demo data is always labeled as such. */
export function SourceBadge({ source }: { source: DataSource }) {
  const Icon = source === 'demo' ? FlaskConical : Radio
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-xs',
        source === 'demo' ? 'bg-warning-tint text-warning' : 'bg-secondary text-foreground',
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="sr-only">Data source: </span>
      {SOURCE_LABELS[source]}
    </span>
  )
}

/** Marks a section whose data shape is not final on the backend yet. */
export function PreviewTag() {
  return (
    <Tag tone="warning" icon={<Database aria-hidden="true" />}>
      Preview format
    </Tag>
  )
}

/** Wordmark used in every top bar. */
export function Wordmark() {
  return (
    <span className="font-display text-2xl tracking-tight">DriftLock</span>
  )
}

/** Mono label and heading used at the top of each dashboard section. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  aside,
  children,
}: {
  id: string
  eyebrow: string
  title: string
  aside?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="mb-6">
      <p className="eyebrow">{eyebrow}</p>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 id={id} className="font-display text-3xl tracking-tight lg:text-4xl">
          {title}
        </h2>
        {aside}
      </div>
      {children && <div className="mt-3 max-w-3xl text-muted-foreground">{children}</div>}
    </div>
  )
}
