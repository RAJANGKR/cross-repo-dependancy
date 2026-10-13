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
