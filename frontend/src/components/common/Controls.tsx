import { LoaderCircle, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cx } from '../../lib/cx'
import { Button, type ButtonProps } from './Button'

const ICON_BUTTON =
  'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-4'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name, also shown as the tooltip. */
  label: string
  /** Keyboard shortcut shown in the tooltip. */
  shortcut?: string
  /** Why the button is disabled; replaces the tooltip while it is. */
  disabledReason?: string
}

/** Icon-only button. The label is both its accessible name and its tooltip. */
export function IconButton({ label, shortcut, disabledReason, className, children, ...rest }: IconButtonProps) {
  const title = rest.disabled && disabledReason ? disabledReason : shortcut ? `${label} (${shortcut})` : label
  return (
    <button type="button" aria-label={label} title={title} className={cx(ICON_BUTTON, className)} {...rest}>
      {children}
    </button>
  )
}

/** Button with a spinner and "..." label while its action runs. */
export function BusyButton({ busy, children, ...rest }: ButtonProps & { busy: boolean }) {
  return (
    <Button {...rest} disabled={busy || rest.disabled} aria-busy={busy}>
      {busy && <LoaderCircle aria-hidden="true" className="animate-spin" />}
      {children}
      {busy && '...'}
    </Button>
  )
}

interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick'> {
  /** Names exactly what will be removed, for example "Remove 3 repository rows". */
  confirmLabel: string
  onConfirm: () => void
}

/** Two-step destructive action: the first press asks, the second confirms. */
export function ConfirmButton({ confirmLabel, onConfirm, children, ...rest }: ConfirmButtonProps) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <Button {...rest} onClick={() => setAsking(true)}>
        {children}
      </Button>
    )
  }
  return (
    <span role="group" aria-label="Confirm" className="inline-flex items-center gap-1">
      <Button
        {...rest}
        variant="primary"
        autoFocus
        onClick={() => {
          setAsking(false)
          onConfirm()
        }}
      >
        {confirmLabel}
      </Button>
      <Button {...rest} variant="ghost" onClick={() => setAsking(false)}>
        Keep
      </Button>
    </span>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  const id = useId()
  return (
    <label htmlFor={id} className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-foreground"
      />
      {label}
    </label>
  )
}

interface MenuProps {
  /** Accessible name of the panel. */
  label: string
  trigger: ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'
  triggerClassName?: string
  /** Render the trigger as an icon button with this tooltip. */
  iconLabel?: string
  wide?: boolean
}

/** Click-to-open panel. Esc or a press outside closes it and returns focus. */
export function Menu({ label, trigger, children, align = 'right', triggerClassName, iconLabel, wide }: MenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return
    event.stopPropagation()
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <span ref={rootRef} className="relative inline-flex" onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={iconLabel}
        title={iconLabel}
        onClick={() => setOpen((value) => !value)}
        className={cx(
          iconLabel
            ? ICON_BUTTON
            : 'inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs transition-colors hover:border-foreground/40 [&_svg]:size-3.5',
          triggerClassName,
        )}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          onPointerDown={(event) => event.stopPropagation()}
          className={cx(
            'absolute top-full z-50 mt-2 max-w-[calc(100vw-2rem)] animate-fade-in rounded-md border border-border bg-card p-3 text-sm shadow-pop',
            wide ? 'w-96' : 'w-72',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </span>
  )
}

/** One row inside a Menu. */
export function MenuItem({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4"
    >
      {children}
    </button>
  )
}

// ---- Toasts ------------------------------------------------------------------

interface Toast {
  id: number
  text: string
  undo?: () => void
}

type ShowToast = (text: string, undo?: () => void) => void

const ToastContext = createContext<ShowToast>(() => undefined)
const TOAST_MS = 6000

/** Confirms each data-changing action, with Undo when it can be reversed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), [])

  const show = useCallback<ShowToast>(
    (text, undo) => {
      const id = (counter.current += 1)
      setToasts((list) => [...list.slice(-2), { id, text, undo }])
      setTimeout(() => dismiss(id), TOAST_MS)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 print:hidden">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto flex animate-fade-in items-center gap-3 rounded-md bg-foreground px-4 py-3 text-sm text-background shadow-pop">
            <span className="min-w-0 flex-1">{toast.text}</span>
            {toast.undo && (
              <button
                type="button"
                onClick={() => {
                  toast.undo?.()
                  dismiss(toast.id)
                }}
                className="font-medium underline underline-offset-4"
              >
                Undo
              </button>
            )}
            <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(toast.id)} className="opacity-70 hover:opacity-100">
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ShowToast {
  return useContext(ToastContext)
}

/** Copies text and confirms with a toast. Returns false when the clipboard is unavailable. */
export function useCopy(): (text: string, what: string) => Promise<boolean> {
  const toast = useToast()
  return useCallback(
    async (text, what) => {
      try {
        await navigator.clipboard.writeText(text)
        toast(`${what} copied`)
        return true
      } catch {
        toast('Copy failed. Select the text and copy it manually.')
        return false
      }
    },
    [toast],
  )
}
