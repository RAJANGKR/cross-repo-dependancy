import { Check, ChevronDown, CircleX, FileQuestion, GitBranch, GitCommitHorizontal, RotateCcw, ScanSearch } from 'lucide-react'
import { useState } from 'react'
import type { RepoInfo, SkippedDependency } from '../../api/types'
import { cx } from '../../lib/cx'
import { plural, shortCommit } from '../../lib/formatters'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'
import { Tag } from '../common/Tags'

function StatusLine({ repo }: { repo: RepoInfo }) {
  if (repo.status === 'ok') {
    return (
      <p className="flex items-center gap-1.5 text-sm text-success">
        <Check aria-hidden="true" className="size-4" />
        Analyzed
      </p>
    )
  }
  const Icon = repo.status === 'no_manifest' ? FileQuestion : CircleX
  const headline = repo.status === 'no_manifest' ? 'No supported manifest found' : 'Could not be analyzed'
  return (
    <div className={cx('text-sm', repo.status === 'error' ? 'text-risk-critical' : 'text-warning')}>
      <p className="flex items-center gap-1.5 font-medium">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {headline}
      </p>
      {repo.message && <p className="mt-1 text-foreground/80">{repo.message}</p>}
    </div>
  )
}

interface ProjectStatusStripProps {
  repos: RepoInfo[]
  /** Re-runs the last analysis. Omitted when there is nothing to re-run. */
  onRetry?: () => void
}

/** One item per submitted project. A failed project is shown, never dropped. */
export function ProjectStatusStrip({ repos, onRetry }: ProjectStatusStripProps) {
  if (repos.length === 0) {
    return <p className="text-sm text-muted-foreground">Project details are not available for this result.</p>
  }
  return (
    <ul className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 xl:grid-cols-3">
      {repos.map((repo) => (
        <li key={`${repo.origin}:${repo.name}`} className="flex flex-col gap-3 bg-background p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{repo.name || 'Unnamed project'}</h3>
            <Tag>{repo.origin === 'github' ? 'GitHub' : 'Pasted'}</Tag>
          </div>

          {(repo.ref || repo.commit) && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
              {repo.ref && (
                <span className="inline-flex items-center gap-1">
                  <GitBranch aria-hidden="true" className="size-3" />
                  <span className="sr-only">Branch </span>
                  {repo.ref}
                </span>
              )}
              {repo.commit && (
                <span className="inline-flex items-center gap-1">
                  <GitCommitHorizontal aria-hidden="true" className="size-3" />
                  <span className="sr-only">Commit </span>
                  {shortCommit(repo.commit)}
                </span>
              )}
            </p>
          )}

          <p className="text-sm text-muted-foreground">
            {repo.manifests.length > 0 ? (
              <>
                Manifests: <span className="font-mono text-xs text-foreground">{repo.manifests.join(', ')}</span>
              </>
            ) : (
              'No manifests read'
            )}
          </p>

          <StatusLine repo={repo} />

          <div className="mt-auto flex flex-wrap items-center gap-2">
            <Tag icon={<ScanSearch aria-hidden="true" />} tone={repo.code_scan === 'ran' ? 'success' : 'neutral'}>
              {repo.code_scan === 'ran' ? 'Code scan ran' : 'Code scan unavailable'}
            </Tag>
            {repo.status === 'error' && repo.origin === 'github' && onRetry && (
              <Button size="sm" onClick={onRetry} aria-label={`Retry analysis, ${repo.name} failed`}>
                <RotateCcw aria-hidden="true" />
                Retry analysis
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function SkippedList({ skipped }: { skipped: SkippedDependency[] }) {
  if (skipped.length === 0) return null
  return (
    <details className="group rounded-lg border border-border bg-card">
      <summary className="flex items-center justify-between gap-4 px-5 py-4 font-medium [&::-webkit-details-marker]:hidden">
        <span>
          Skipped <span className="font-mono text-sm tabular-nums text-muted-foreground">({skipped.length})</span>
        </span>
        <ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-border px-5 py-4">
        <p className="text-sm text-muted-foreground">These were not scored.</p>
        <ul className="mt-3 divide-y divide-border">
          {skipped.map((item) => (
            <li key={`${item.repo}:${item.library}:${item.raw_spec}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:gap-4">
              <span>
                <span className="font-medium">{item.library || 'Unknown library'}</span>
                <span className="block text-muted-foreground">in {item.repo || 'unknown project'}</span>
              </span>
              <span className="break-all font-mono text-xs text-muted-foreground">{item.raw_spec || 'No spec'}</span>
              <span className="text-muted-foreground">{item.reason || 'No reason given'}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}

/** Backend warnings: calm, dismissible, and one line until expanded. */
export function WarningsBanner({ warnings }: { warnings: string[] }) {
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const first = warnings[0]
  if (dismissed || first === undefined) return null
  const rest = warnings.slice(1)

  return (
    <Banner tone="warning" role="status" onDismiss={() => setDismissed(true)}>
      {rest.length === 0 || !expanded ? (
        <p>
          {first}
          {rest.length > 0 && (
            <>
              {' '}
              <button
                type="button"
                aria-expanded={false}
                onClick={() => setExpanded(true)}
                className="underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
              >
                and {plural(rest.length, 'more notice')}
              </button>
            </>
          )}
        </p>
      ) : (
        <>
          <ul className="list-disc space-y-1 pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <button
            type="button"
            aria-expanded
            onClick={() => setExpanded(false)}
            className="mt-2 underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
          >
            Show less
          </button>
        </>
      )}
    </Banner>
  )
}
