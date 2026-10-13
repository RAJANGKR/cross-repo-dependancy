import { Check, CircleX, FileQuestion, GitBranch, TriangleAlert } from 'lucide-react'
import type { GraphSummary, RepositorySummary, ScanResult } from '../../api/scanTypes'
import type { SubmittedRepo } from '../../hooks/useScan'
import { cx } from '../../lib/cx'
import { NOT_AVAILABLE, safeHttpsUrl } from '../../lib/formatters'
import { Tag } from '../common/Tags'

type RepoState = 'analyzed' | 'no-manifests' | 'missing'

interface RepoCard {
  key: string
  name: string
  label: string
  url: string | null
  ref: string | null
  state: RepoState
  summary: RepositorySummary | null
}

/**
 * Merges what was submitted with what came back, so a repository the backend
 * dropped is still listed, as "not in the results", instead of vanishing.
 */
function buildCards(scanned: RepositorySummary[], submitted: SubmittedRepo[]): RepoCard[] {
  const cards: RepoCard[] = scanned.map((repo) => {
    const match = submitted.find(
      (item) => item.name.toLowerCase() === repo.name.toLowerCase() || (repo.url !== null && item.url === repo.url),
    )
    return {
      key: `scanned:${repo.name}`,
      name: repo.name,
      label: match?.label ?? repo.name,
      url: repo.url ?? match?.url ?? null,
      ref: match?.ref ?? null,
      state: repo.manifest_count === 0 ? 'no-manifests' : 'analyzed',
      summary: repo,
    }
  })
  for (const item of submitted) {
    const present = scanned.some(
      (repo) => repo.name.toLowerCase() === item.name.toLowerCase() || (repo.url !== null && repo.url === item.url),
    )
    if (!present) {
      cards.push({ key: `missing:${item.url}`, name: item.name, label: item.label, url: item.url, ref: item.ref, state: 'missing', summary: null })
    }
  }
  return cards
}

const STATE_COPY: Record<RepoState, { text: string; classes: string; icon: typeof Check }> = {
  analyzed: { text: 'Analyzed', classes: 'text-success', icon: Check },
  'no-manifests': {
    text: 'No supported manifests were found, so nothing from this repository was compared',
    classes: 'text-warning',
    icon: FileQuestion,
  },
  missing: {
    text: 'Not in the results. The backend did not report on this repository; check the warnings for the reason',
    classes: 'text-risk-critical',
    icon: CircleX,
  },
}

function Count({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <dd className={cx('tabular-nums', value === null ? 'text-sm text-muted-foreground' : 'font-display text-2xl')}>
        {value ?? NOT_AVAILABLE}
      </dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  )
}

function GraphMetrics({ summary }: { summary: GraphSummary }) {
  return (
    <div className="rounded-lg border border-border bg-background p-5">
      <h3 className="font-mono text-xs uppercase text-muted-foreground">Dependency graph, as built by the backend</h3>
      <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
        <Count label="Nodes" value={summary.total_nodes} />
        <Count label="Edges" value={summary.total_edges} />
        <div>
          <dd className={cx('tabular-nums', summary.density === null ? 'text-sm text-muted-foreground' : 'font-display text-2xl')}>
            {summary.density === null ? NOT_AVAILABLE : summary.density.toFixed(3)}
          </dd>
          <dt className="text-xs text-muted-foreground">Density</dt>
        </div>
      </dl>
      {summary.highest_drift_nodes.length > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          Highest drift: <span className="font-mono text-xs text-foreground">{summary.highest_drift_nodes.join(', ')}</span>
        </p>
      )}
    </div>
  )
}

interface RepositoriesProps {
  result: ScanResult
  submitted: SubmittedRepo[]
}

/** What was and was not analyzed: repositories, warnings and skipped items. */
export function Repositories({ result, submitted }: RepositoriesProps) {
  const cards = buildCards(result.scanned_repositories, submitted)
  const notices = [...result.warnings, ...result.skipped_items.map((item) => `Skipped: ${item}`)]

  return (
    <div className="space-y-6">
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">The backend did not return repository details for this scan.</p>
      ) : (
        <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
          {cards.map((card) => {
            const state = STATE_COPY[card.state]
            const link = safeHttpsUrl(card.url)
            return (
              <li key={card.key} className="flex flex-col gap-3 bg-background p-5">
                <div>
                  <h3 className="font-medium">{card.label}</h3>
                  <p className="font-mono text-xs text-muted-foreground">{card.name}</p>
                </div>
                {card.ref && (
                  <p className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <GitBranch aria-hidden="true" className="size-3" />
                    <span className="sr-only">Branch </span>
                    {card.ref}
                  </p>
                )}
                {card.summary && (
                  <dl className="flex gap-8">
                    <Count label="Manifests" value={card.summary.manifest_count} />
                    <Count label="Dependencies" value={card.summary.total_dependencies} />
                  </dl>
                )}
                <p className={cx('flex items-start gap-1.5 text-sm', state.classes)}>
                  <state.icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>{state.text}</span>
                </p>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-auto text-sm text-foreground/70 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
                  >
                    Open on GitHub
                  </a>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {result.graph_summary && <GraphMetrics summary={result.graph_summary} />}

      <div className="rounded-lg border border-border bg-background p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-mono text-xs uppercase text-muted-foreground">Warnings from the backend</h3>
          <Tag tone={notices.length > 0 ? 'warning' : 'neutral'}>{notices.length}</Tag>
        </div>
        {notices.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">None reported for this scan.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {notices.map((notice) => (
              <li key={notice} className="flex items-start gap-2 text-sm">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="break-words">{notice}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
