import type { ContractAnalysisEntry, ContractFinding, ContractImpactRow } from '../api/scanTypes'
import { contractMeta } from './classify'
import { humanizeCode, plural } from './formatters'

/**
 * One-line summaries of contract changes: endpoint, what changed, and a
 * suggested next action. Nothing here adds a fact. Every sentence is derived
 * from fields the backend returned (change type, field, before and after
 * values, the consumer evidence) and the suggested actions are fixed rules per
 * change type or usage, shown in the UI as suggestions.
 */

/** The fields of a contract change that a summary needs. Findings and consumer rows both have them. */
export interface ChangeLike {
  change_type: string
  method: string
  path: string
  field?: string
  field_in?: string
  previous_value: string
  new_value: string
}

export interface ChangeSummary {
  /** "GET /pets" */
  endpoint: string
  /** The element that changed, for example "status". Empty when the change is about the whole operation. */
  subject: string
  /** "changed from optional to required" */
  change: string
  /** Where the element lives, for example "query parameter". Empty when it does not apply. */
  location: string
}

const LOCATIONS: Record<string, string> = {
  query: 'query parameter',
  header: 'header',
  cookie: 'cookie',
  formData: 'form field',
  request_body: 'request field',
  response_body: 'response field',
}

/** The value after the last ": " of a before or after text: "query parameter status: optional" gives "optional". */
function lastValue(text: string): string {
  const at = text.lastIndexOf(': ')
  return at === -1 ? '' : text.slice(at + 2).trim()
}

/** "data.[].id" gives "data.id": array markers are not part of a field name a reader would recognize. */
export function fieldName(field: string | undefined): string {
  return (field ?? '')
    .split('.')
    .filter((part) => part && part !== '[]')
    .join('.')
}

export function endpointOf(change: Pick<ChangeLike, 'method' | 'path'>): string {
  return [change.method, change.path || 'Path not provided'].filter(Boolean).join(' ')
}

/** What changed, in a few words. An unknown change type is shown as the backend named it. */
export function summarizeChange(change: ChangeLike): ChangeSummary {
  const endpoint = endpointOf(change)
  const subject = fieldName(change.field)
  const location = LOCATIONS[change.field_in ?? ''] ?? ''
  const before = lastValue(change.previous_value)
  const after = lastValue(change.new_value)

  switch (change.change_type) {
    case 'NEW_REQUIRED_REQUEST_FIELD':
      if (!subject) {
        return { endpoint, subject: '', location: '', change: before === 'optional' ? 'the request body changed from optional to required' : 'a request body is now required' }
      }
      return {
        endpoint,
        subject,
        location,
        change: before === 'optional' ? 'changed from optional to required' : before === 'absent' ? 'is new and required' : 'is now required',
      }
    case 'REMOVED_OPERATION':
      return { endpoint, subject: '', location: '', change: 'operation removed' }
    case 'REMOVED_PATH':
      return { endpoint, subject: '', location: '', change: before ? `path removed (${before})` : 'path removed' }
    case 'CHANGED_RESPONSE_FIELD_TYPE':
      return {
        endpoint,
        subject: subject || 'response body',
        location: subject ? LOCATIONS.response_body ?? '' : '',
        change: before && after ? `changed type from ${before} to ${after}` : 'changed type',
      }
    default: {
      const named = humanizeCode(change.change_type) || 'Contract change'
      const values = change.previous_value && change.new_value ? `: ${change.previous_value} to ${change.new_value}` : ''
      return { endpoint, subject, location, change: `${named}${values.length <= 90 ? values : ''}` }
    }
  }
}

/** The whole summary as one sentence, for exports and accessible names. */
export function changeSentence(change: ChangeLike): string {
  const summary = summarizeChange(change)
  return [summary.subject, summary.change].filter(Boolean).join(' ')
}

/**
 * A suggested next step for one change. With a `usage` it speaks about what the
 * consumer code was seen to do; without one it speaks about consumers in
 * general. Unknown and no-usage results stay explicit: they never suggest that
 * nothing needs doing.
 */
