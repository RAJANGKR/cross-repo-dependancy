import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'

type Tone = 'info' | 'warning' | 'error' | 'success'

const TONES: Record<Tone, { icon: LucideIcon; classes: string }> = {
  info: { icon: Info, classes: 'border-border bg-info-tint text-info' },
  warning: { icon: TriangleAlert, classes: 'border-warning/30 bg-warning-tint text-warning' },
  error: { icon: CircleAlert, classes: 'border-risk-critical/30 bg-risk-critical-tint text-risk-critical' },
  success: { icon: CircleCheck, classes: 'border-success/30 bg-success-tint text-success' },
}

interface BannerProps {
  tone?: Tone
  title?: string
  children?: ReactNode
  actions?: ReactNode
  onDismiss?: () => void
  /** Use "alert" only for errors that need immediate attention. */
  role?: 'alert' | 'status' | 'note'
  className?: string
}

export function Banner({ tone = 'info', title, children, actions, onDismiss, role = 'note', className }: BannerProps) {
  const { icon: Icon, classes } = TONES[tone]
  return (
    <div role={role} className={cx('flex items-start gap-3 rounded-md border px-4 py-3 text-sm', classes, className)}>
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 text-foreground">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx('text-foreground/80', title && 'mt-0.5')}>{children}</div>}
        {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full p-1 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  )
}
