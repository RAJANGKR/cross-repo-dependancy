import { ApiFailure } from './errors'
import type { ScanClient } from './scanClient'
import type { DependencyDrift, RepoDeclaration, ScanRecord, ScanResult } from './scanTypes'

/**
 * Bundled demo scan. Hand-written, illustrative data in the contract's shape,
 * NOT the output of a real scan. It is only ever reached through "Load demo
 * run" or mock mode, and the UI labels it "Demo data" everywhere.
 *
 * The contract-analysis and code-impact parts use the provisional field names
 * from scanTypes.ts; the real backend does not return those sections yet.
 */

const ORG = 'https://github.com/example-org'
const REPOS = ['payment-service', 'core-service', 'customer-service'] as const

function decl(
  declared_range: string,
  resolved_version: string | null,
  source_file: string,
  dep_type = 'runtime',
): RepoDeclaration {
  return { declared_range, resolved_version, dep_type, source_file }
}

type DriftExtras = Pick<
  DependencyDrift,
  'score' | 'risk_level' | 'breakdown' | 'confidence' | 'signals_missing' | 'vulnerabilities' | 'explanation'
>
const NO_EXTRAS: DriftExtras = {
  score: null,
  risk_level: null,
  breakdown: [],
  confidence: null,
  signals_missing: [],
  vulnerabilities: [],
  explanation: null,
}

function drift(
  record: Omit<DependencyDrift, 'id' | 'present_in_repos' | 'missing_in_repos' | keyof DriftExtras> & Partial<DriftExtras>,
): DependencyDrift {
  const present = Object.keys(record.declarations_by_repo)
  return {
    ...NO_EXTRAS,
    ...record,
    id: `${record.ecosystem}:${record.dependency_name}`,
    present_in_repos: present,
    missing_in_repos: REPOS.filter((repo) => !present.includes(repo)),
  }
}

