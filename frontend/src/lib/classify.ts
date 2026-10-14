/**
 * Display metadata for the backend's classification enums. Values the frontend
 * does not recognize are shown verbatim with a neutral style rather than being
 * mapped onto a known one.
 */

export type Tone = 'critical' | 'high' | 'medium' | 'low' | 'neutral'

export const TONE_STYLES: Record<Tone, { text: string; tint: string; border: string; cssVar: string }> = {
  critical: {
    text: 'text-risk-critical',
    tint: 'bg-risk-critical-tint',
    border: 'border-risk-critical',
    cssVar: 'var(--color-risk-critical)',
  },
  high: {
    text: 'text-risk-high',
    tint: 'bg-risk-high-tint',
    border: 'border-risk-high',
    cssVar: 'var(--color-risk-high)',
  },
  medium: {
    text: 'text-risk-medium',
    tint: 'bg-risk-medium-tint',
    border: 'border-risk-medium',
    cssVar: 'var(--color-risk-medium)',
  },
  low: {
    text: 'text-risk-low',
    tint: 'bg-risk-low-tint',
    border: 'border-risk-low',
    cssVar: 'var(--color-risk-low)',
  },
  neutral: {
    text: 'text-muted-foreground',
    tint: 'bg-secondary',
    border: 'border-border',
    cssVar: 'var(--color-chart-4)',
  },
}

export interface ClassMeta {
  value: string
  label: string
  description: string
  tone: Tone
  /** Higher sorts first. */
  rank: number
  known: boolean
}

const DRIFT: Record<string, Omit<ClassMeta, 'value' | 'known'>> = {
  MAJOR_DRIFT: {
    label: 'Major drift',
    description: 'Versions differ across a major version boundary. This measures the version gap only, not whether anything breaks.',
    tone: 'high',
    rank: 3,
  },
  MINOR_DRIFT: {
    label: 'Minor drift',
    description: 'Versions differ within the same major version (minor or patch).',
    tone: 'medium',
    rank: 2,
  },
  INFO: {
    label: 'Not compared',
    description:
      'Declared in a single repository, or the versions could not be resolved, so there is no comparison to make.',
    tone: 'neutral',
    rank: 1,
  },
  IN_SYNC: {
    label: 'In sync',
    description: 'Declared ranges and resolved versions match across repositories.',
    tone: 'low',
    rank: 0,
  },
}

const RISK: Record<string, Omit<ClassMeta, 'value' | 'known'>> = {
  CONFIRMED_BREAKING: {
    label: 'Confirmed breaking',
    description: 'Release notes cited by the backend state a breaking change.',
    tone: 'critical',
    rank: 3,
  },
  SUSPECTED_BREAKING: {
    label: 'Suspected breaking',
    description: 'A major version jump without release-note text that confirms or rules out a break.',
    tone: 'high',
    rank: 2,
  },
  UNKNOWN_IMPACT: {
    label: 'Unknown impact',
    description: 'Release notes were unavailable or inconclusive. This is not a sign of safety.',
    tone: 'medium',
    rank: 1,
  },
  NONE: {
    label: 'No issue identified',
    description: 'No issue was identified in the available evidence. That is not proof that the versions are compatible.',
    tone: 'neutral',
    rank: 0,
  },
}

const CONTRACT: Record<string, Omit<ClassMeta, 'value' | 'known'>> = {
  ANALYZED: {
    label: 'Analyzed',
    description: 'An OpenAPI specification was found and compared.',
    tone: 'low',
    rank: 0,
  },
  SPEC_UNAVAILABLE: {
    label: 'No specification found',
    description: 'No OpenAPI specification was available, so this API was not checked. It is not known to be compatible.',
    tone: 'neutral',
    rank: 1,
  },
  MALFORMED_SPEC: {
    label: 'Specification unreadable',
    description: 'A specification was found but could not be parsed, so this API was not checked.',
    tone: 'medium',
    rank: 2,
  },
  RELATIONSHIP_UNVERIFIED: {
    label: 'Relationship unverified',
    description: 'Nothing was compared for this pair, so no conclusion about compatibility can be drawn.',
    tone: 'medium',
    rank: 1,
  },
  UNRESOLVED: {
    label: 'Unresolved',
    description: 'Requests to this API are built at runtime, so no operation could be matched or excluded. This is neither a match nor an absence of usage.',
    tone: 'neutral',
    rank: 1,
  },
  NOT_COMPARED: {
    label: 'Not compared',
    description: 'A specification on its own says nothing about compatibility.',
    tone: 'neutral',
    rank: 1,
  },
}

function lookup(table: Record<string, Omit<ClassMeta, 'value' | 'known'>>, value: string): ClassMeta {
  const known = table[value]
  if (known) return { value, known: true, ...known }
  return {
    value,
    known: false,
    label: value || 'Not classified',
    description: value
      ? 'A classification this version of the dashboard does not recognize, shown as the backend sent it.'
      : 'The backend did not classify this item.',
    tone: 'neutral',
    rank: -1,
  }
}

export const driftMeta = (value: string): ClassMeta => lookup(DRIFT, value)
export const riskMeta = (value: string): ClassMeta => lookup(RISK, value)
export const contractMeta = (value: string): ClassMeta => lookup(CONTRACT, value)

/**
 * Evidence tiers for contract changes: how far the analysis got. The tier alone
 * does not say what was found (reading a changed field and sending a required
 * one are both field-level), so badges are chosen by `evidenceBadge`, which
 * also looks at the usage. Tones describe how much attention a row deserves,
 * never safety.
 */
