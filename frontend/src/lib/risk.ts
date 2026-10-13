import type { RiskLevel } from '../api/types'

/** Higher is worse. Used for sorting. */
export const RISK_RANK: Record<RiskLevel, number> = { Low: 0, Medium: 1, High: 2, Critical: 3 }

/** Theme classes per risk level. Colors come from the tokens in index.css. */
export const RISK_STYLES: Record<
  RiskLevel,
  { text: string; tint: string; border: string; fill: string; cssVar: string }
> = {
  Low: {
    text: 'text-risk-low',
    tint: 'bg-risk-low-tint',
    border: 'border-risk-low',
    fill: 'bg-risk-low',
    cssVar: 'var(--color-risk-low)',
  },
  Medium: {
    text: 'text-risk-medium',
    tint: 'bg-risk-medium-tint',
    border: 'border-risk-medium',
    fill: 'bg-risk-medium',
    cssVar: 'var(--color-risk-medium)',
  },
  High: {
    text: 'text-risk-high',
    tint: 'bg-risk-high-tint',
    border: 'border-risk-high',
    fill: 'bg-risk-high',
    cssVar: 'var(--color-risk-high)',
  },
  Critical: {
    text: 'text-risk-critical',
    tint: 'bg-risk-critical-tint',
    border: 'border-risk-critical',
    fill: 'bg-risk-critical',
    cssVar: 'var(--color-risk-critical)',
  },
}