export function suggestedAction(change: ChangeLike, usage = ''): string {
  const subject = fieldName(change.field)
  const value = subject || 'a request body'
  switch (usage) {
    case 'READS_CHANGED_FIELD':
      return 'Check that this code handles the new type before the provider is upgraded.'
    case 'OMITS_REQUIRED_FIELD':
      return `Send ${value} in this request before the provider is upgraded.`
    case 'MAY_SEND_REQUIRED_FIELD':
      return `Make sure ${value} is sent on every path before the provider is upgraded.`
    case 'CALLS_OPERATION':
      return 'Stop calling this operation before the provider is upgraded.'
    case 'FIELD_NOT_READ':
      return 'Confirm that this consumer does not use the changed field. A call alone does not show it.'
    case 'NOT_DETERMINED':
      return 'Review this call manually. The analysis could not follow it.'
    case 'SENDS_REQUIRED_FIELD':
      return 'No change needed for this request. It already sends the value.'
    case 'NO_USAGE_FOUND':
      return 'Confirm manually. No call was found, which is not proof that this consumer is unaffected.'
  }
  switch (change.change_type) {
    case 'NEW_REQUIRED_REQUEST_FIELD':
      return `Verify that consumers send ${value} before upgrading.`
    case 'REMOVED_OPERATION':
    case 'REMOVED_PATH':
      return 'Verify that no consumer still calls it before upgrading.'
    case 'CHANGED_RESPONSE_FIELD_TYPE':
      return `Verify that consumers handle the new type of ${subject || 'the response body'} before upgrading.`
    default:
      return 'Review this change with the consumers of this API before upgrading.'
  }
}

/** Usages where source code shows the change reaches the consumer. */
const NEEDS_ATTENTION = new Set(['READS_CHANGED_FIELD', 'OMITS_REQUIRED_FIELD', 'CALLS_OPERATION'])
/** Usages where the analysis found the call but could not settle the question. */
const NOT_SETTLED = new Set(['MAY_SEND_REQUIRED_FIELD', 'FIELD_NOT_READ', 'NOT_DETERMINED'])

export interface UsageCounts {
  total: number
  attention: number
  notSettled: number
  noUsage: number
  satisfied: number
}

export function usageCounts(rows: readonly Pick<ContractImpactRow, 'usage'>[]): UsageCounts {
  const count = (test: (usage: string) => boolean) => rows.filter((row) => test(row.usage)).length
  return {
    total: rows.length,
    attention: count((usage) => NEEDS_ATTENTION.has(usage)),
    notSettled: count((usage) => NOT_SETTLED.has(usage)),
    noUsage: count((usage) => usage === 'NO_USAGE_FOUND'),
    satisfied: count((usage) => usage === 'SENDS_REQUIRED_FIELD'),
  }
}

export interface Headline {
  /** One suggested next step, or null when the status calls for none. */
  action: string | null
  /** One short reason. */
  why: string
}