// customer-service has no package-lock.json in this demo, so its npm
// dependencies have no resolved version.
const driftMatrix: DependencyDrift[] = [
  drift({
    dependency_name: 'react',
    ecosystem: 'npm',
    drift_disparity: 'MAJOR_DRIFT',
    compatibility_risk: 'CONFIRMED_BREAKING',
    declarations_by_repo: {
      'payment-service': decl('^18.2.0', '18.2.0', 'package.json'),
      'customer-service': decl('^17.0.2', null, 'package.json'),
    },
    recommended_version: '^18.2.0',
    evidence: {
      source_url: 'https://github.com/facebook/react/releases/tag/v18.0.0',
      cited_excerpt:
        'Automatic batching is enabled by default. ReactDOM.render has been replaced by createRoot.',
      verified_breaking: true,
      notes: 'The excerpt states that ReactDOM.render was replaced, so code written for 17 that calls it needs changes on 18.',
    },
    score: 75,
    risk_level: 'Critical',
    breakdown: [
      { signal: 'Major version gap', points: 50 },
      { signal: 'Breaking marker in changelog', points: 25 },
    ],
    confidence: 0.8,
    signals_missing: ['lockfile', 'code_scan'],
    explanation: {
      text: 'react is used at 17.0.2 to 18.2.0 across the scanned repositories, a major version gap. Release notes state a breaking change between these versions.',
      source: 'template',
    },
  }),
  drift({
    dependency_name: 'pydantic',
    ecosystem: 'python',
    drift_disparity: 'MAJOR_DRIFT',
    compatibility_risk: 'SUSPECTED_BREAKING',
    declarations_by_repo: {
      'payment-service': decl('>=2.5,<3', '2.5.3', 'pyproject.toml'),
      'core-service': decl('==1.10.13', '1.10.13', 'requirements.txt'),
    },
    recommended_version: '>=2.5,<3',
    evidence: {
      source_url: 'https://pypi.org/pypi/pydantic/json',
      cited_excerpt: '',
      verified_breaking: false,
      notes: 'The versions cross a major boundary, but no release-note text was retrieved to confirm a breaking change.',
    },
  }),
  drift({
    dependency_name: 'axios',
    ecosystem: 'npm',
    drift_disparity: 'MAJOR_DRIFT',
    compatibility_risk: 'UNKNOWN_IMPACT',
    declarations_by_repo: {
      'payment-service': decl('^0.27.2', '0.27.2', 'package.json'),
      'customer-service': decl('^1.6.2', null, 'package.json'),
    },
    recommended_version: '^1.6.2',
    evidence: null,
    score: 70,
    risk_level: 'High',
    breakdown: [
      { signal: 'Major version gap', points: 50 },
      { signal: 'Known vulnerability', points: 20 },
    ],
    confidence: 0.55,
    signals_missing: ['lockfile', 'changelog', 'code_scan'],
    vulnerabilities: [
      {
        id: 'GHSA-wf5p-g6vw-rhxx',
        summary: 'The XSRF token can be sent to third-party hosts in some configurations.',
        affects_repo: 'payment-service',
        fixed_in: '0.28.0',
      },
    ],
    explanation: {
      text: 'axios is used at 0.27.2 to 1.6.2, a major version gap. There was not enough evidence to assess the impact.',
      source: 'template',
    },
  }),
  drift({
    dependency_name: 'fastapi',
    ecosystem: 'python',
    drift_disparity: 'MINOR_DRIFT',
    compatibility_risk: 'NONE',
    declarations_by_repo: {
      'payment-service': decl('>=0.95.0', '0.104.1', 'pyproject.toml'),
      'core-service': decl('>=0.100.0', '0.110.0', 'requirements.txt'),
    },
    recommended_version: '>=0.110.0',
    evidence: {
      source_url: 'https://pypi.org/pypi/fastapi/json',
      cited_excerpt: 'Minor backward-compatible feature additions and performance improvements.',
      verified_breaking: false,
      notes: 'No breaking changes are reported between 0.104.1 and 0.110.0 in the retrieved notes.',
    },
  }),
  drift({
    dependency_name: 'requests',
    ecosystem: 'python',
    drift_disparity: 'MINOR_DRIFT',
    compatibility_risk: 'UNKNOWN_IMPACT',
    declarations_by_repo: {
      'payment-service': decl('>=2.25', '2.28.2', 'pyproject.toml'),
      'core-service': decl('==2.31.0', '2.31.0', 'requirements.txt'),
    },
    recommended_version: '==2.31.0',
    evidence: null,
  }),
  drift({
    dependency_name: 'lodash',
    ecosystem: 'npm',
    drift_disparity: 'MINOR_DRIFT',
    compatibility_risk: 'NONE',
    declarations_by_repo: {
      'payment-service': decl('^4.17.20', '4.17.20', 'package.json'),
      'customer-service': decl('^4.17.21', null, 'package.json'),
    },
    recommended_version: '^4.17.21',
    evidence: {
      source_url: 'https://github.com/lodash/lodash/releases',
      cited_excerpt: 'Patch release with fixes. No API changes.',
      verified_breaking: false,
      notes: 'The retrieved notes describe fixes only.',
    },
  }),
  drift({
    dependency_name: 'typescript',
    ecosystem: 'npm',
    drift_disparity: 'IN_SYNC',
    compatibility_risk: 'NONE',
    declarations_by_repo: {
      'payment-service': decl('~5.4.5', '5.4.5', 'package.json', 'dev'),
      'customer-service': decl('~5.4.5', null, 'package.json', 'dev'),
    },
    recommended_version: null,
    evidence: null,
  }),
  drift({
    dependency_name: 'eslint',
    ecosystem: 'npm',
    drift_disparity: 'IN_SYNC',
    compatibility_risk: 'NONE',
    declarations_by_repo: {
      'payment-service': decl('^9.4.0', '9.4.0', 'package.json', 'dev'),
      'customer-service': decl('^9.4.0', null, 'package.json', 'dev'),
    },
    recommended_version: null,
    evidence: null,
  }),
  drift({
    dependency_name: 'uvicorn',
    ecosystem: 'python',
    drift_disparity: 'IN_SYNC',
    compatibility_risk: 'NONE',
    declarations_by_repo: {
      'payment-service': decl('==0.29.0', '0.29.0', 'pyproject.toml'),
      'core-service': decl('==0.29.0', '0.29.0', 'requirements.txt'),
    },
    recommended_version: null,
    evidence: null,
  }),
  drift({
    dependency_name: 'express',
    ecosystem: 'npm',
    drift_disparity: 'INFO',
    compatibility_risk: 'NONE',
    declarations_by_repo: { 'customer-service': decl('^4.18.2', null, 'package.json') },
    recommended_version: null,
    evidence: null,
  }),
  drift({
    dependency_name: 'sqlalchemy',
    ecosystem: 'python',
    drift_disparity: 'INFO',
    compatibility_risk: 'NONE',
    declarations_by_repo: { 'core-service': decl('>=2.0,<2.1', '2.0.30', 'requirements.txt') },
    recommended_version: null,
    evidence: null,
  }),
  drift({
    dependency_name: 'zod',
    ecosystem: 'npm',
    drift_disparity: 'INFO',
    compatibility_risk: 'NONE',
    declarations_by_repo: { 'payment-service': decl('^3.23.8', '3.23.8', 'package.json') },
    recommended_version: null,
    evidence: null,
  }),
]

