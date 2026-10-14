import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { RolloutResult } from '../api/rolloutClient'

/**
 * The rollout planner's latest answer, kept for this page session so the
 * assistant can refer to it. It is cleared when a new analysis starts, so an
 * old verdict is never used next to new inputs. Nothing is stored.
 */
interface RolloutMemory {
  rollout: RolloutResult | null
  remember: (result: RolloutResult | null) => void
}

// Without a provider there is simply nothing remembered, so the planner works on its own.
const RolloutMemoryContext = createContext<RolloutMemory>({ rollout: null, remember: () => undefined })

export function RolloutMemoryProvider({ children }: { children: ReactNode }) {
  const [rollout, setRollout] = useState<RolloutResult | null>(null)
  const remember = useCallback((result: RolloutResult | null) => setRollout(result), [])
  const value = useMemo(() => ({ rollout, remember }), [rollout, remember])
  return <RolloutMemoryContext.Provider value={value}>{children}</RolloutMemoryContext.Provider>
}

export function useRolloutMemory(): RolloutMemory {
  return useContext(RolloutMemoryContext)
}
