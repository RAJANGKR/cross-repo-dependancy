import { CircleAlert, OctagonAlert, ShieldCheck, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { RiskLevel } from '../../api/types'
import { cx } from '../../lib/cx'
import { RISK_STYLES } from '../../lib/risk'

export const RISK_ICONS: Record<RiskLevel, LucideIcon> = {
  Low: ShieldCheck,
  Medium: CircleAlert,
  High: TriangleAlert,
  Critical: OctagonAlert,
}

/** Risk is always shown as icon plus text; color only reinforces it. */
export function RiskBadge({ level, className }: { level: RiskLevel; className?: string }) {
  const Icon = RISK_ICONS[level]
  const style = RISK_STYLES[level]
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        style.tint,
        style.text,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span>
        <span className="sr-only">Risk: </span>
        {level}
      </span>
    </span>
  )
}