function countBy(key: 'drift_disparity' | 'compatibility_risk', rows: DependencyDrift[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of rows) result[row[key]] = (result[row[key]] ?? 0) + 1
  return result
}

function summarize(rows: DependencyDrift[]): ScanResult['summary'] {
  const severity = countBy('drift_disparity', rows)
  return {
    total_unique_dependencies: rows.length,
    shared_dependencies_count: rows.filter((row) => row.present_in_repos.length > 1).length,
    drift_count: (severity.MAJOR_DRIFT ?? 0) + (severity.MINOR_DRIFT ?? 0),
    in_sync_count: severity.IN_SYNC ?? 0,
    severity_counts: severity,
    compatibility_risk_counts: countBy('compatibility_risk', rows),
  }
}

function repositories(rows: DependencyDrift[]): ScanResult['scanned_repositories'] {
  const manifests: Record<string, number> = { 'payment-service': 3, 'core-service': 1, 'customer-service': 1 }
  return REPOS.map((name) => ({
    name,
    url: `${ORG}/${name}`,
    manifest_count: manifests[name] ?? null,
    total_dependencies: rows.filter((row) => name in row.declarations_by_repo).length,
  }))
}

const edgeCount = driftMatrix.reduce((sum, row) => sum + row.present_in_repos.length, 0)
const nodeCount = REPOS.length + driftMatrix.length

