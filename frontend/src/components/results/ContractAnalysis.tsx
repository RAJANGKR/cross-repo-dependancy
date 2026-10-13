import { ArrowRight } from 'lucide-react'
import type { ContractAnalysisEntry, ContractFinding, ContractImpactRow } from '../../api/scanTypes'
import { changedFieldLabel, contractMeta, evidenceBadge, evidenceMeta } from '../../lib/classify'
import {
  entryHeadline,
  entryRank,
  findingFor,
  sectionSummary,
  suggestedAction,
  summarizeChange,
  type ChangeLike,
} from '../../lib/contractSummary'
import { humanizeCode, plural } from '../../lib/formatters'
import { ContractBadge, ToneBadge } from '../common/Badges'
import { Disclosure } from '../common/Disclosure'

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs">{value || 'Not provided'}</dd>
    </div>
  )
}

/** `src/api.js:12`, or '' when the backend gave no source location. */
function sourceLocation(file: string | undefined, line: number | null | undefined): string {
  if (!file) return ''
  return line === null || line === undefined ? file : `${file}:${line}`
}

/** What the consumer code was seen to do, with the tone that finding deserves. */
function EvidenceBadge({ tier, usage }: { tier: string; usage: string }) {
  const meta = evidenceBadge(tier, usage)
  return <ToneBadge label={meta.label} tone={meta.tone} prefix="Evidence" />
}

interface ChangeRowProps {
  change: ChangeLike
  tier: string
  usage: string
  /** The consumer evidence for this change, when the row comes from a consumer. */
  impact?: ContractImpactRow
  /** The specification finding for this change, when the backend sent one. */
  finding?: ContractFinding
}

/**
 * One contract change in three short lines: the endpoint, what changed, and a
 * suggested action. Everything else the backend said about it (before and
 * after values, JSON pointer, source line, the full explanation) is in
 * "View evidence".
 */
function ChangeRow({ change, tier, usage, impact, finding }: ChangeRowProps) {
  const summary = summarizeChange(change)
  const field = changedFieldLabel(change.field ?? '', change.field_in ?? '')
  const source = impact ? sourceLocation(impact.file, impact.line) : sourceLocation(finding?.source_file, finding?.source_line)
  const level = evidenceMeta(tier).label
  // The badge already names the evidence when it reads the same as the level, and the finding's impact text
  // already contains the explanation when both exist. Neither is printed twice.
  const showLevel = Boolean(tier) && evidenceBadge(tier, usage).label !== level
  const explained = Boolean(impact?.explanation && finding?.impact?.includes(impact.explanation))
  return (
    <li className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 break-all font-mono text-sm">
          {change.method && (
            <>
              <span className="mr-1 rounded-sm bg-secondary px-1.5 py-0.5 text-xs">{change.method}</span>{' '}
            </>
          )}
          {change.path || 'Path not provided'}
        </p>
        {tier && <EvidenceBadge tier={tier} usage={usage} />}
      </div>
      <p className="mt-2 text-sm">
        {summary.subject && <code className="mr-1 break-all rounded-sm bg-secondary px-1 py-0.5 font-mono text-xs">{summary.subject}</code>}
        {summary.change}
        {summary.location && <span className="text-muted-foreground"> ({summary.location})</span>}
      </p>
      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">Suggested action: </span>
        {suggestedAction(change, usage)}
      </p>

      <Disclosure label="View evidence" className="mt-2">
        {impact?.explanation && !explained && <p className="text-sm text-muted-foreground">{impact.explanation}</p>}
        {impact?.snippet && <code className="mt-2 block break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs">{impact.snippet}</code>}
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Value label="Change type" value={humanizeCode(change.change_type) || 'Contract change'} />
          {showLevel && <Value label="Evidence level" value={level} />}
          <Value label="Previous" value={change.previous_value} />
          <Value label="New" value={change.new_value} />
          {field && <Value label="Changed element" value={field} />}
          {(impact || source) && <Value label="Consumer source" value={source || 'No location'} />}
          {finding && <Value label="Specification file" value={finding.spec_file} />}
          {finding && <Value label="Evidence location (JSON pointer)" value={finding.json_pointer} />}
          {finding?.severity && <Value label="Severity" value={humanizeCode(finding.severity)} />}
        </dl>
        {finding?.impact && <p className="mt-3 text-sm text-muted-foreground">Potential impact: {finding.impact}</p>}
      </Disclosure>
    </li>
  )
}

