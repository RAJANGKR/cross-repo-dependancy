import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cx } from '../../lib/cx'

interface DisclosureProps {
  /** What opening it shows, for example "View evidence". */
  label: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Collapsed-by-default technical detail. It is a native `<details>` element,
 * so it works with a keyboard and a screen reader without any script, and the
 * content stays in the page: nothing is removed, it is only one click away.
 */
export function Disclosure({ label, children, className }: DisclosureProps) {
  return (
    <details className={cx('disclosure', className)}>
      <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm py-1 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground">
        <ChevronRight aria-hidden="true" className="disclosure-chevron size-4 shrink-0" />
        {label}
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  )
}
