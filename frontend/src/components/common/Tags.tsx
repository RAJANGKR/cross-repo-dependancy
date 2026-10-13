import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'
import { ecosystemLabel } from '../../lib/formatters'

export function EcosystemTag({ ecosystem }: { ecosystem: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 font-mono text-[0.6875rem] uppercase text-muted-foreground">
      {ecosystemLabel(ecosystem)}
    </span>
  )
}

/** Monospace chip such as "service-a 1.10.13". */
export function VersionChip({ repo, version }: { repo?: string; version: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-sm bg-secondary px-2 py-0.5 font-mono text-xs tabular-nums">
      {repo && <span className="text-muted-foreground">{repo}</span>}
      <span>{version || 'unknown'}</span>
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

/** Wordmark used in both top bars. */
export function Wordmark() {
  return (
    <span className="flex items-center gap-2">
      <span className="font-display text-2xl tracking-tight">DriftLock</span>
      <span aria-hidden="true" className="mt-1 font-mono text-xs text-muted-foreground">
        PS 07
      </span>
    </span>
  )
}
