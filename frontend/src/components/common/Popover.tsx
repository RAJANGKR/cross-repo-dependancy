import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useOutsidePress } from '../../hooks/useUi'
import { cx } from '../../lib/cx'

interface PopoverProps {
  /** Accessible name of the popover panel. */
  label: string
  trigger: ReactNode
  children: ReactNode
  align?: 'left' | 'right'
  triggerClassName?: string
  panelClassName?: string
}

/** Click-to-open disclosure panel. Esc or a press outside closes it. */
export function Popover({ label, trigger, children, align = 'left', triggerClassName, panelClassName }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  useOutsidePress(rootRef, open, () => setOpen(false))

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    // Close only this popover, not a dialog it may sit inside.
    event.stopPropagation()
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <span ref={rootRef} className="relative inline-block" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'inline-flex items-center gap-1.5 rounded-sm text-sm text-foreground/70 underline decoration-foreground/30 underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground [&_svg]:size-3.5',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          className={cx(
            'absolute top-full z-30 mt-2 w-80 max-w-[calc(100vw-3rem)] animate-fade-in rounded-md border border-border bg-card p-4 text-sm shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
            panelClassName,
          )}
        >
          {children}
        </div>
      )}
    </span>
  )
}
