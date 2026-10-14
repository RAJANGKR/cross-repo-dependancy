import { ArrowRight } from 'lucide-react'
import type { ContractAnalysisEntry, ContractCandidateRow, ContractFinding, ContractImpactRow, ContractReference } from '../../api/scanTypes'
import { changedFieldLabel, contractMeta, evidenceBadge, evidenceMeta, usageLabel } from '../../lib/classify'
import {
  candidateAction,
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

/** Places in a consumer's code, each with what the backend said about it. A place alone establishes nothing. */
function ReferenceList({ references, label }: { references: readonly ContractReference[]; label: string }) {
  return (
    <ul aria-label={label} className="space-y-3">
      {references.map((reference, index) => (
        <li key={`${reference.file}:${reference.line}:${index}`} className="min-w-0">
          <p className="break-all font-mono text-xs">
            {sourceLocation(reference.file, reference.line) || 'No location'}
            {reference.path && <span className="text-muted-foreground"> matches {reference.path}</span>}
            {reference.usage && <span className="text-muted-foreground"> · {usageLabel(reference.usage)}</span>}
          </p>
          {reference.snippet && <code className="mt-1 block break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs">{reference.snippet}</code>}
        </li>
      ))}
    </ul>
  )
}

interface ChangeRowProps {
  change: ChangeLike
  tier: string
  usage: string
  /** The consumer evidence for this change, when the row comes from a consumer. */
  impact?: ContractImpactRow
  /** The specification finding for this change, when the backend sent one. */
  finding?: ContractFinding
  /** Set when the row is a candidate: the consumer's relationship to the API is unverified. */
  candidate?: ContractCandidateRow
}

/**
 * One contract change in three short lines: the endpoint, what changed, and a
 * suggested action. Everything else the backend said about it (before and
 * after values, JSON pointer, source line, the full explanation) is in
 * "View evidence".
 */
function ChangeRow({ change, tier, usage, impact, finding, candidate }: ChangeRowProps) {
  const summary = summarizeChange(change)
  const field = changedFieldLabel(change.field ?? '', change.field_in ?? '')
  const located = impact ?? candidate
  const source = located ? sourceLocation(located.file, located.line) : sourceLocation(finding?.source_file, finding?.source_line)
  const level = evidenceMeta(tier).label
  // The badge already names the evidence when it reads the same as the level, and the finding's impact text
  // already contains the explanation when both exist. Neither is printed twice.
  const showLevel = Boolean(tier) && evidenceBadge(tier, usage).label !== level
  const explained = Boolean(located?.explanation && finding?.impact?.includes(located.explanation))
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
      {candidate && source && (
        <p className="mt-1 text-sm">
          <span className="text-muted-foreground">Possible reference: </span>
          <span className="break-all font-mono text-xs">{source}</span>
          {/* What the call was seen to do is an observation about that line, not a finding about this API. */}
          <span className="text-muted-foreground"> · seen at this call: {usageLabel(usage).toLowerCase()}</span>
        </p>
      )}
      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">Suggested action: </span>
        {candidate ? candidateAction(change, tier, usage) : suggestedAction(change, usage)}
      </p>

      <Disclosure label="View evidence" className="mt-2">
        {located?.explanation && !explained && <p className="text-sm text-muted-foreground">{located.explanation}</p>}
        {located?.snippet && <code className="mt-2 block break-all rounded-md bg-secondary px-3 py-2 font-mono text-xs">{located.snippet}</code>}
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <Value label="Change type" value={humanizeCode(change.change_type) || 'Contract change'} />
          {showLevel && <Value label="Evidence level" value={level} />}
          <Value label="Previous" value={change.previous_value} />
          <Value label="New" value={change.new_value} />
          {field && <Value label="Changed element" value={field} />}
          {candidate
            ? source && <Value label="Location in the code" value={source} />
            : (impact || source) && <Value label="Consumer source" value={source || 'No location'} />}
          {finding && <Value label="Specification file" value={finding.spec_file} />}
          {finding && <Value label="Evidence location (JSON pointer)" value={finding.json_pointer} />}
          {finding?.severity && <Value label="Severity" value={humanizeCode(finding.severity)} />}
        </dl>
        {finding?.impact && <p className="mt-3 text-sm text-muted-foreground">Potential impact: {finding.impact}</p>}
        {candidate && candidate.references.length > 0 && (
          <div className="mt-3">
            <p className="mb-2 text-xs text-muted-foreground">Calls matching this operation</p>
            <ReferenceList references={candidate.references} label="Calls matching this operation" />
          </div>
        )}
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
  const candidates = entry.candidate_impact ?? []
  const possible = entry.possible_references ?? []
  const signals = entry.candidate_evidence ?? []
  const dynamic = entry.dynamic_urls ?? []

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
          {signals.length > 0 && (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">Candidate signals. They suggest this repository may use the provider and tie no particular call to it.</p>
              <ul aria-label="Candidate signals" className="mt-1 space-y-1">
                {signals.map((item, index) => (
                  <li key={`${item.signal}:${index}`} className="break-all font-mono text-xs">
                    {item.signal}
                    {item.file && <span className="text-muted-foreground"> at {sourceLocation(item.file, item.line)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Disclosure>
        {possible.length > 0 && (
          <Disclosure label={`View possible references (${possible.length})`} className="mt-1">
            <p className="mb-3 text-sm text-muted-foreground">
              Strings in this repository that match a path of the API. Nothing ties them to it, so they are not counted as usage. At most ten are listed.
            </p>
            <ReferenceList references={possible} label="Possible references" />
          </Disclosure>
        )}
        {dynamic.length > 0 && (
          <Disclosure label={`View requests built at runtime (${dynamic.length})`} className="mt-1">
            <p className="mb-3 text-sm text-muted-foreground">
              These requests take their path from a value that is only known at runtime, so no operation could be matched or excluded.
            </p>
            <ReferenceList references={dynamic} label="Requests built at runtime" />
          </Disclosure>
        )}
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
      {candidates.length > 0 && (
        <>
          <ul aria-label="Possible references to contract changes">
            {candidates.map((row, index) => (
              <ChangeRow
                key={`candidate:${row.method}:${row.path}:${row.field}:${row.change_type}:${index}`}
                change={row}
                tier={row.evidence_tier}
                usage={row.usage}
                candidate={row}
              />
            ))}
          </ul>
          <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
            Possible references per contract change, from this repository&apos;s source code. Nothing ties these calls to
            this API, so they are candidates: none is counted as usage, and &quot;No usage found&quot; is not proof that
            the repository is unaffected.
          </p>
        </>
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
