import { ArrowRight } from 'lucide-react'
import type { DependencyDrift } from '../../api/scanTypes'
import { isDrifted, riskMeta } from '../../lib/classify'
import { nextStepFor } from '../../lib/nextStep'
import { Banner } from '../common/Banner'
import { DriftBadge, RiskBadge } from '../common/Badges'
import { Button } from '../common/Button'
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

/** Release notes and recommendations for every drifted package, highest risk first. */
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
          const step = nextStepFor(row)
          return (
            <li key={row.id} className="rounded-lg border border-border bg-card p-5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="break-all font-display text-xl tracking-tight">{row.dependency_name}</h3>
                <EcosystemTag ecosystem={row.ecosystem} />
                <DriftBadge value={row.drift_disparity} />
                <RiskBadge value={row.compatibility_risk} />
              </div>
              <p className="mt-2 font-mono text-xs text-muted-foreground">{versionsLine(row, repoLabel)}</p>

              <div className="mt-4 grid gap-6 lg:grid-cols-2">
                <ReleaseEvidenceBody evidence={row.evidence} />
                <div className="space-y-4">
                  <div>
                    <p className="font-mono text-xs uppercase text-muted-foreground">Recommended version</p>
                    <p className="mt-1 font-mono text-sm">{row.recommended_version ?? 'Not provided by the backend'}</p>
                  </div>
                  {step && (
                    <div>
                      <p className="font-mono text-xs uppercase text-muted-foreground">Suggested next step</p>
                      <p className="mt-1 text-sm leading-relaxed">{step}</p>
                      <p className="mt-1 text-xs text-muted-foreground">Generated from rules, based on the classification above.</p>
                    </div>
                  )}
                  <Button size="sm" onClick={() => onOpen(row.id)}>
                    Open details
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
