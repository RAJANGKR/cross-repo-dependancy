import { Database, Download, FlaskConical, Radio, RotateCcw, type LucideIcon } from 'lucide-react'
import type { ReportMeta, ReportSource } from '../../api/types'
import { cx } from '../../lib/cx'
import { SOURCE_LABELS } from '../../lib/exportMarkdown'
import { formatDateTime, formatDuration, plural } from '../../lib/formatters'
import { Button } from '../common/Button'
import { Wordmark } from '../common/Tags'

const SOURCE_ICONS: Record<ReportSource, LucideIcon> = { live: Radio, cache: Database, demo: FlaskConical }

/** Where the data on screen came from. Demo data is always labeled as such. */
export function SourceBadge({ source }: { source: ReportSource }) {
  const Icon = SOURCE_ICONS[source]
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

interface TopBarProps {
  meta: ReportMeta
  projectCount: number
  onAnalyzeAgain: () => void
  onExport: () => void
  onOpenLimitations: () => void
}

export function TopBar({ meta, projectCount, onAnalyzeAgain, onExport, onOpenLimitations }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-card/95 px-5 py-3 shadow-nav backdrop-blur sm:px-6">
        <Wordmark />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <SourceBadge source={meta.source} />
          <span>{plural(projectCount, 'project')}</span>
          <span>{formatDateTime(meta.generated_at)}</span>
          <span className="tabular-nums">{formatDuration(meta.duration_ms)}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onOpenLimitations}>
            Limitations
          </Button>
          <Button onClick={onExport}>
            <Download aria-hidden="true" />
            Export report
          </Button>
          <Button variant="primary" onClick={onAnalyzeAgain}>
            <RotateCcw aria-hidden="true" />
            Analyze again
          </Button>
        </div>
      </div>
    </header>
  )
}