const demoResult: ScanResult = {
  scanned_repositories: repositories(driftMatrix),
  summary: summarize(driftMatrix),
  drift_matrix: driftMatrix,
  graph_summary: {
    total_nodes: nodeCount,
    total_edges: edgeCount,
    density: Number((edgeCount / (nodeCount * (nodeCount - 1))).toFixed(3)),
    highest_drift_nodes: ['react', 'pydantic', 'axios'],
  },
  warnings: [
    'customer-service: package-lock.json not found, so resolved versions are unavailable for its npm dependencies',
    'Gemini was unavailable for 2 packages; their compatibility risk is based on version numbers only',
  ],
  skipped_items: [
    'core-service/requirements.txt: git+https://github.com/example-org/internal-auth.git (unsupported spec)',
  ],
  contract_analysis: [
    {
      provider_repo: 'core-service',
      consumer_repo: 'payment-service',
      status: 'ANALYZED',
      spec_file: 'openapi.yaml',
      message: '',
      findings: [
        {
          change_type: 'REMOVED_OPERATION',
          path: '/v1/customers/{id}/sessions',
          method: 'DELETE',
          previous_value: 'operation present',
          new_value: 'operation removed',
          spec_file: 'openapi.yaml',
          json_pointer: '/paths/~1v1~1customers~1{id}~1sessions/delete',
          severity: 'HIGH',
          impact: 'Consumers calling this operation will receive 404 or 405.',
        },
        {
          change_type: 'REQUIRED_FIELD_ADDED',
          path: '/v1/invoices',
          method: 'POST',
          previous_value: 'currency: optional',
          new_value: 'currency: required',
          spec_file: 'openapi.yaml',
          json_pointer: '/paths/~1v1~1invoices/post/requestBody/content/application~1json/schema/required',
          severity: 'MEDIUM',
          impact: 'Requests that omit currency will be rejected.',
        },
        {
          change_type: 'RESPONSE_TYPE_CHANGED',
          path: '/v1/customers/{id}',
          method: 'GET',
          previous_value: 'balance: integer',
          new_value: 'balance: string',
          spec_file: 'openapi.yaml',
          json_pointer: '/paths/~1v1~1customers~1{id}/get/responses/200/content/application~1json/schema/properties/balance/type',
          severity: 'MEDIUM',
          impact: '',
        },
      ],
    },
    {
      provider_repo: 'customer-service',
      consumer_repo: '',
      status: 'SPEC_UNAVAILABLE',
      spec_file: '',
      message: 'No OpenAPI specification was found in this repository.',
      findings: [],
    },
    {
      provider_repo: 'payment-service',
      consumer_repo: '',
      status: 'MALFORMED_SPEC',
      spec_file: 'docs/openapi.json',
      message: 'The specification could not be parsed: unexpected token at line 212.',
      findings: [],
    },
  ],
  code_impact: [
    {
      repository: 'payment-service',
      file: 'src/clients/coreClient.ts',
      line: 48,
      snippet: 'await http.delete(`/v1/customers/${id}/sessions`)',
      related_change: 'DELETE /v1/customers/{id}/sessions removed in core-service',
      dependency_name: '',
      impact: 'This call targets an operation that the provider removed.',
      confidence: 'high',
      limitations: 'Matched on the literal URL string. Dynamically built URLs are not detected.',
    },
    {
      repository: 'payment-service',
      file: 'src/http/client.js',
      line: 31,
      snippet: 'if (err.response && err.isAxiosError) { retry(err.config) }',
      related_change: 'axios 0.27.2 to 1.6.2',
      dependency_name: 'axios',
      impact: 'Error handling may behave differently across the major version.',
      confidence: 'low',
      limitations: 'No release-note evidence was available, so this is a location to review, not a confirmed break.',
    },
  ],
  data_sources: [
    { name: 'GitHub', status: 'ok' },
    { name: 'npm registry', status: 'ok' },
    { name: 'PyPI', status: 'ok' },
    { name: 'Maven Central', status: 'not_used' },
    { name: 'OSV', status: 'ok' },
    { name: 'Gemini', status: 'degraded' },
  ],
  repository_details: REPOS.map((name) => ({
    name,
    kind: 'github',
    ref: 'main',
    commit: null,
    manifests:
      name === 'payment-service'
        ? ['package.json', 'package-lock.json', 'pyproject.toml']
        : name === 'core-service'
          ? ['requirements.txt']
          : ['package.json'],
    code_scanned: true,
    error: null,
  })),
}

export const DEMO_SCAN_ID = 'scn_demo000000'

export function demoRecord(result: ScanResult = demoResult): ScanRecord {
  return {
    scan_id: DEMO_SCAN_ID,
    status: 'COMPLETED',
    created_at: '2026-10-13T06:30:00.000Z',
    updated_at: '2026-10-13T06:30:12.400Z',
    completed_at: '2026-10-13T06:30:12.400Z',
    duration_seconds: 12.4,
    progress: null,
    result,
    error: null,
  }
}

/** One repository returned nothing; the rest of the result is still usable. */
function partialResult(): ScanResult {
  const failed = 'customer-service'
  const rows = driftMatrix
    .filter((row) => row.present_in_repos.some((repo) => repo !== failed))
    .map((row) => {
      const declarations = { ...row.declarations_by_repo }
      delete declarations[failed]
      const present = Object.keys(declarations)
      const lone = present.length === 1
      return {
        ...row,
        declarations_by_repo: declarations,
        present_in_repos: present,
        missing_in_repos: REPOS.filter((repo) => !present.includes(repo)),
        drift_disparity: lone ? 'INFO' : row.drift_disparity,
        compatibility_risk: lone ? 'NONE' : row.compatibility_risk,
        evidence: lone ? null : row.evidence,
      }
    })
  return {
    ...demoResult,
    scanned_repositories: repositories(rows).map((repo) =>
      repo.name === failed ? { ...repo, manifest_count: 0, total_dependencies: 0 } : repo,
    ),
    summary: summarize(rows),
    drift_matrix: rows,
    graph_summary: null,
    warnings: ['customer-service: repository could not be fetched (404). It was skipped; the other repositories were analyzed.'],
    skipped_items: [],
    contract_analysis: null,
    code_impact: null,
  }
}

