import { ArrowRight, CircleHelp } from 'lucide-react'
import type { DependencyDrift } from '../../api/scanTypes'
import { isDrifted, riskMeta } from '../../lib/classify'
import { conciseStepFor, EVIDENCE_UNAVAILABLE, nextStepFor } from '../../lib/nextStep'
import { Banner } from '../common/Banner'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { Button } from '../common/Button'
import { Disclosure } from '../common/Disclosure'
import { ReleaseEvidenceBody } from '../common/Evidence'
import { EcosystemTag } from '../common/Tags'

function versionsLine(row: DependencyDrift, repoLabel: (name: string) => string): string {
  return Object.entries(row.declarations_by_repo)
    .map(([repo, declaration]) => `${repoLabel(repo)} ${declaration.resolved_version ?? declaration.declared_range}`)
    .join('  ·  ')
}

interface ReleaseEvidenceProps {
  rows: readonly DependencyDrift[]
  warnings: readonly string[]
  repoLabel: (name: string) => string
  onOpen: (id: string) => void
}

/**
 * One card per drifted package, highest risk first: what to do next, why, and
 * the recommended version. Release notes, versions per repository and the
 * longer explanation are one click away in "View release evidence".
 */
export function ReleaseEvidence({ rows, warnings, repoLabel, onOpen }: ReleaseEvidenceProps) {
  const drifted = rows
    .filter((row) => isDrifted(row.drift_disparity))
    .sort((a, b) => riskMeta(b.compatibility_risk).rank - riskMeta(a.compatibility_risk).rank)
  const aiWarnings = warnings.filter((warning) => /gemini|llm|\bai\b/i.test(warning))

  if (drifted.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-6 py-8 text-muted-foreground">
        No package differs between repositories, so there are no release notes to compare.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {aiWarnings.length > 0 && (
        <Banner tone="warning" role="status" title="AI interpretation was not available for every package">
          The deterministic results below are unaffected. {aiWarnings.join(' ')}
        </Banner>
      )}
      <ul className="space-y-4">
        {drifted.map((row) => {
          const step = conciseStepFor(row)
          const fullStep = nextStepFor(row)
          return (
            <li key={row.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="break-all font-display text-xl tracking-tight">{row.dependency_name}</h3>
                <EcosystemTag ecosystem={row.ecosystem} />
                <RiskBadge value={row.compatibility_risk} />
                <DriftBadge value={row.drift_disparity} />
                <Button size="sm" className="ml-auto" onClick={() => onOpen(row.id)}>
                  Open details
                  <ArrowRight aria-hidden="true" />
                </Button>
              </div>

              <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9.5rem_1fr]">
                {step && (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted-foreground sm:pt-0.5">Next action</dt>
                    <dd className="font-medium">{step.action}</dd>
                    <dt className="font-mono text-xs uppercase text-muted-foreground sm:pt-0.5">Why</dt>
                    <dd>
                      {step.reason}
                      {step.evidenceUnavailable && (
                        // Neutral on purpose: missing evidence is neither a finding nor an all-clear.
                        <span className={step.reason ? 'mt-1 flex items-center gap-1.5 text-muted-foreground' : 'flex items-center gap-1.5 text-muted-foreground'}>
                          <CircleHelp aria-hidden="true" className="size-3.5 shrink-0" />
                          {EVIDENCE_UNAVAILABLE}
                        </span>
                      )}
                    </dd>
                  </>
                )}
                {row.recommended_version && (
                  <>
                    <dt className="font-mono text-xs uppercase text-muted-foreground sm:pt-0.5">Recommended version</dt>
                    <dd className="break-all font-mono">{row.recommended_version}</dd>
                  </>
                )}
              </dl>

              <Disclosure label="View release evidence" className="mt-3">
                <div className="space-y-4">
                  <div>
                    <p className="font-mono text-xs uppercase text-muted-foreground">Versions in use</p>
                    <p className="mt-1 break-all font-mono text-xs">{versionsLine(row, repoLabel)}</p>
                  </div>
                  <ReleaseEvidenceBody evidence={row.evidence} concise />
                  {fullStep && (
                    <div>
                      <p className="font-mono text-xs uppercase text-muted-foreground">Suggested next step in full</p>
                      <p className="mt-1 text-sm leading-relaxed">{fullStep}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Generated from rules, based on the classification above.</p>
                    </div>
                  )}
                </div>
              </Disclosure>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
