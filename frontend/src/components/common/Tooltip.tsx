import { useId, useState, type ReactNode } from 'react'
import { cx } from '../../lib/cx'

interface TooltipProps {
  label: ReactNode
  children: ReactNode
  /** Make the wrapper itself focusable, for content that is not a control. */
  focusable?: boolean
  align?: 'left' | 'right'
  className?: string
}

/** Hover and focus tooltip. Esc hides it until the pointer or focus leaves. */
export function Tooltip({ label, children, focusable = false, align = 'left', className }: TooltipProps) {
  const id = useId()
  const [dismissed, setDismissed] = useState(false)
  const reset = () => setDismissed(false)

  return (
    <span
      className={cx('group/tip relative inline-flex', className)}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={id}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDismissed(true)
      }}
      onMouseLeave={reset}
      onBlur={reset}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        className={cx(
          'pointer-events-none absolute top-full z-30 mt-1.5 hidden w-max max-w-72 rounded-sm bg-foreground px-2.5 py-1.5 text-xs font-normal normal-case leading-snug text-background shadow-pop',
          align === 'right' ? 'right-0' : 'left-0',
          !dismissed && 'group-focus-within/tip:block group-hover/tip:block',
        )}
      >
        {label}
      </span>
    </span>
  )
}
