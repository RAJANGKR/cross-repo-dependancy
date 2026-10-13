import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { CodeImpactItem, DependencyDrift } from '../../api/scanTypes'
import { driftMeta, riskMeta } from '../../lib/classify'
import { cx } from '../../lib/cx'
import { dependencySummaryText } from '../../lib/exportMarkdown'
import { nextStepFor, registryUrl } from '../../lib/nextStep'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { CopyButton } from '../common/CopyButton'
import { Dialog } from '../common/Dialog'
import { ReleaseEvidenceBody } from '../common/Evidence'
import { EcosystemTag } from '../common/Tags'
import { CodeImpactList } from '../results/CodeImpact'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border py-6 first:border-t-0 first:pt-0">
      <h3 className="font-mono text-xs uppercase text-muted-foreground">{title}</h3>
      <div className="mt-3">{children}</div>
    </section>
  )
}

const NAV_BUTTON =
  'rounded-full p-2 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent'

interface DetailPanelProps {
  row: DependencyDrift
  /** All repository names in the scan, so missing ones are listed too. */
  repos: readonly string[]
  repoLabel: (name: string) => string
  /** Call sites for the whole scan, or null when the backend sent none. */
  codeImpact: CodeImpactItem[] | null
  /** Position in the currently filtered list; null when the row is filtered out. */
  position: { index: number; total: number } | null
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
}

export function DetailPanel({ row, repos, repoLabel, codeImpact, position, onPrevious, onNext, onClose }: DetailPanelProps) {
  const titleId = useId()
  const drift = driftMeta(row.drift_disparity)
  const risk = riskMeta(row.compatibility_risk)
  const step = nextStepFor(row)
  const registry = registryUrl(row)
  const related = codeImpact?.filter((item) => item.dependency_name === row.dependency_name) ?? null
  const names = [...new Set([...repos, ...Object.keys(row.declarations_by_repo), ...row.missing_in_repos])]

  return (
    <Dialog
      variant="side"
      labelledBy={titleId}
      onClose={onClose}
      header={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <EcosystemTag ecosystem={row.ecosystem} />
            {position && (
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {position.index + 1} of {position.total}
              </span>
            )}
          </div>
          <h2 id={titleId} className="mt-2 break-all font-display text-3xl tracking-tight">
            {row.dependency_name}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <DriftBadge value={row.drift_disparity} />
            <RiskBadge value={row.compatibility_risk} />
          </div>
        </>
      }
      toolbar={
        <>
          <button
            type="button"
            onClick={onPrevious}
            disabled={!position || position.index === 0}
            aria-label="Previous package"
            className={NAV_BUTTON}
          >
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <button
            type="button"
            onClick={onNext}
            disabled={!position || position.index >= position.total - 1}
            aria-label="Next package"
            className={NAV_BUTTON}
          >
            <ChevronRight aria-hidden="true" className="size-5" />
          </button>
        </>
      }
      footer={
        <>
          <CopyButton text={() => dependencySummaryText(row)} label="Copy summary" variant="secondary" size="md" />
          {registry && (
            <a
              href={registry.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center gap-2 rounded-full border border-foreground/20 bg-card px-5 text-sm font-medium transition-colors hover:border-foreground hover:bg-foreground/5"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              {registry.label}
            </a>
          )}
        </>
      }
    >
      <Section title="What these classifications mean">
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="font-medium">Drift: {drift.label}</dt>
            <dd className="mt-0.5 text-muted-foreground">{drift.description}</dd>
          </div>
          <div>
            <dt className="font-medium">Compatibility risk: {risk.label}</dt>
            <dd className="mt-0.5 text-muted-foreground">{risk.description}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Versions by repository">
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[32rem] border-collapse text-sm">
            <thead>
              <tr className="text-left font-mono text-xs uppercase text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-normal">Repository</th>
                <th scope="col" className="px-3 py-2 font-normal">Declared range</th>
                <th scope="col" className="px-3 py-2 font-normal">Resolved version</th>
                <th scope="col" className="px-3 py-2 font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {names.map((name) => {
                const declaration = row.declarations_by_repo[name]
                const label = repoLabel(name)
                return (
                  <tr key={name} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2.5 text-left font-medium">
                      {label}
                      {label !== name && <span className="block font-mono text-xs font-normal text-muted-foreground">{name}</span>}
                    </th>
                    {declaration ? (
                      <>
                        <td className="break-all px-3 py-2.5 font-mono text-xs">{declaration.declared_range || 'Not provided'}</td>
                        <td className={cx('break-all px-3 py-2.5', declaration.resolved_version ? 'font-mono text-xs tabular-nums' : 'text-muted-foreground')}>
                          {declaration.resolved_version ?? 'Not resolved, no lockfile entry'}
                        </td>
                        <td className="break-all px-3 py-2.5 text-xs text-muted-foreground">
                          {declaration.source_file || 'Not provided'}
                          {declaration.dep_type && <span className="block">{declaration.dep_type} dependency</span>}
                        </td>
                      </>
                    ) : (
                      <td colSpan={3} className="px-3 py-2.5 text-muted-foreground">
                        Not declared in this repository
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Declared range is what the manifest allows. Resolved version is what the lockfile actually pins.
        </p>
      </Section>

      <Section title="Recommended version">
        {row.recommended_version ? (
          <p className="font-mono text-sm">{row.recommended_version}</p>
        ) : (
          <p className="text-sm text-muted-foreground">The backend did not recommend a version for this package.</p>
        )}
      </Section>

      <Section title="Release evidence">
        <ReleaseEvidenceBody evidence={row.evidence} />
      </Section>

      {related !== null && (
        <Section title={`Code impact (${related.length})`}>
          {related.length === 0 ? (
            <p className="text-sm text-muted-foreground">No call sites were reported for this package.</p>
          ) : (
            <CodeImpactList items={related} repoLabel={repoLabel} />
          )}
        </Section>
      )}

      {step && (
        <Section title="Suggested next step">
          <p className="leading-relaxed">{step}</p>
          <p className="mt-2 text-xs text-muted-foreground">Generated from rules, based on the classifications above.</p>
        </Section>
      )}
    </Dialog>
  )
}
