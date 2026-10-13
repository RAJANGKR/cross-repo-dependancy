import type { RolloutContractChange, RolloutEvidence, RolloutState } from '../api/rolloutClient'
import { endpointOf, fieldName, summarizeChange, type ChangeSummary } from './contractSummary'
import { plural } from './formatters'

/**
 * Short, plain-language lines for the rollout planner. They restate what the
 * backend returned (a state's status and its evidence, a contract change and
 * its direction). The backend's own full wording stays available under
 * "View evidence".
 */

function describeBreak(item: RolloutEvidence): string {
  const endpoint = endpointOf(item)
  if (item.usage === 'OMITS_REQUIRED_FIELD') {
    return `The consumer does not send the required ${fieldName(item.field) || 'request body'} on ${endpoint}.`
  }
  if (item.usage === 'CALLS_OPERATION') {
    return `The consumer calls ${endpoint}, which the provider does not have in this state.`
  }
  return `A detected change on ${endpoint} breaks the consumer.`
}

/** One sentence that says why a state has its status. An unknown status falls back to the backend's reason. */
export function conciseReason(state: RolloutState): string {
  const total = state.evidence.length
  if (state.status === 'COMPATIBLE') {
    return total === 0 ? 'No detected contract change affects this order.' : `The consumer already satisfies ${total === 1 ? 'the one detected change' : `all ${total} detected changes`}.`
  }
  if (state.status === 'INCOMPATIBLE') {
    const broken = state.evidence.filter((item) => item.verdict === 'INCOMPATIBLE')
    const first = broken[0]
    if (!first) return 'A detected change breaks the consumer.'
    return broken.length > 1 ? `${describeBreak(first)} ${plural(broken.length - 1, 'more problem')} in the evidence.` : describeBreak(first)
  }
  if (state.status === 'UNKNOWN') {
    if (total === 0) return 'This order could not be evaluated.'
    const unknown = state.evidence.filter((item) => item.verdict === 'UNKNOWN').length
    return `The effect of ${unknown} of ${plural(total, 'detected change')} on the consumer is not known.`
  }
  return state.reason
}

export interface RolloutChangeLine extends ChangeSummary {
  /** Which rollout order this change matters for, in plain words. */
  matters: string
}

/**
 * The detected contract changes as one line each, always described from P0 to
 * P1. The backend reports what P1 offers that P0 lacks by comparing in the
 * other direction, so those entries are reworded ("added in P1"). A response
 * type change seen in both directions is listed once.
 */
export function rolloutChangeLines(changes: readonly RolloutContractChange[]): RolloutChangeLine[] {
  const key = (change: RolloutContractChange) => `${change.change_type}|${change.method}|${change.path}|${change.field}`
  const forward = changes.filter((change) => change.direction !== 'P1_TO_P0')
  const reverse = changes.filter((change) => change.direction === 'P1_TO_P0')
  const both = new Set(reverse.filter((change) => change.change_type === 'CHANGED_RESPONSE_FIELD_TYPE').map(key).filter((value) => forward.some((change) => key(change) === value)))

  const lines: RolloutChangeLine[] = forward.map((change) => ({
    ...summarizeChange(change),
    matters: both.has(key(change)) ? 'Matters in both orders' : 'Matters if the provider goes first',
  }))
  for (const change of reverse) {
    if (both.has(key(change))) continue
    const summary = summarizeChange(change)
    const last = (text: string) => text.slice(text.lastIndexOf(': ') + 2)
    let what = `${summary.change} (seen from P1 back to P0)`
    if (change.change_type === 'REMOVED_OPERATION') what = 'operation added in P1'
    else if (change.change_type === 'REMOVED_PATH') what = summary.change.replace('path removed', 'path added in P1')
    else if (change.change_type === 'NEW_REQUIRED_REQUEST_FIELD') what = 'is required in P0 but not in P1'
    else if (change.change_type === 'CHANGED_RESPONSE_FIELD_TYPE') what = `has type ${last(change.new_value)} in P0 and ${last(change.previous_value)} in P1`
    lines.push({ ...summary, change: what, matters: 'Matters if the consumer goes first' })
  }
  return lines
}
