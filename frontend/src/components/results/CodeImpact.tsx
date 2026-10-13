import { FileCode, Link2 } from 'lucide-react'
import type { CodeImpactItem } from '../../api/scanTypes'
import { severityTone } from '../../lib/classify'
import { humanizeCode } from '../../lib/formatters'
import { ToneBadge } from '../common/Badges'
import { CodeBlock } from '../common/Evidence'

interface CodeImpactListProps {
  items: CodeImpactItem[]
  repoLabel: (name: string) => string
  /** Opens the dependency this call site is tied to, when it is in the results. */
  onOpenDependency?: (name: string) => void
}

/** Call sites the backend tied to a change. Every field shown comes from the backend. */
export function CodeImpactList({ items, repoLabel, onOpenDependency }: CodeImpactListProps) {
  return (
    <ul className="space-y-4">
      {items.map((item, index) => (
        <li key={`${item.repository}:${item.file}:${item.line ?? index}`} className="rounded-lg border border-border bg-card p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h3 className="font-medium">{item.repository ? repoLabel(item.repository) : 'Unknown repository'}</h3>
            <span className="inline-flex items-center gap-1.5 break-all font-mono text-xs text-muted-foreground">
              <FileCode aria-hidden="true" className="size-3.5 shrink-0" />
              {item.file || 'File not provided'}
              {item.line !== null && `:${item.line}`}
            </span>
            {item.confidence && (
              <ToneBadge
                label={`${humanizeCode(item.confidence)} confidence`}
                tone={severityTone(item.confidence)}
                prefix="Confidence"
              />
            )}
          </div>

          {item.snippet ? (
            <div className="mt-3">
              <CodeBlock code={item.snippet} label="Copy snippet" />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">No source snippet was provided for this location.</p>
          )}

          <dl className="mt-4 space-y-3 text-sm">
            <div>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Link2 aria-hidden="true" className="size-3.5" />
                Tied to this change
              </dt>
              <dd className="mt-0.5">
                {item.related_change || 'Not stated'}
                {item.dependency_name && onOpenDependency && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => onOpenDependency(item.dependency_name)}
                      className="underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
                    >
                      Open {item.dependency_name}
                    </button>
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Impact assessment</dt>
              <dd className="mt-0.5">{item.impact || 'Not provided'}</dd>
            </div>
            {item.limitations && (
              <div>
                <dt className="text-xs text-muted-foreground">Limitations stated by the backend</dt>
                <dd className="mt-0.5 text-muted-foreground">{item.limitations}</dd>
              </div>
            )}
          </dl>
        </li>
      ))}
    </ul>
  )
}

interface CodeImpactProps extends Omit<CodeImpactListProps, 'items'> {
  /** `null` when the backend returned no call-site analysis at all. */
  items: CodeImpactItem[] | null
}

export function CodeImpact({ items, ...rest }: CodeImpactProps) {
  if (items === null) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-8 text-muted-foreground">
        The backend did not return call-site analysis for this scan, so no source locations are shown. This
        section fills in when the backend provides the data.
      </p>
    )
  }
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-6 py-8 text-muted-foreground">
        Call-site analysis ran and reported no affected locations. It only finds what it can match in pushed
        source code.
      </p>
    )
  }
  return <CodeImpactList items={items} {...rest} />
}
