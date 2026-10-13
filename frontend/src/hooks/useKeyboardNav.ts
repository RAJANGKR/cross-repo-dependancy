import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface KeyboardNav {
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Attach to each row so focus can follow the active index. */
  registerRow: (index: number) => (element: HTMLElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * Roving-focus row navigation: Up and Down move the active row, Home and End
 * jump to the ends, Enter and Space activate it.
 */
export function useKeyboardNav(rowCount: number, onActivate: (index: number) => void): KeyboardNav {
  const [activeIndex, setActiveIndex] = useState(0)
  const rows = useRef(new Map<number, HTMLElement>())
  const shouldFocus = useRef(false)

  const clamped = rowCount === 0 ? 0 : Math.min(activeIndex, rowCount - 1)

  useEffect(() => {
    if (!shouldFocus.current) return
    shouldFocus.current = false
    rows.current.get(clamped)?.focus()
  }, [clamped])

  const registerRow = useCallback(
    (index: number) => (element: HTMLElement | null) => {
      if (element) rows.current.set(index, element)
      else rows.current.delete(index)
    },
    [],
  )

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Keys pressed inside a control within the row belong to that control.
      if (event.target !== event.currentTarget) return
      if (rowCount === 0) return
      let next: number | null = null
      switch (event.key) {
        case 'ArrowDown':
          next = Math.min(rowCount - 1, clamped + 1)
          break
        case 'ArrowUp':
          next = Math.max(0, clamped - 1)
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = rowCount - 1
          break
        case 'Enter':
        case ' ':
          event.preventDefault()
          onActivate(clamped)
          return
        default:
          return
      }
      event.preventDefault()
      shouldFocus.current = true
      setActiveIndex(next)
    },
    [rowCount, clamped, onActivate],
  )

  return { activeIndex: clamped, setActiveIndex, registerRow, onKeyDown }
}