const EVIDENCE: Record<string, Omit<ClassMeta, 'value' | 'known'>> = {
  T2_FIELD_MATCH: {
    label: 'Field-level evidence',
    description: 'Consumer source code was followed down to the changed field. This is evidence from source code, not an observed failure.',
    tone: 'neutral',
    rank: 4,
  },
  T1_OPERATION_MATCH: {
    label: 'Operation-level evidence',
    description: 'Consumer source code calls the changed operation. Nothing is claimed about the changed field.',
    tone: 'neutral',
    rank: 3,
  },
  UNRESOLVED: {
    label: 'Unresolved',
    description: 'The code, the client, the HTTP method or the URL could not be established. The consumer may or may not be affected.',
    tone: 'neutral',
    rank: 2,
  },
  NO_USAGE_FOUND: {
    label: 'No usage found',
    description: 'No matching usage was found in the inspected code. This is not proof that the consumer is unaffected.',
    tone: 'neutral',
    rank: 1,
  },
  POSSIBLE_REFERENCE: {
    label: 'Possible reference',
    description: 'A call matching this operation was found, but nothing ties it to this API. It is a candidate and is not counted as usage.',
    tone: 'neutral',
    rank: 1,
  },
  T0_DETECTED: {
    label: 'Change detected',
    description: 'A difference between two specification files. No consumer evidence is attached.',
    tone: 'neutral',
    rank: 0,
  },
}

export const evidenceMeta = (value: string): ClassMeta => lookup(EVIDENCE, value)

/**
 * What the consumer code was seen to do. Each has its own label and tone:
 * a call that is seen to satisfy a new requirement must not look like a call
 * that reads a changed field, and "unresolved" and "no usage found" are
 * neutral because neither is a finding and neither is a clean bill of health.
 */
const USAGE: Record<string, Omit<ClassMeta, 'value' | 'known'>> = {
  READS_CHANGED_FIELD: {
    label: 'Reads changed field',
    description: 'The code reads the response field whose type changed. Whether it copes with the new type is not known.',
    tone: 'high',
    rank: 7,
  },
  OMITS_REQUIRED_FIELD: {
    label: 'Required value not sent',
    description: 'The request, including the client configuration that could be read, does not contain the newly required value.',
    tone: 'high',
    rank: 7,
  },
  CALLS_OPERATION: {
    label: 'Calls removed operation',
    description: 'The code calls, with a known HTTP method, an operation the newer specification no longer defines.',
    tone: 'high',
    rank: 6,
  },
  MAY_SEND_REQUIRED_FIELD: {
    label: 'Required value sent on some paths',
    description: 'The newly required value is set only under a condition, so a request without it is possible.',
    tone: 'medium',
    rank: 5,
  },
  FIELD_NOT_READ: {
    label: 'Operation called',
    description: 'The operation is called. No read of the changed field was found in the code that was followed; that does not show the field is unused.',
    tone: 'medium',
    rank: 4,
  },
  NOT_DETERMINED: {
    label: 'Unresolved',
    description: 'The analysis could not establish what this code does with the changed element. This is neither a finding nor an all-clear.',
    tone: 'neutral',
    rank: 3,
  },
  SENDS_REQUIRED_FIELD: {
    label: 'Sends required value',
    description: 'The request is seen to include the newly required value. This says nothing about the other changes.',
    tone: 'neutral',
    rank: 2,
  },
  NO_USAGE_FOUND: {
    label: 'No usage found',
    description: 'No matching usage was found in the inspected code. This is not proof that the consumer is unaffected.',
    tone: 'neutral',
    rank: 1,
  },
}

/**
 * The badge for one piece of evidence. The usage decides when the backend sent
 * one this dashboard knows; otherwise the tier does, and an unknown tier is
 * shown as sent.
 */
export function evidenceBadge(tier: string, usage: string): ClassMeta {
  // A candidate stays a candidate, whatever the call was seen to do.
  if (tier === 'POSSIBLE_REFERENCE') return evidenceMeta(tier)
  const byUsage = USAGE[usage]
  if (byUsage) return { value: usage, known: true, ...byUsage }
  return evidenceMeta(tier)
}

/** Plain-language name for a `usage` code; an unknown code is shown as sent. */
export const usageLabel = (value: string): string => USAGE[value]?.label ?? value

const FIELD_LOCATIONS: Record<string, string> = {
  response_body: 'response field',
  request_body: 'request field',
  query: 'query parameter',
  header: 'header',
}

/** "response field customer.legacy_id", or '' when the change has no field (a removed operation). */
export function changedFieldLabel(field: string, fieldIn: string): string {
  if (!field && fieldIn === 'request_body') return 'request body'
  if (!field && fieldIn === 'response_body') return 'response body'
  if (!field) return ''
  return `${FIELD_LOCATIONS[fieldIn] ?? 'field'} ${field}`
}

const SEVERITY_TONES: Record<string, Tone> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
}

export function severityTone(severity: string): Tone {
  return SEVERITY_TONES[severity.toUpperCase()] ?? 'neutral'
}

/** True for drift that is an actual version difference between repositories. */
export function isDrifted(driftDisparity: string): boolean {
  return driftDisparity === 'MAJOR_DRIFT' || driftDisparity === 'MINOR_DRIFT'
}

/** True for the two classifications that count as a compatibility finding. */
export function isCompatibilityFinding(risk: string): boolean {
  return risk === 'CONFIRMED_BREAKING' || risk === 'SUSPECTED_BREAKING'
}
