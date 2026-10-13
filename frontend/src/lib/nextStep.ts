import type { DependencyDrift } from '../api/scanTypes'
import { isDrifted } from './classify'

/**
 * A rule-based suggestion derived from the backend's classifications. It adds
 * no new facts: it only turns "drift + risk + recommended version" into an
 * action, and the UI labels it as generated from rules.
 */
export function nextStepFor(row: DependencyDrift): string | null {
  if (!isDrifted(row.drift_disparity)) return null
  const target = row.recommended_version ? `to ${row.recommended_version}` : 'on one version'

  switch (row.compatibility_risk) {
    case 'CONFIRMED_BREAKING':
      return `Plan the upgrade ${target} as a code change, not a version bump. Update the usages the release notes describe, then run the affected test suites before aligning the repositories.`
    case 'SUSPECTED_BREAKING':
      return `Read the release notes between the versions in use before aligning ${target}. No text confirmed a break, so run the test suites of the repository on the older version against the newer one.`
    case 'UNKNOWN_IMPACT':
      return `No release evidence was available, so this drift is unassessed, not safe. Run a compatibility test with the newer version before aligning ${target}.`
    case 'NONE':
      return `Nothing in the available evidence points to a break. Align ${target} at the next routine dependency update.`
    default:
      return `Review this drift manually before aligning ${target}.`
  }
}

/** Shown wherever release-note evidence is missing. It replaces longer explanations of the same fact. */
export const EVIDENCE_UNAVAILABLE = 'Evidence unavailable — compatibility not verified'

export interface ConciseStep {
  /** One thing to do next. */
  action: string
  /** One short reason, taken from the classification. Empty when missing evidence is the whole reason. */
  reason: string
  /** True when no release-note text backs the classification, so compatibility was not verified. */
  evidenceUnavailable: boolean
}

/**
 * The short form of `nextStepFor`: one action and one reason per drifted
 * package. Like the long form it adds no facts. It turns the backend's
 * classification and recommended version into a sentence, and it never calls a
 * package safe when evidence is missing.
 */
export function conciseStepFor(row: DependencyDrift): ConciseStep | null {
  if (!isDrifted(row.drift_disparity)) return null
  const target = row.recommended_version ? `to ${row.recommended_version}` : 'on one version'
  const cited = Boolean(row.evidence?.cited_excerpt)

  switch (row.compatibility_risk) {
    case 'CONFIRMED_BREAKING':
      return {
        action: `Plan a code change before upgrading ${target}.`,
        reason: row.evidence?.verified_breaking ? 'Release notes state a breaking change.' : 'A breaking change is confirmed for these versions.',
        evidenceUnavailable: false,
      }
    case 'SUSPECTED_BREAKING':
      return {
        action: `Read the release notes and run tests before aligning ${target}.`,
        reason: 'The versions are a major release apart and their ranges do not overlap.',
        evidenceUnavailable: !cited,
      }
    case 'UNKNOWN_IMPACT':
      return { action: `Run a compatibility test before aligning ${target}.`, reason: cited ? 'The release notes do not settle whether this is a break.' : '', evidenceUnavailable: !cited }
    case 'NONE':
      return { action: `Align ${target} at the next routine update.`, reason: 'No issue was identified.', evidenceUnavailable: !cited }
    default:
      return { action: `Review this drift manually before aligning ${target}.`, reason: 'The classification is one this dashboard does not recognize.', evidenceUnavailable: !cited }
  }
}

const SAFE_PACKAGE = /^[@A-Za-z0-9._/-]+$/

/** Link to the package's registry page, or null when the name is not safe to put in a URL. */
export function registryUrl(row: Pick<DependencyDrift, 'dependency_name' | 'ecosystem'>): { url: string; label: string } | null {
  const name = row.dependency_name
  if (!SAFE_PACKAGE.test(name) || name.includes('..')) return null
  const ecosystem = row.ecosystem.toLowerCase()
  if (ecosystem === 'npm') return { url: `https://www.npmjs.com/package/${name}`, label: 'Open on npm' }
  if (ecosystem === 'python' || ecosystem === 'pypi') {
    return { url: `https://pypi.org/project/${encodeURIComponent(name)}/`, label: 'Open on PyPI' }
  }
  return null
}