function Entry({ entry, repoLabel }: { entry: ContractAnalysisEntry; repoLabel: (name: string) => string }) {
  const meta = contractMeta(entry.status)
  const analyzed = entry.status === 'ANALYZED'
  const headline = entryHeadline(entry)
  const impact = entry.consumer_impact ?? []
  // A consumer's rows cover every change of the comparison. Without them (a specification entry, or an
  // older record) the findings are the rows.
  const fromImpact = impact.length > 0
  // Findings that no row describes are still shown, so nothing the backend sent is dropped.
  const unmatched = fromImpact ? entry.findings.filter((finding) => !impact.some((row) => findingFor(row, [finding]))) : []

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h3 className="flex flex-wrap items-center gap-2 font-medium">
            <span className="break-all">{entry.provider_repo ? repoLabel(entry.provider_repo) : 'Unknown repository'}</span>
            {entry.consumer_repo && (
              <>
                <ArrowRight aria-hidden="true" className="size-4 text-muted-foreground" />
                <span className="sr-only">consumed by</span>
                <span className="break-all">{repoLabel(entry.consumer_repo)}</span>
              </>
            )}
          </h3>
          <ContractBadge value={entry.status} />
          {analyzed && <span className="text-sm text-muted-foreground">{plural(entry.findings.length, 'finding')}</span>}
        </div>
        {headline.action && <p className="mt-3 text-sm font-medium">{headline.action}</p>}
        <p className={headline.action ? 'mt-1 text-sm text-muted-foreground' : 'mt-3 text-sm text-muted-foreground'}>{headline.why}</p>

        <Disclosure label="How this was determined" className="mt-2">
          <p className="text-sm text-muted-foreground">
            {entry.message || meta.description}
            {/* An unchecked API is never presented as a compatible one. */}
            {entry.message && !analyzed && ` ${meta.description}`}
          </p>
          {entry.spec_file && (
            <p className="mt-2 break-all font-mono text-xs text-muted-foreground">Specification file: {entry.spec_file}</p>
          )}
        </Disclosure>
      </div>

      {(fromImpact || entry.findings.length > 0) && (
        <ul aria-label="Contract changes">
          {fromImpact
            ? impact.map((row, index) => (
                <ChangeRow
                  key={`${row.method}:${row.path}:${row.field}:${row.change_type}:${index}`}
                  change={row}
                  tier={row.evidence_tier}
                  usage={row.usage}
                  impact={row}
                  finding={findingFor(row, entry.findings)}
                />
              ))
            : entry.findings.map((finding, index) => (
                <ChangeRow
                  key={`${finding.method}:${finding.path}:${finding.change_type}:${index}`}
                  change={finding}
                  tier={finding.evidence_tier ?? ''}
                  usage={finding.usage ?? ''}
                  finding={finding}
                />
              ))}
          {unmatched.map((finding, index) => (
            <ChangeRow
              key={`unmatched:${finding.method}:${finding.path}:${finding.change_type}:${index}`}
              change={finding}
              tier={finding.evidence_tier ?? ''}
              usage={finding.usage ?? ''}
              finding={finding}
            />
          ))}
        </ul>
      )}
      {fromImpact && (
        <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          Evidence per contract change, from this repository&apos;s source code. Static analysis only: no row is a
          confirmed runtime failure, and &quot;No usage found&quot; is not proof that the consumer is unaffected.
        </p>
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
  // What needs attention first. The sort is stable, so entries of equal rank keep the backend's order.
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => entryRank(a.entry) - entryRank(b.entry) || a.index - b.index)
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {sectionSummary(entries)}{' '}
        <span className="text-muted-foreground">Suggested actions are generated from rules, based on the change and the evidence shown.</span>
      </p>
      <ul className="space-y-4">
        {ordered.map(({ entry, index }) => (
          <Entry key={`${entry.provider_repo}:${entry.consumer_repo}:${index}`} entry={entry} repoLabel={repoLabel} />
        ))}
      </ul>
    </div>
  )
}
