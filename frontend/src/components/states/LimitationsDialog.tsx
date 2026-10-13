import { useId } from 'react'
import { LIMITATIONS } from '../../lib/exportMarkdown'
import { Dialog } from '../common/Dialog'

export function LimitationsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      header={
        <>
          <p className="eyebrow">What DriftLock cannot do</p>
          <h2 id={titleId} className="mt-3 font-display text-3xl tracking-tight">
            Limitations
          </h2>
        </>
      }
    >
      <ul className="space-y-4">
        {LIMITATIONS.map((item, index) => (
          <li key={item} className="flex gap-4">
            <span aria-hidden="true" className="font-mono text-xs leading-6 text-muted-foreground">
              {String(index + 1).padStart(2, '0')}
            </span>
            <span className="leading-6">{item}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
