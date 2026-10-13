import { useSyncExternalStore } from 'react'

/**
 * Everything DriftLock keeps in this browser: review decisions, fix progress,
 * scan history, saved views and settings. It is versioned, every access is
 * wrapped in try/catch (private windows and blocked storage must not break
 * the app), and pasted manifest content is never written here: history keeps
 * only names and public URLs.
 */
const KEY = 'driftlock:v1'
export const STORE_VERSION = 1

export type ReviewStatus = 'accepted' | 'dismissed' | 'snoozed'

export interface Review {
  status: ReviewStatus
  reason: string
  note: string
  assignee: string
  /** ISO time a snooze ends. */
  until: string | null
  updatedAt: string
}

export interface HistoryTarget {
  kind: 'github' | 'pasted'
  label: string
  name: string
  url: string | null
  ref: string | null
}

export interface HistoryEntry {
  id: string
  at: string
  source: 'live' | 'demo'
  targets: HistoryTarget[]
  drifted: number
  major: number
  findings: number
  /** Drift id -> "DRIFT|RISK", enough to compare two scans. */
  drifts: Record<string, string>
}

export interface SavedView {
  name: string
  /** Query string holding the filters. */
  search: string
}

export interface ActivityEvent {
  at: string
  type: 'scan' | 'review' | 'fix' | 'export' | 'settings'
  text: string
}

export interface Settings {
  theme: 'light' | 'dark' | 'system'
  density: 'comfortable' | 'compact'
  mode: 'technical' | 'executive'
  defaultView: string
  sidebarCollapsed: boolean
  workspace: string
  notifications: boolean
  tourDone: boolean
  /** Compatibility risks that count as critical for KPIs and notifications. */
  criticalRisks: string[]
}

export interface StoreState {
  version: number
  reviews: Record<string, Review>
  fixesDone: string[]
  history: HistoryEntry[]
  views: SavedView[]
  activity: ActivityEvent[]
  readNotices: string[]
  settings: Settings
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  density: 'comfortable',
  mode: 'technical',
  defaultView: 'command',
  sidebarCollapsed: false,
  workspace: 'My workspace',
  notifications: true,
  tourDone: false,
  criticalRisks: ['CONFIRMED_BREAKING'],
}

export const emptyStore = (): StoreState => ({
  version: STORE_VERSION,
  reviews: {},
  fixesDone: [],
  history: [],
  views: [],
  activity: [],
  readNotices: [],
  settings: { ...DEFAULT_SETTINGS },
})

/** Accepts anything and returns a valid state, dropping what it does not recognize. */
export function sanitize(raw: unknown): StoreState {
  const base = emptyStore()
  if (typeof raw !== 'object' || raw === null || (raw as StoreState).version !== STORE_VERSION) return base
  const data = raw as Partial<StoreState>
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
  return {
    version: STORE_VERSION,
    reviews: typeof data.reviews === 'object' && data.reviews !== null ? data.reviews : {},
    fixesDone: list<string>(data.fixesDone).filter((item) => typeof item === 'string'),
    history: list<HistoryEntry>(data.history).slice(0, HISTORY_LIMIT),
    views: list<SavedView>(data.views),
    activity: list<ActivityEvent>(data.activity).slice(0, ACTIVITY_LIMIT),
    readNotices: list<string>(data.readNotices),
    settings: { ...DEFAULT_SETTINGS, ...(typeof data.settings === 'object' && data.settings !== null ? data.settings : {}) },
  }
}

export const HISTORY_LIMIT = 10
export const ACTIVITY_LIMIT = 100

let state: StoreState = emptyStore()
let loaded = false
const listeners = new Set<() => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const text = window.localStorage.getItem(KEY)
    if (text) state = sanitize(JSON.parse(text))
  } catch {
    state = emptyStore()
  }
}

export function getStore(): StoreState {
  load()
  return state
}

export function setStore(next: StoreState): void {
  state = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage is full or blocked: the change still applies for this session.
  }
  for (const listener of listeners) listener()
}

export function updateStore(change: (current: StoreState) => StoreState): void {
  setStore(change(getStore()))
}

export function log(type: ActivityEvent['type'], text: string): void {
  updateStore((current) => ({
    ...current,
    activity: [{ at: new Date().toISOString(), type, text }, ...current.activity].slice(0, ACTIVITY_LIMIT),
  }))
}

export function clearStore(): void {
  setStore(emptyStore())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useStore(): StoreState {
  return useSyncExternalStore(subscribe, getStore, emptyStore)
}

/** A review counts unless it is a snooze that has run out. */
export function activeReview(review: Review | undefined, now = Date.now()): Review | null {
  if (!review) return null
  if (review.status === 'snoozed' && review.until && new Date(review.until).getTime() <= now) return null
  return review
}

export function setReview(id: string, change: Partial<Review> | null): void {
  updateStore((current) => {
    const reviews = { ...current.reviews }
    if (change === null) delete reviews[id]
    else {
      reviews[id] = {
        status: 'accepted',
        reason: '',
        note: '',
        assignee: '',
        until: null,
        ...reviews[id],
        ...change,
        updatedAt: new Date().toISOString(),
      }
    }
    return { ...current, reviews }
  })
}

/** Test helper: forget the in-memory copy so the next read reloads from storage. */
export function resetStoreForTests(): void {
  state = emptyStore()
  loaded = false
}
