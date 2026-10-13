import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

const AnnouncerContext = createContext<(message: string) => void>(() => undefined)

/** Renders one polite live region and lets any component speak through it. */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  const announce = useCallback((text: string) => setMessage(text), [])

  return (
    <AnnouncerContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </AnnouncerContext.Provider>
  )
}

export function useAnnounce(): (message: string) => void {
  return useContext(AnnouncerContext)
}
