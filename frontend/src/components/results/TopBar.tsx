import { Download, RotateCcw } from 'lucide-react'
import type { ScanRecord } from '../../api/scanTypes'
import type { DataSource } from '../../lib/exportMarkdown'
import { formatDateTime, formatDuration } from '../../lib/formatters'
import { Button } from '../common/Button'
import { SourceBadge, Wordmark } from '../common/Tags'

interface TopBarProps {
  record: ScanRecord
  source: DataSource
  onNewScan: () => void
  onExport: () => void
  onOpenLimitations: () => void
}

export function TopBar({ record, source, onNewScan, onExport, onOpenLimitations }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 mx-auto max-w-[1400px] px-4 pt-5 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border bg-card/95 px-5 py-3 shadow-nav backdrop-blur sm:px-6">
        <Wordmark />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <SourceBadge source={source} />
          <span>{formatDateTime(record.completed_at ?? record.updated_at)}</span>
          <span className="tabular-nums">{formatDuration(record.duration_seconds)}</span>
          <span className="break-all font-mono text-xs">{record.scan_id}</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onOpenLimitations}>
            Limitations
          </Button>
          <Button onClick={onExport}>
            <Download aria-hidden="true" />
            Export report
          </Button>
          <Button variant="primary" onClick={onNewScan}>
            <RotateCcw aria-hidden="true" />
            Start a new scan
          </Button>
        </div>
      </div>
    </header>
  )
}
