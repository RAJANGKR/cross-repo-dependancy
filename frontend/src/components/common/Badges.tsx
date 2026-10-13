import {
  Check,
  ChevronUp,
  ChevronsUp,
  CircleDashed,
  CircleDot,
  CircleHelp,
  FileQuestion,
  FileWarning,
  Minus,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { cx } from '../../lib/cx'
import { contractMeta, driftMeta, riskMeta, TONE_STYLES, type ClassMeta, type Tone } from '../../lib/classify'

const DRIFT_ICONS: Record<string, LucideIcon> = {
  MAJOR_DRIFT: ChevronsUp,
  MINOR_DRIFT: ChevronUp,
  INFO: CircleDot,
  IN_SYNC: Check,
}

const RISK_ICONS: Record<string, LucideIcon> = {
  CONFIRMED_BREAKING: OctagonAlert,
  SUSPECTED_BREAKING: TriangleAlert,
  UNKNOWN_IMPACT: CircleHelp,
  NONE: Minus,
}

const CONTRACT_ICONS: Record<string, LucideIcon> = {
  ANALYZED: Check,
  SPEC_UNAVAILABLE: FileQuestion,
  MALFORMED_SPEC: FileWarning,
  RELATIONSHIP_UNVERIFIED: CircleHelp,
  UNRESOLVED: CircleDashed,
  NOT_COMPARED: Minus,
}

export const driftIcon = (value: string): LucideIcon => DRIFT_ICONS[value] ?? CircleDashed
export const riskIcon = (value: string): LucideIcon => RISK_ICONS[value] ?? CircleDashed

interface BadgeProps {
  meta: ClassMeta
  icon: LucideIcon
  /** Read before the label by screen readers, for example "Drift". */
  prefix: string
  className?: string
}

/** Every classification is icon plus text; color only reinforces it. */
function ClassBadge({ meta, icon: Icon, prefix, className }: BadgeProps) {
  const style = TONE_STYLES[meta.tone]
  return (
    <span
      title={meta.description}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium',
        style.tint,
        style.text,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        <span className="sr-only">{prefix}: </span>
        {meta.label}
      </span>
    </span>
  )
}

export function DriftBadge({ value, className }: { value: string; className?: string }) {
  return <ClassBadge meta={driftMeta(value)} icon={driftIcon(value)} prefix="Drift" className={className} />
}

export function RiskBadge({ value, className }: { value: string; className?: string }) {
  return <ClassBadge meta={riskMeta(value)} icon={riskIcon(value)} prefix="Compatibility risk" className={className} />
}

export function ContractBadge({ value, className }: { value: string; className?: string }) {
  return (
    <ClassBadge
      meta={contractMeta(value)}
      icon={CONTRACT_ICONS[value] ?? CircleDashed}
      prefix="Contract analysis"
      className={className}
    />
  )
}

/** Free-form label from the backend (severity, confidence) with a tone. */
export function ToneBadge({ label, tone, prefix }: { label: string; tone: Tone; prefix: string }) {
  const style = TONE_STYLES[tone]
  return (
    <span className={cx('inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium', style.tint, style.text)}>
      <span className="sr-only">{prefix}: </span>
      {label}
    </span>
  )
}
