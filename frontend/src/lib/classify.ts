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
