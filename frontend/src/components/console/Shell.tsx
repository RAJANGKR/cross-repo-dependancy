import {
  Activity,
  Bell,
  CircleHelp,
  Command,
  Database,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Menu as MenuIcon,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Sun,
  TableProperties,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { ScanResult } from '../../api/scanTypes'
import { isDrifted } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { navigate, ROUTE_PATHS } from '../../hooks/useRoute'
import type { DataSource as ScanSource } from '../../lib/exportMarkdown'
import { teamMessage } from '../../lib/insights'
import { updateStore, useStore, type Settings } from '../../lib/localStore'
import { AuthButton } from '../common/AuthButton'
import { Button } from '../common/Button'
import { IconButton, Menu, useCopy } from '../common/Controls'
import { Dialog } from '../common/Dialog'
import { SourceBadge, Wordmark } from '../common/Tags'

export const VIEWS = ['command', 'drifts', 'risk', 'review', 'fixes', 'activity', 'repos', 'settings'] as const
export type View = (typeof VIEWS)[number]

export const VIEW_META: Record<View, { label: string; icon: LucideIcon }> = {
  command: { label: 'Command center', icon: LayoutDashboard },
  drifts: { label: 'Active drifts', icon: TableProperties },
  risk: { label: 'Risk intelligence', icon: ShieldAlert },
  review: { label: 'Review queue', icon: ListChecks },
  fixes: { label: 'Fix plans', icon: Wrench },
  activity: { label: 'Activity', icon: Activity },
  repos: { label: 'Repositories', icon: FolderGit2 },
  settings: { label: 'Settings', icon: SettingsIcon },
}

export const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl or Cmd + K', 'Open the command palette'],
  ['?', 'Show keyboard shortcuts'],
  ['1 to 8', 'Switch view'],
  ['/', 'Go to Active drifts and search'],
  ['J / K', 'Next or previous package in the detail panel'],
  ['T', 'Switch theme'],
  ['Esc', 'Close a panel, dialog or menu'],
]

const SOURCE_TEXT: Record<string, string> = {
  ok: 'Connected',
  degraded: 'Partly failed',
  failed: 'Failed',
  not_used: 'Not needed for this scan',
  not_configured: 'Not configured',
}

/** Applies the saved theme to the document. "system" follows the OS setting. */
export function useTheme(): void {
  const { theme } = useStore().settings
  useEffect(() => {
    const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media?.matches === true)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    media?.addEventListener?.('change', apply)
    return () => media?.removeEventListener?.('change', apply)
  }, [theme])
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  updateStore((store) => ({ ...store, settings: { ...store.settings, [key]: value } }))
}

export function cycleTheme(): void {
  const order: Settings['theme'][] = ['light', 'dark', 'system']
  updateStore((store) => {
    const next = order[(order.indexOf(store.settings.theme) + 1) % order.length] ?? 'system'
    return { ...store, settings: { ...store.settings, theme: next } }
  })
}

export interface Notice {
  key: string
  kind: 'warning' | 'skipped' | 'critical'
  text: string
}

/** Warnings, skipped items and drifts whose risk the user counts as critical. */
export function noticesFor(result: ScanResult, criticalRisks: readonly string[]): Notice[] {
  return [
    ...result.drift_matrix
      .filter((row) => isDrifted(row.drift_disparity) && criticalRisks.includes(row.compatibility_risk))
      .map((row) => ({ key: `critical:${row.id}`, kind: 'critical' as const, text: `${row.dependency_name} needs attention` })),
    ...result.warnings.map((text) => ({ key: `warning:${text}`, kind: 'warning' as const, text })),
    ...result.skipped_items.map((text) => ({ key: `skipped:${text}`, kind: 'skipped' as const, text: `Skipped: ${text}` })),
  ]
}

interface ShellProps {
  view: View
  onView: (view: View) => void
  source: ScanSource
  result: ScanResult
  badges: Partial<Record<View, number>>
  scanning: boolean
  onScanAgain: () => void
  onNewScan: () => void
  onOpenPalette: () => void
  onOpenShortcuts: () => void
  children: ReactNode
}

