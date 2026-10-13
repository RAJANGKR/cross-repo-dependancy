import { X } from 'lucide-react'
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useFocusTrap } from '../../hooks/useUi'
import { cx } from '../../lib/cx'

interface DialogProps {
  /** Id of the element that names the dialog. */
  labelledBy: string
  onClose: () => void
  children: ReactNode
  /** "center" is a modal card; "side" slides in from the right and is full screen below tablet width. */
  variant?: 'center' | 'side'
  /** Extra controls placed before the close button. */
  toolbar?: ReactNode
  header: ReactNode
  footer?: ReactNode
}

/**
 * Modal dialog. Focus moves in on open, Tab stays inside, Esc and the backdrop
 * close it, and focus returns to the element that opened it.
 */
export function Dialog({ labelledBy, onClose, children, variant = 'center', toolbar, header, footer }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)

  // The page behind a modal must not scroll.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className={cx('fixed inset-0 z-50 flex', variant === 'center' ? 'items-center justify-center p-4' : 'justify-end')}
    >
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 animate-fade-in bg-foreground/30" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cx(
          'relative flex max-h-full flex-col bg-background outline-none',
          variant === 'center'
            ? 'w-full max-w-lg animate-fade-in rounded-lg border border-border shadow-pop'
            : 'h-full w-full animate-slide-in border-l border-border shadow-panel md:w-[min(44rem,92vw)]',
        )}
      >
        <div className="flex items-start gap-4 border-b border-border px-6 py-5">
          <div className="min-w-0 flex-1">{header}</div>
          <div className="flex shrink-0 items-center gap-1">
            {toolbar}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4">{footer}</div>}
      </div>
    </div>
  )
}
