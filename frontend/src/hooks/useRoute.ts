import { useMemo, useSyncExternalStore } from 'react'

/**
 * Minimal history-based routing for the four screens (`/`, `/results`,
 * `/rollout` and `/repositories`). The project has no routing library and four routes do not justify one.
 */

export type RouteName = 'input' | 'results' | 'rollout' | 'repositories'

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

function snapshot(): string {
  return `${window.location.pathname}${window.location.search}`
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === snapshot()) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  for (const listener of listeners) listener()
}

export function routeNameOf(pathname: string): RouteName {
  const path = pathname.replace(/\/+$/, '')
  return path === '/results' ? 'results' : path === '/rollout' ? 'rollout' : path === '/repositories' ? 'repositories' : 'input'
}

export const ROUTE_PATHS: Record<RouteName, string> = { input: '/', results: '/results', rollout: '/rollout', repositories: '/repositories' }

export interface Route {
  name: RouteName
  /** Query string including the leading "?", or an empty string. */
  search: string
}

export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => {
    const queryStart = href.indexOf('?')
    const pathname = queryStart === -1 ? href : href.slice(0, queryStart)
    return { name: routeNameOf(pathname), search: queryStart === -1 ? '' : href.slice(queryStart) }
  }, [href])
}

/** Keeps only the dev `mock` switch when moving between screens. */
export function carrySearch(search: string): string {
  const mock = new URLSearchParams(search).get('mock')
  return mock ? `?mock=${encodeURIComponent(mock)}` : ''
}
