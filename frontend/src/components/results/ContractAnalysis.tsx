import { ArrowRight } from 'lucide-react'
import type { ContractAnalysisEntry, ContractFinding } from '../../api/scanTypes'
import { contractMeta, severityTone } from '../../lib/classify'
import { humanizeCode, plural } from '../../lib/formatters'
import { ContractBadge, ToneBadge } from '../common/Badges'

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs">{value || 'Not provided'}</dd>
    </div>
  )
}

function Finding({ finding }: { finding: ContractFinding }) {
  return (
    <li className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{humanizeCode(finding.change_type) || 'Contract change'}</span>
        {finding.severity && (
          <ToneBadge label={humanizeCode(finding.severity)} tone={severityTone(finding.severity)} prefix="Severity" />
        )}
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-2 font-mono text-sm">
        {finding.method && <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-xs">{finding.method}</span>}
        <span className="break-all">{finding.path || 'Path not provided'}</span>
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <Value label="Previous" value={finding.previous_value} />
        <Value label="New" value={finding.new_value} />
        <Value label="Specification file" value={finding.spec_file} />
        <Value label="Evidence location (JSON pointer)" value={finding.json_pointer} />
      </dl>
      {finding.impact && <p className="mt-3 text-sm text-muted-foreground">Potential impact: {finding.impact}</p>}
    </li>
  )
}

function Entry({ entry, repoLabel }: { entry: ContractAnalysisEntry; repoLabel: (name: string) => string }) {
  const meta = contractMeta(entry.status)
  const analyzed = entry.status === 'ANALYZED'
  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
        <h3 className="flex flex-wrap items-center gap-2 font-medium">
          <span>{entry.provider_repo ? repoLabel(entry.provider_repo) : 'Unknown repository'}</span>
          {entry.consumer_repo && (
            <>
              <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="sr-only">consumed by</span>
              <span>{repoLabel(entry.consumer_repo)}</span>
            </>
          )}
        </h3>
        <ContractBadge value={entry.status} />
        {analyzed && (
          <span className="text-sm text-muted-foreground">{plural(entry.findings.length, 'finding')}</span>
        )}
        {entry.spec_file && <span className="font-mono text-xs text-muted-foreground">{entry.spec_file}</span>}
      </div>

      {!analyzed && (
        // An unchecked API is never presented as a compatible one.
        <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
          {entry.message || meta.description}
          {entry.message && ` ${meta.description}`}
        </p>
      )}
      {analyzed && (entry.message || entry.findings.length === 0) && (
        // The backend's message says which two specifications were compared and on what basis.
        <p className="border-t border-border px-5 py-4 text-sm text-muted-foreground">
          {entry.message || 'No contract changes were reported between the specifications that were compared.'}
        </p>
      )}
      {entry.findings.length > 0 && (
        <ul>
          {entry.findings.map((finding, index) => (
            <Finding key={`${finding.method}:${finding.path}:${finding.change_type}:${index}`} finding={finding} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface ContractAnalysisProps {
  /** `null` when the backend returned no contract analysis at all. */
  entries: ContractAnalysisEntry[] | null
  repoLabel: (name: string) => string
}

export function ContractAnalysis({ entries, repoLabel }: ContractAnalysisProps) {
  if (entries === null) {
    return (
      <p className="rounded-lg border border-dashed border-border px-6 py-8 text-muted-foreground">
        The backend did not return API contract analysis for this scan. Nothing was checked, so no conclusion
        about API compatibility can be drawn. This section fills in when the backend provides the data.
      </p>
    )
  }
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-6 py-8 text-muted-foreground">
        Contract analysis ran, but no repository pairs were reported.
      </p>
    )
  }
  return (
    <ul className="space-y-4">
      {entries.map((entry, index) => (
        <Entry key={`${entry.provider_repo}:${entry.consumer_repo}:${index}`} entry={entry} repoLabel={repoLabel} />
      ))}
    </ul>
  )
}