function emptyResult(): ScanResult {
  const rows = driftMatrix.filter((row) => row.drift_disparity === 'IN_SYNC')
  return {
    ...demoResult,
    scanned_repositories: repositories(rows),
    summary: summarize(rows),
    drift_matrix: rows,
    graph_summary: null,
    warnings: [],
    skipped_items: [],
    contract_analysis: null,
    code_impact: null,
  }
}

/** Only what the contract guarantees: every optional section is absent. */
function minimalResult(): ScanResult {
  return {
    scanned_repositories: [],
    summary: null,
    drift_matrix: driftMatrix
      .slice(0, 3)
      .map((row) => ({ ...row, ...NO_EXTRAS, evidence: null, recommended_version: null })),
    graph_summary: null,
    warnings: [],
    skipped_items: [],
    contract_analysis: null,
    code_impact: null,
    data_sources: [],
    repository_details: [],
  }
}

export const DEMO_VARIANTS = [
  'failed',
  'error400',
  'ratelimit',
  'offline',
  'notfound',
  'timeout',
  'partial',
  'empty',
  'minimal',
] as const
export type DemoVariant = (typeof DEMO_VARIANTS)[number]

/** Reads the dev-only `?mock=` switch. Only honored in mock mode. */
export function readDemoVariant(search: string): DemoVariant | null {
  const value = new URLSearchParams(search).get('mock')
  return (DEMO_VARIANTS as readonly string[]).includes(value ?? '') ? (value as DemoVariant) : null
}

const STAGES = [
  { stage: 'FETCHING', percentage: 25, current_action: 'Fetching manifests and lockfiles from GitHub' },
  { stage: 'PARSING', percentage: 50, current_action: 'Parsing manifests and normalizing package names' },
  { stage: 'ANALYZING', percentage: 75, current_action: 'Evaluating SemVer disparity and building the dependency graph' },
]

/**
 * A `ScanClient` that plays the demo scan through the same lifecycle as the
 * real API (QUEUED, FETCHING, PARSING, ANALYZING, then a terminal status), so
 * the demo exercises the real submission and polling code.
 */
export function createDemoClient(variant: DemoVariant | null = null): ScanClient {
  let polls = 0
  const inProgress = (index: number): ScanRecord => {
    const stage = STAGES[Math.min(index, STAGES.length - 1)]
    return {
      ...demoRecord(),
      status: stage?.stage ?? 'ANALYZING',
      completed_at: null,
      duration_seconds: null,
      progress: stage ?? null,
      result: null,
    }
  }

  return {
    async createScan() {
      if (variant === 'offline') throw new ApiFailure('network')
      if (variant === 'error400') {
        throw new ApiFailure('http', {
          status: 400,
          errorCode: 'INVALID_TARGETS',
          serverMessage: 'A scan must contain between 1 and 3 repository targets.',
        })
      }
      if (variant === 'ratelimit') {
        throw new ApiFailure('http', {
          status: 429,
          errorCode: 'RATE_LIMIT_EXCEEDED',
          serverMessage:
            'GitHub API unauthenticated rate limit reached. Set GITHUB_TOKEN on backend or retry later.',
        })
      }
      return {
        kind: 'accepted',
        accepted: { scan_id: DEMO_SCAN_ID, status: 'QUEUED', poll_url: `/api/v1/scans/${DEMO_SCAN_ID}` },
      }
    },

    async getScan() {
      const index = polls
      polls += 1
      if (variant === 'timeout') return inProgress(0)
      if (variant === 'notfound' && index >= 1) {
        throw new ApiFailure('http', {
          status: 404,
          errorCode: 'SCAN_NOT_FOUND',
          serverMessage: `Scan with id '${DEMO_SCAN_ID}' does not exist or has expired.`,
        })
      }
      if (index < STAGES.length) return inProgress(index)
      if (variant === 'failed') {
        return {
          ...inProgress(STAGES.length - 1),
          status: 'FAILED',
          error: { error_code: 'SCAN_FAILED', message: 'Unexpected failure during dependency graph generation.' },
        }
      }
      if (variant === 'partial') return demoRecord(partialResult())
      if (variant === 'empty') return demoRecord(emptyResult())
      if (variant === 'minimal') return demoRecord(minimalResult())
      return demoRecord()
    },

    async getHealth() {
      return { status: 'demo' }
    },
  }
}