/** The one thing to do about one contract-analysis entry, and why. */
export function entryHeadline(entry: ContractAnalysisEntry): Headline {
  const meta = contractMeta(entry.status)
  switch (entry.status) {
    case 'ANALYZED':
      break
    case 'RELATIONSHIP_UNVERIFIED':
      return { action: 'Confirm manually whether this repository calls the API.', why: 'Its relationship to the provider could not be verified, so nothing was concluded.' }
    case 'UNRESOLVED':
      return { action: 'Review this consumer manually before upgrading the provider.', why: 'Its request URLs are built at runtime, so no operation could be matched or excluded.' }
    case 'NOT_COMPARED':
      return { action: 'Add another version of this API to the scan to compare it.', why: meta.description }
    case 'MALFORMED_SPEC':
      return { action: 'Fix the specification file so that it can be parsed.', why: meta.description }
    default:
      // No specification, or a status this dashboard does not know: say what it means and suggest nothing.
      return { action: null, why: meta.description }
  }

  if (!entry.consumer_repo) {
    const found = entry.findings.length
    if (found === 0) {
      return { action: 'No action needed for the changes that are checked.', why: 'No removed operation, newly required value or changed response type was detected.' }
    }
    return { action: 'Verify consumers before upgrading to the newer version.', why: `${plural(found, 'potentially breaking change')} detected between the two specification versions.` }
  }

  const rows = entry.consumer_impact ?? []
  if (rows.length === 0) {
    // A record from before evidence rows existed: only the findings say what is affected.
    const found = entry.findings.length
    return found > 0
      ? { action: 'Review the affected calls in this consumer before upgrading the provider.', why: `${plural(found, 'change')} touch endpoints it references.` }
      : { action: 'Confirm manually whether this consumer uses the changed operations.', why: 'No affected call was found, which is not proof that it is unaffected.' }
  }
  const counts = usageCounts(rows)
  if (counts.attention > 0) {
    return {
      action: `Review ${plural(counts.attention, 'affected call')} in this consumer before upgrading the provider.`,
      why: `Its source code uses ${counts.attention} of the ${plural(counts.total, 'changed element')}.`,
    }
  }
  if (counts.notSettled > 0) {
    return {
      action: 'Review this consumer manually before upgrading the provider.',
      why: `${counts.notSettled} of ${plural(counts.total, 'change')} could not be settled from its source code.`,
    }
  }
  if (counts.noUsage > 0) {
    return { action: 'Confirm manually whether this consumer uses the changed operations.', why: 'No call to them was found, which is not proof that it is unaffected.' }
  }
  return { action: 'No change needed for the requests that were found.', why: 'They already send the newly required values.' }
}

/** Entries that need attention come first; repositories with nothing to compare come last. */
export function entryRank(entry: ContractAnalysisEntry): number {
  if (entry.status === 'ANALYZED' && !entry.consumer_repo) return entry.findings.length > 0 ? 0 : 5
  if (entry.status === 'ANALYZED') {
    const counts = usageCounts(entry.consumer_impact ?? [])
    return counts.attention > 0 || (counts.total === 0 && entry.findings.length > 0) ? 1 : counts.notSettled > 0 ? 2 : 4
  }
  return { UNRESOLVED: 2, RELATIONSHIP_UNVERIFIED: 3, MALFORMED_SPEC: 6, NOT_COMPARED: 7, SPEC_UNAVAILABLE: 8 }[entry.status] ?? 6
}

/** One sentence for the whole section: how much changed and how many consumers need a look. */
export function sectionSummary(entries: readonly ContractAnalysisEntry[]): string {
  const compared = entries.filter((entry) => entry.status === 'ANALYZED' && !entry.consumer_repo)
  const consumers = entries.filter((entry) => entry.consumer_repo)
  if (compared.length === 0) {
    // A record that reports no comparison of its own can still carry analyzed consumers, and those were compared.
    const analyzed = consumers.filter((entry) => entry.status === 'ANALYZED')
    if (analyzed.length === 0) return 'No two versions of the same API were found in this scan, so no contract was compared.'
    const pending = analyzed.filter((entry) => entryRank(entry) === 1).length
    return `Contract changes were analyzed for ${plural(analyzed.length, 'provider and consumer pair')}; ${pending} ${pending === 1 ? 'needs' : 'need'} review.`
  }
  const changes = compared.reduce((sum, entry) => sum + entry.findings.length, 0)
  const review = consumers.filter((entry) => entry.status === 'ANALYZED' && entryRank(entry) === 1).length
  const unknown = consumers.filter((entry) => entry.status !== 'ANALYZED' || entryRank(entry) === 2).length
  const head = `${plural(changes, 'potentially breaking change')} found in ${plural(compared.length, 'API comparison')}.`
  if (consumers.length === 0) return head
  return `${head} Of ${plural(consumers.length, 'other repository', 'other repositories')}, ${review} ${review === 1 ? 'needs' : 'need'} review and ${unknown} could not be settled.`
}

/** The finding that describes the same change as a consumer row, when the backend sent one. */
export function findingFor(row: ChangeLike, findings: readonly ContractFinding[]): ContractFinding | undefined {
  return findings.find(
    (finding) => finding.change_type === row.change_type && finding.method === row.method && finding.path === row.path && (finding.field ?? '') === (row.field ?? ''),
  )
}
