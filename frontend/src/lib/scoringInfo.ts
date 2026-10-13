import type { RiskLevel } from '../api/types'

/**
 * Mirrors the backend scoring constants so the UI can explain a score.
 * The backend is the source of truth: it computes every score and level. If
 * the backend weights change, update this file to match. Nothing here is used
 * to calculate a result.
 */
export const SCORING_WEIGHTS: ReadonlyArray<{ signal: string; points: number; note?: string }> = [
  { signal: 'Major version gap', points: 50 },
  { signal: 'Minor version gap', points: 20 },
  { signal: 'Patch version gap', points: 5 },
  { signal: 'Breaking marker in changelog', points: 25 },
  { signal: 'Known vulnerability', points: 20 },
  { signal: 'Used by 3+ repos', points: 10 },
  { signal: 'Tier 2 code hits', points: 15 },
  { signal: 'Tier 3 code hits', points: 8 },
  { signal: 'Tier 1 import map', points: 0, note: 'Informational' },
  { signal: 'Ranges overlap', points: -30 },
]

export const RISK_THRESHOLDS: ReadonlyArray<{ level: RiskLevel; range: string }> = [
  { level: 'Low', range: '0 to 24' },
  { level: 'Medium', range: '25 to 49' },
  { level: 'High', range: '50 to 74' },
  { level: 'Critical', range: '75 and above' },
]

export const SCORING_NOTE =
  'The weights are tunable estimates, not measurements. An AI model writes the explanation text only; it never decides the risk.'
