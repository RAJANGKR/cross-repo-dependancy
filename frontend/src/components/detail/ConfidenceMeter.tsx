import { cx } from '../../lib/cx'
import { formatConfidence } from '../../lib/formatters'

export const CONFIDENCE_HINT = 'How sure DriftLock is. Lower when evidence is missing.'

/** Confidence is a heuristic, never accuracy, and is labeled that way everywhere. */
export function ConfidenceMeter({ confidence, className }: { confidence: number | null; className?: string }) {
  if (confidence === null) {
    return <span className={cx('text-xs text-muted-foreground', className)}>Not available</span>
  }
  const clamped = Math.min(1, Math.max(0, confidence))
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <span
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={clamped}
        aria-valuetext={`${formatConfidence(clamped)} out of 1`}
        className="h-1.5 w-12 overflow-hidden rounded-full bg-muted"
      >
        <span className="block h-full rounded-full bg-foreground" style={{ width: `${clamped * 100}%` }} />
      </span>
      <span aria-hidden="true" className="font-mono text-xs tabular-nums">
        {formatConfidence(clamped)}
      </span>
    </span>
  )
}
