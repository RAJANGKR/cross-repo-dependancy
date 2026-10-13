import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAnnounce } from '../../hooks/useAnnouncer'
import { Button, type ButtonProps } from './Button'

interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children'> {
  /** Text to copy, or a function so large text is only built on demand. */
  text: string | (() => string)
  label: string
  /** Show only the icon; `label` becomes the accessible name. */
  iconOnly?: boolean
}

export function CopyButton({ text, label, iconOnly = false, ...rest }: CopyButtonProps) {
  const announce = useAnnounce()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [state])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text)
      setState('copied')
      announce('Copied to clipboard')
    } catch {
      setState('failed')
      announce('Copy failed. Select the text and copy it manually.')
    }
  }

  const visible = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label={iconOnly ? label : undefined} {...rest}>
      {state === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {iconOnly ? state !== 'idle' && <span>{visible}</span> : <span>{visible}</span>}
    </Button>
  )
}