export function Shell({ view, onView, source, result, badges, scanning, onScanAgain, onNewScan, onOpenPalette, onOpenShortcuts, children }: ShellProps) {
  const { settings, readNotices } = useStore()
  const [drawer, setDrawer] = useState(false)
  const [notify, setNotify] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const collapsed = settings.sidebarCollapsed
  const notices = useMemo(() => noticesFor(result, settings.criticalRisks), [result, settings.criticalRisks])
  const unread = settings.notifications ? notices.filter((notice) => !readNotices.includes(notice.key)) : []
  const sources = result.data_sources
  const connected = sources.filter((item) => item.status === 'ok').length
  const ThemeIcon = settings.theme === 'dark' ? Moon : Sun

  const nav = (
    <nav aria-label="Views" className="flex flex-col gap-1.5">
      {VIEWS.map((name, index) => {
        const { label, icon: Icon } = VIEW_META[name]
        const badge = badges[name]
        return (
          <button
            key={name}
            type="button"
            aria-current={view === name ? 'page' : undefined}
            title={collapsed ? `${label} (${index + 1})` : `Shortcut: ${index + 1}`}
            onClick={() => {
              onView(name)
              setDrawer(false)
            }}
            className={cx(
              'flex min-h-12 items-center gap-3.5 rounded-lg px-4 py-3 text-left text-base transition-colors',
              view === name ? 'bg-foreground text-background' : 'text-foreground/70 hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            <span className={cx('flex-1 truncate', collapsed && 'lg:sr-only')}>{label}</span>
            {badge !== undefined && badge > 0 && (
              <span className={cx('rounded-full px-2 py-0.5 font-mono text-sm tabular-nums', view === name ? 'bg-background/20' : 'bg-secondary', collapsed && 'lg:hidden')}>
                {badge}
                <span className="sr-only"> items</span>
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur print:hidden">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
          <IconButton label="Open menu" className="lg:hidden" onClick={() => setDrawer(true)}>
            <MenuIcon aria-hidden="true" />
          </IconButton>
          <Wordmark />
          <SourceBadge source={source} />
          {editingName ? (
            <input
              autoFocus
              aria-label="Workspace name, saved in this browser"
              defaultValue={settings.workspace}
              maxLength={40}
              onBlur={(event) => {
                setSetting('workspace', event.target.value.trim() || 'My workspace')
                setEditingName(false)
              }}
              onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
              className="h-8 w-40 rounded-full border border-input bg-card px-3 text-xs"
            />
          ) : (
            <button type="button" title="Rename workspace (saved in this browser)" onClick={() => setEditingName(true)} className="hidden h-8 items-center rounded-full bg-secondary px-3 text-xs sm:inline-flex">
              {settings.workspace}
            </button>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1">
            <Menu label="Data sources" trigger={<><Database aria-hidden="true" />Data sources ({connected} connected)</>}>
              {sources.length === 0 ? (
                <p className="text-muted-foreground">The backend did not report its data sources for this scan.</p>
              ) : (
                <ul className="space-y-1.5">
                  {sources.map((item) => (
                    <li key={item.name} className="flex items-center justify-between gap-4">
                      <span>{item.name}</span>
                      <span className={cx('text-xs', item.status === 'ok' ? 'text-success' : item.status === 'failed' || item.status === 'degraded' ? 'text-warning' : 'text-muted-foreground')}>
                        {SOURCE_TEXT[item.status] ?? item.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Menu>
            <div role="group" aria-label="Detail level" className="hidden h-8 items-center rounded-full border border-border p-0.5 text-xs md:inline-flex">
              {(['technical', 'executive'] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={settings.mode === mode} onClick={() => setSetting('mode', mode)} className={cx('h-full rounded-full px-3 capitalize transition-colors', settings.mode === mode ? 'bg-foreground text-background' : 'text-foreground/70 hover:text-foreground')}>
                  {mode}
                </button>
              ))}
            </div>
            <IconButton label="Notify team" onClick={() => setNotify(true)}>
              <Megaphone aria-hidden="true" />
            </IconButton>
            <Menu
              label="Notifications"
              iconLabel={`Notifications, ${unread.length} unread`}
              wide
              trigger={
                <>
                  <Bell aria-hidden="true" />
                  {unread.length > 0 && <span aria-hidden="true" className="absolute right-1 top-1 size-2 rounded-full bg-risk-critical" />}
                </>
              }
              triggerClassName="relative"
            >
              {notices.length === 0 ? (
                <p className="text-muted-foreground">No warnings, skipped items or critical drifts in this scan.</p>
              ) : (
                <>
                  <ul className="max-h-72 space-y-2 overflow-y-auto">
                    {notices.map((notice) => (
                      <li key={notice.key} className={cx('break-words text-sm', readNotices.includes(notice.key) && 'text-muted-foreground')}>
                        <span className="mr-1.5 font-mono text-[0.625rem] uppercase text-muted-foreground">{notice.kind}</span>
                        {notice.text}
                      </li>
                    ))}
                  </ul>
                  <Button size="sm" className="mt-3" disabled={unread.length === 0} onClick={() => updateStore((store) => ({ ...store, readNotices: [...new Set([...store.readNotices, ...notices.map((notice) => notice.key)])].slice(-300) }))}>
                    Mark all read
                  </Button>
                </>
              )}
            </Menu>
            <IconButton label={`Theme: ${settings.theme}. Switch theme`} shortcut="T" onClick={cycleTheme}>
              <ThemeIcon aria-hidden="true" />
            </IconButton>
            <IconButton label="Command palette" shortcut="Ctrl+K" onClick={onOpenPalette}>
              <Command aria-hidden="true" />
            </IconButton>
            <IconButton label="Keyboard shortcuts" shortcut="?" onClick={onOpenShortcuts}>
              <CircleHelp aria-hidden="true" />
            </IconButton>
            <IconButton label="Scan again" disabled={scanning} disabledReason="A scan is already running" onClick={onScanAgain}>
              <RefreshCw aria-hidden="true" />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => navigate(ROUTE_PATHS.rollout)}>
              Rollout planner
            </Button>
            <Button size="sm" variant="primary" onClick={onNewScan}>
              New scan
            </Button>
            <AuthButton size="sm" />
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className={cx('sticky top-[3.25rem] hidden h-[calc(100vh-3.25rem)] shrink-0 flex-col border-r border-border bg-card p-3 lg:flex print:hidden', collapsed ? 'w-20' : 'w-72')}>
          {nav}
          <IconButton label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} className="mt-auto size-10 [&_svg]:size-5" onClick={() => setSetting('sidebarCollapsed', !collapsed)}>
            {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          </IconButton>
        </aside>
        <main className="min-w-0 flex-1 px-4 pb-24 pt-6 sm:px-6 lg:px-8">{children}</main>
      </div>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div aria-hidden="true" className="absolute inset-0 bg-foreground/30" onClick={() => setDrawer(false)} />
          <div role="dialog" aria-modal="true" aria-label="Views" className="relative h-full w-72 animate-fade-in bg-card p-3 shadow-panel" onKeyDown={(event) => event.key === 'Escape' && setDrawer(false)}>
            {nav}
          </div>
        </div>
      )}
      {notify && <NotifyDialog result={result} onClose={() => setNotify(false)} />}
    </div>
  )
}

function NotifyDialog({ result, onClose }: { result: ScanResult; onClose: () => void }) {
  const titleId = useId()
  const copy = useCopy()
  const [text, setText] = useState(() => teamMessage(result.drift_matrix))
  return (
    <Dialog
      labelledBy={titleId}
      onClose={onClose}
      header={
        <h2 id={titleId} className="font-display text-2xl tracking-tight">
          Notify team
        </h2>
      }
      footer={<Button variant="primary" onClick={() => void copy(text, 'Message')}>Copy message</Button>}
    >
      <p className="text-sm text-muted-foreground">A message for Slack or Teams, built from the highest-priority drifts. DriftLock copies it; it does not send anything.</p>
      <label htmlFor={`${titleId}-text`} className="sr-only">
        Message
      </label>
      <textarea id={`${titleId}-text`} rows={9} value={text} onChange={(event) => setText(event.target.value)} className="mt-3 w-full rounded-md border border-input bg-card p-3 font-mono text-xs" />
    </Dialog>
  )
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  return (
    <Dialog labelledBy={titleId} onClose={onClose} header={<h2 id={titleId} className="font-display text-2xl tracking-tight">Keyboard shortcuts</h2>}>
      <dl className="space-y-2 text-sm">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} className="flex items-center justify-between gap-4">
            <dt>{action}</dt>
            <dd className="rounded-sm bg-secondary px-2 py-0.5 font-mono text-xs">{keys}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}

export interface PaletteCommand {
  id: string
  group: 'View' | 'Action' | 'Package'
  label: string
  run: () => void
}

/** Search over views, actions and packages. Up and Down move, Enter runs. */
export function CommandPalette({ commands, onClose }: { commands: PaletteCommand[]; onClose: () => void }) {
  const titleId = useId()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    return commands.filter((command) => !text || command.label.toLowerCase().includes(text)).slice(0, 40)
  }, [commands, query])
  const index = Math.min(active, Math.max(0, matches.length - 1))

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.min(matches.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1))))
    } else if (event.key === 'Enter' && matches[index]) {
      event.preventDefault()
      onClose()
      matches[index].run()
    }
  }

  return (
    <Dialog labelledBy={titleId} onClose={onClose} header={<h2 id={titleId} className="font-display text-2xl tracking-tight">Command palette</h2>}>
      <label htmlFor={`${titleId}-input`} className="sr-only">
        Search views, actions and packages
      </label>
      <input
        id={`${titleId}-input`}
        data-autofocus
        role="combobox"
        aria-expanded
        aria-controls={`${titleId}-list`}
        aria-activedescendant={matches[index] ? `${titleId}-${index}` : undefined}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={onKeyDown}
        placeholder="Search views, actions and packages"
        autoComplete="off"
        className="h-11 w-full rounded-md border border-input bg-card px-3 text-sm"
      />
      <ul ref={listRef} id={`${titleId}-list`} role="listbox" aria-label="Results" className="mt-3 max-h-80 overflow-y-auto">
        {matches.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">Nothing matches.</li>}
        {matches.map((command, position) => (
          <li
            key={command.id}
            id={`${titleId}-${position}`}
            role="option"
            aria-selected={position === index}
            onMouseEnter={() => setActive(position)}
            onClick={() => {
              onClose()
              command.run()
            }}
            className={cx('flex cursor-pointer items-center gap-3 rounded-sm px-2 py-2 text-sm', position === index && 'bg-secondary')}
          >
            <span className="w-16 shrink-0 font-mono text-[0.625rem] uppercase text-muted-foreground">{command.group}</span>
            <span className="truncate">{command.label}</span>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

const TOUR = [
  ['Command center', 'Start here: the four headline numbers, the dependency graph and the drifts that most need attention.'],
  ['Open a drift', 'Select any package to see versions per repository, release evidence, affected code and a fix line you can copy.'],
  ['Review and fix', 'Accept, dismiss or snooze each drift in the Review queue, then work through Fix plans. Decisions are saved in this browser only.'],
  ['Everything is labeled', 'Demo data says so. Missing evidence is shown as missing, never as safe. Press ? for shortcuts, Ctrl+K for the palette.'],
] as const

/** First-run guide. Shown once; it can be restarted from Settings. */
export function Tour({ onClose }: { onClose: (dontShowAgain: boolean) => void }) {
  const titleId = useId()
  const [step, setStep] = useState(0)
  const [title, text] = TOUR[step] ?? TOUR[0]
  const last = step === TOUR.length - 1
  return (
    <Dialog
      labelledBy={titleId}
      onClose={() => onClose(false)}
      header={
        <>
          <p className="font-mono text-xs text-muted-foreground">
            Step {step + 1} of {TOUR.length}
          </p>
          <h2 id={titleId} className="mt-2 font-display text-2xl tracking-tight">
            {title}
          </h2>
        </>
      }
      footer={
        <>
          <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          <Button variant="primary" onClick={() => (last ? onClose(true) : setStep(step + 1))}>
            {last ? 'Finish' : 'Next'}
          </Button>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Skip
          </Button>
          <Button variant="ghost" onClick={() => onClose(true)}>
            Don&apos;t show again
          </Button>
        </>
      }
    >
      <p className="leading-relaxed">{text}</p>
    </Dialog>
  )
}
