import type { Drift, Report, RiskLevel } from './types'

/**
 * Bundled demo report. It is illustrative data written by hand, NOT the output
 * of a scan, and `meta.source` is always "demo" so the UI labels it "Demo data".
 * It deliberately covers every UI path: all four risk levels, all three code
 * usage tiers, missing evidence, a pasted project, a project with no manifest,
 * skipped dependencies and warnings.
 */

const DEMO_ORG = 'https://github.com/example-org'

const drifts: Drift[] = [
  {
    id: 'maven:com.fasterxml.jackson.core:jackson-databind',
    library: 'com.fasterxml.jackson.core:jackson-databind',
    ecosystem: 'maven',
    versions: [
      { repo: 'service-b', version: '2.9.10', raw_spec: '2.9.10', file: 'pom.xml' },
      { repo: 'service-c', version: '2.15.2', raw_spec: '2.15.2', file: 'pom.xml' },
      { repo: 'billing-service', version: '3.0.0', raw_spec: '3.0.0', file: 'pom.xml' },
    ],
    gap: 'major',
    risk: 'Critical',
    score: 80,
    breakdown: [
      { signal: 'Major version gap', points: 50 },
      { signal: 'Known vulnerability', points: 20 },
      { signal: 'Used by 3+ repos', points: 10 },
    ],
    confidence: 0.7,
    signals_missing: ['changelog'],
    evidence: {
      changelog: [],
      vulnerabilities: [
        {
          id: 'GHSA-57j2-w4cx-62h2',
          summary: 'Deeply nested JSON can exhaust the stack and crash the service.',
          affects: 'service-b',
        },
      ],
      code_usage: {
        import_map: [
          { repo: 'service-b', files: 7, symbols: ['ObjectMapper', 'JsonNode', 'DeserializationFeature'] },
          { repo: 'service-c', files: 3, symbols: ['ObjectMapper', 'JsonNode'] },
        ],
        hits: [],
        note: 'scan unavailable (pasted input) for billing-service',
      },
    },
    explanation: {
      text: 'Three projects use three different lines of jackson-databind, including two major versions. The oldest one is affected by a known vulnerability.',
      source: 'template',
    },
    recommendation: 'Upgrade service-b to 2.15.2 first, then plan the move to 3.x across all three projects.',
  },
  {
    id: 'npm:axios',
    library: 'axios',
    ecosystem: 'npm',
    versions: [
      { repo: 'service-a', version: '0.27.2', raw_spec: '^0.27.2', file: 'package.json' },
      { repo: 'service-c', version: '1.6.2', raw_spec: '^1.6.2', file: 'package.json' },
    ],
    gap: 'major',
    risk: 'Critical',
    score: 78,
    breakdown: [
      { signal: 'Major version gap', points: 50 },
      { signal: 'Known vulnerability', points: 20 },
      { signal: 'Tier 3 code hits', points: 8 },
    ],
    confidence: 0.65,
    signals_missing: [],
    evidence: {
      changelog: [
        {
          version: '1.0.0',
          line: 'Breaking: the default export and error handling changed; AxiosError is now the error class thrown for failed requests.',
          url: 'https://github.com/axios/axios/releases/tag/v1.0.0',
        },
      ],
      vulnerabilities: [
        {
          id: 'GHSA-wf5p-g6vw-rhxx',
          summary: 'The XSRF token can be sent to third-party hosts in some configurations.',
          affects: 'service-a',
        },
      ],
      code_usage: {
        import_map: [
          { repo: 'service-a', files: 5, symbols: ['axios', 'AxiosRequestConfig'] },
          { repo: 'service-c', files: 4, symbols: ['axios', 'AxiosError'] },
        ],
        hits: [
          {
            repo: 'service-a',
            file: 'src/http/client.js',
            line: 31,
            snippet: 'if (err.response && err.isAxiosError) { retry(err.config) }',
            rule: 'isAxiosError',
            status: 'changed',
            replacement: 'axios.isAxiosError(err)',
            tier: 3,
            rule_status: 'candidate',
          },
        ],
        note: null,
      },
    },
    explanation: {
      text: 'service-a is on the 0.x line while service-c moved to 1.x, which changed error handling. One usage in service-a matches a name the changelog mentions.',
      source: 'ai',
    },
    recommendation: 'Upgrade service-a to axios 1.6.2 and review the error handling in src/http/client.js.',
  },
  {
    id: 'pypi:pydantic',
    library: 'pydantic',
    ecosystem: 'pypi',
    versions: [
      { repo: 'service-a', version: '1.10.13', raw_spec: '==1.10.13', file: 'requirements.txt' },
      { repo: 'service-b', version: '2.5.0', raw_spec: '==2.5.0', file: 'requirements.txt' },
    ],
    gap: 'major',
    risk: 'High',
    score: 65,
    breakdown: [
      { signal: 'Major version gap', points: 50 },
      { signal: 'Tier 2 code hits', points: 15 },
    ],
    confidence: 0.9,
    signals_missing: [],
    evidence: {
      changelog: [
        {
          version: '2.0.0',
          line: 'Validators: use @field_validator in place of @validator, and model_config in place of the inner Config class.',
          url: 'https://docs.pydantic.dev/latest/migration/',
        },
      ],
      vulnerabilities: [],
      code_usage: {
        import_map: [
          { repo: 'service-a', files: 4, symbols: ['BaseModel', 'validator', 'Field'] },
          { repo: 'service-b', files: 6, symbols: ['BaseModel', 'field_validator', 'ConfigDict'] },
        ],
        hits: [
          {
            repo: 'service-a',
            file: 'models/user.py',
            line: 14,
            snippet: '@validator("email")\ndef normalize_email(cls, value):\n    return value.strip().lower()',
            rule: 'validator',
            status: 'deprecated',
            replacement: 'field_validator',
            tier: 2,
            rule_status: 'verified',
          },
          {
            repo: 'service-a',
            file: 'models/user.py',
            line: 22,
            snippet: 'class Config:\n    orm_mode = True',
            rule: 'Config',
            status: 'renamed',
            replacement: 'model_config',
            tier: 2,
            rule_status: 'verified',
          },
          {
            repo: 'service-a',
            file: 'schemas/order.py',
            line: 9,
            snippet: '@validator("total", pre=True)\ndef parse_total(cls, value):\n    return Decimal(str(value))',
            rule: 'validator',
            status: 'deprecated',
            replacement: 'field_validator',
            tier: 2,
            rule_status: 'verified',
          },
        ],
        note: null,
      },
    },
    explanation: {
      text: 'service-a pins pydantic 1.x and service-b pins 2.x. service-a uses @validator and an inner Config class, both of which changed in version 2.',
      source: 'ai',
    },
    recommendation: 'Migrate service-a to pydantic 2.5.0, starting with the three flagged lines.',
  },
  {
    id: 'npm:express',
    library: 'express',
    ecosystem: 'npm',
    versions: [
      { repo: 'billing-service', version: '4.18.2', raw_spec: '^4.18.2', file: 'package.json' },
      { repo: 'service-c', version: '5.0.1', raw_spec: '^5.0.1', file: 'package.json' },
    ],
    gap: 'major',
    risk: 'High',
    score: 50,
    breakdown: [{ signal: 'Major version gap', points: 50 }],
    confidence: 0.55,
    signals_missing: ['changelog', 'code_usage'],
    evidence: {
      changelog: [],
      vulnerabilities: [],
      code_usage: {
        import_map: [{ repo: 'service-c', files: 2, symbols: ['express', 'Router'] }],
        hits: [],
        note: 'scan unavailable (pasted input)',
      },
    },
    explanation: {
      text: 'billing-service declares express 4.x and service-c declares 5.x. The source of billing-service was not available, so its usage could not be checked.',
      source: 'template',
    },
    recommendation: 'Review the express 5 migration notes before aligning billing-service with service-c.',
  },
  {
    id: 'pypi:requests',
    library: 'requests',
    ecosystem: 'pypi',
    versions: [
      { repo: 'service-a', version: '2.25.1', raw_spec: '>=2.25,<2.26', file: 'requirements.txt' },
      { repo: 'service-b', version: '2.31.0', raw_spec: '==2.31.0', file: 'requirements.txt' },
    ],
    gap: 'minor',
    risk: 'Medium',
    score: 40,
    breakdown: [
      { signal: 'Minor version gap', points: 20 },
      { signal: 'Known vulnerability', points: 20 },
    ],
    confidence: 0.4,
    signals_missing: ['changelog', 'code_usage', 'range_overlap'],
    evidence: {
      changelog: [],
      vulnerabilities: [
        {
          id: 'GHSA-j8r2-6x86-q33q',
          summary: 'Proxy-Authorization headers can leak to the destination server on redirects.',
          affects: 'service-a',
        },
      ],
      code_usage: {
        import_map: [],
        hits: [],
        note: 'import mapping unavailable',
      },
    },
    explanation: null,
    recommendation: 'Raise the requests pin in service-a to 2.31.0.',
  },
  {
    id: 'npm:typescript',
    library: 'typescript',
    ecosystem: 'npm',
    versions: [
      { repo: 'service-a', version: '5.2.2', raw_spec: '~5.2.2', file: 'package.json' },
      { repo: 'service-c', version: '5.4.5', raw_spec: '~5.4.5', file: 'package.json' },
    ],
    gap: 'minor',
    risk: 'Low',
    score: 20,
    breakdown: [{ signal: 'Minor version gap', points: 20 }],
    confidence: 0.8,
    signals_missing: ['code_usage'],
    evidence: {
      changelog: [
        {
          version: '5.4.0',
          line: 'Adds the NoInfer utility type and preserved narrowing in closures.',
          url: null,
        },
      ],
      vulnerabilities: [],
      code_usage: {
        import_map: [],
        hits: [],
        note: 'build tool, not imported from source',
      },
    },
    explanation: {
      text: 'Both projects are on TypeScript 5 with two minor versions between them. No breaking markers were found in the release notes.',
      source: 'template',
    },
    recommendation: 'Align both projects on 5.4.5 at the next routine update.',
  },
  {
    id: 'npm:lodash',
    library: 'lodash',
    ecosystem: 'npm',
    versions: [
      { repo: 'service-a', version: '4.17.20', raw_spec: '^4.17.20', file: 'package.json' },
      { repo: 'service-c', version: '4.17.21', raw_spec: '^4.17.21', file: 'package.json' },
    ],
    gap: 'patch',
    risk: 'Low',
    // Signals sum to -5; the backend floors the score at 0.
    score: 0,
    breakdown: [
      { signal: 'Patch version gap', points: 5 },
      { signal: 'Known vulnerability', points: 20 },
      { signal: 'Ranges overlap', points: -30 },
    ],
    confidence: 0.85,
    signals_missing: [],
    evidence: {
      changelog: [
        {
          version: '4.17.21',
          line: 'Security fixes for template and trim functions. No API changes.',
          url: null,
        },
      ],
      vulnerabilities: [
        {
          id: 'GHSA-35jh-r3h4-6jhm',
          summary: 'Command injection through the template function with untrusted options.',
          affects: 'service-a',
        },
      ],
      code_usage: {
        import_map: [
          { repo: 'service-a', files: 9, symbols: ['debounce', 'groupBy', 'merge'] },
          { repo: 'service-c', files: 6, symbols: ['debounce', 'pick'] },
        ],
        hits: [],
        note: null,
      },
    },
    explanation: {
      text: 'Both ranges accept 4.17.21, so the two projects can already resolve to the same version. A fresh install in service-a picks up the patched release.',
      source: 'template',
    },
    recommendation: 'Refresh the lockfile in service-a so it resolves to 4.17.21.',
  },
]

function countByRisk(list: Drift[]): Record<RiskLevel, number> {
  const counts: Record<RiskLevel, number> = { Low: 0, Medium: 0, High: 0, Critical: 0 }
  for (const drift of list) counts[drift.risk] += 1
  return counts
}

export const mockReport: Report = {
  meta: {
    source: 'demo',
    generated_at: '2026-10-13T06:30:00Z',
    duration_ms: 8420,
    github_rate_limit_remaining: 7,
  },
  summary: {
    repos: 5,
    dependencies: 13,
    drifts: drifts.length,
    by_risk: countByRisk(drifts),
  },
  repos: [
    {
      name: 'service-a',
      origin: 'github',
      url: `${DEMO_ORG}/service-a`,
      ref: 'main',
      commit: 'a1b2c3d',
      manifests: ['requirements.txt', 'package.json'],
      status: 'ok',
      message: '',
      code_scan: 'ran',
    },
    {
      name: 'service-b',
      origin: 'github',
      url: `${DEMO_ORG}/service-b`,
      ref: 'main',
      commit: '9f8e7d6',
      manifests: ['requirements.txt', 'pom.xml'],
      status: 'ok',
      message: '',
      code_scan: 'ran',
    },
    {
      name: 'service-c',
      origin: 'github',
      url: `${DEMO_ORG}/service-c/tree/feature/axios-upgrade`,
      ref: 'feature/axios-upgrade',
      commit: '4c5d6e7',
      manifests: ['package.json', 'pom.xml'],
      status: 'ok',
      message: '',
      code_scan: 'ran',
    },
    {
      name: 'billing-service',
      origin: 'pasted',
      url: '',
      ref: '',
      commit: '',
      manifests: ['package.json', 'pom.xml'],
      status: 'ok',
      message: '',
      code_scan: 'unavailable',
    },
    {
      name: 'legacy-docs',
      origin: 'github',
      url: `${DEMO_ORG}/legacy-docs`,
      ref: 'main',
      commit: '77aa01f',
      manifests: [],
      status: 'no_manifest',
      message: 'Looked for package.json, requirements.txt and pom.xml at the repository root.',
      code_scan: 'unavailable',
    },
  ],
  graph: {
    nodes: [
      { id: 'service-a', type: 'repo', risk: null, drifted: false },
      { id: 'service-b', type: 'repo', risk: null, drifted: false },
      { id: 'service-c', type: 'repo', risk: null, drifted: false },
      { id: 'billing-service', type: 'repo', risk: null, drifted: false },
      ...drifts.map((drift) => ({
        id: drift.id,
        type: 'library' as const,
        risk: drift.risk,
        drifted: true,
      })),
      { id: 'npm:react', type: 'library', risk: null, drifted: false },
      { id: 'npm:vite', type: 'library', risk: null, drifted: false },
      { id: 'npm:zod', type: 'library', risk: null, drifted: false },
      { id: 'pypi:fastapi', type: 'library', risk: null, drifted: false },
      { id: 'pypi:uvicorn', type: 'library', risk: null, drifted: false },
      { id: 'maven:org.slf4j:slf4j-api', type: 'library', risk: null, drifted: false },
    ],
    edges: [
      ...drifts.flatMap((drift) =>
        drift.versions.map((entry) => ({
          source: entry.repo,
          target: drift.id,
          version: entry.version,
          raw_spec: entry.raw_spec,
        })),
      ),
      { source: 'service-a', target: 'npm:react', version: '18.3.1', raw_spec: '^18.3.1' },
      { source: 'service-c', target: 'npm:react', version: '18.3.1', raw_spec: '^18.3.1' },
      { source: 'service-c', target: 'npm:vite', version: '5.4.2', raw_spec: '^5.4.2' },
      { source: 'billing-service', target: 'npm:zod', version: '3.23.8', raw_spec: '^3.23.8' },
      { source: 'service-a', target: 'pypi:fastapi', version: '0.110.0', raw_spec: '==0.110.0' },
      { source: 'service-b', target: 'pypi:fastapi', version: '0.110.0', raw_spec: '==0.110.0' },
      { source: 'service-a', target: 'pypi:uvicorn', version: '0.29.0', raw_spec: '==0.29.0' },
      { source: 'service-b', target: 'pypi:uvicorn', version: '0.29.0', raw_spec: '==0.29.0' },
      { source: 'service-b', target: 'maven:org.slf4j:slf4j-api', version: '2.0.12', raw_spec: '2.0.12' },
      { source: 'service-c', target: 'maven:org.slf4j:slf4j-api', version: '2.0.12', raw_spec: '2.0.12' },
    ],
  },
  drifts,
  skipped: [
    {
      repo: 'service-b',
      library: 'internal-auth-lib',
      raw_spec: 'git+https://github.com/example-org/internal-auth-lib.git@v2',
      reason: 'unsupported spec',
    },
    {
      repo: 'billing-service',
      library: '@billing/shared-utils',
      raw_spec: '^3.1.0',
      reason: 'not found in public registry',
    },
  ],
  warnings: ['GitHub rate limit low', 'Gemini unavailable for 4 drifts, used template explanations'],
}

/** Demo variant with no drift, for the positive empty state. */
export function emptyMockReport(): Report {
  return {
    ...mockReport,
    summary: {
      ...mockReport.summary,
      drifts: 0,
      by_risk: { Low: 0, Medium: 0, High: 0, Critical: 0 },
    },
    graph: {
      nodes: mockReport.graph.nodes.filter((node) => !node.drifted),
      edges: mockReport.graph.edges.filter((edge) =>
        mockReport.graph.nodes.some((node) => node.id === edge.target && !node.drifted),
      ),
    },
    drifts: [],
    skipped: [],
    warnings: [],
  }
}

/** Demo variant where one project failed, for the partial-result path. */
export function partialMockReport(): Report {
  const failed = 'service-c'
  const remaining = mockReport.drifts
    .map((drift) => ({
      ...drift,
      versions: drift.versions.filter((entry) => entry.repo !== failed),
    }))
    .filter((drift) => new Set(drift.versions.map((entry) => entry.version)).size > 1)
  const remainingIds = new Set(remaining.map((drift) => drift.id))

  return {
    ...mockReport,
    summary: {
      ...mockReport.summary,
      drifts: remaining.length,
      by_risk: countByRisk(remaining),
    },
    repos: mockReport.repos.map((repo) =>
      repo.name === failed
        ? {
            ...repo,
            commit: '',
            manifests: [],
            status: 'error' as const,
            message: 'Branch "feature/axios-upgrade" could not be resolved.',
            code_scan: 'unavailable' as const,
          }
        : repo,
    ),
    graph: {
      nodes: mockReport.graph.nodes
        .filter((node) => node.id !== failed)
        .map((node) =>
          node.type === 'library' && node.drifted && !remainingIds.has(node.id)
            ? { ...node, drifted: false, risk: null }
            : node,
        ),
      edges: mockReport.graph.edges.filter((edge) => edge.source !== failed),
    },
    drifts: remaining,
    warnings: ['1 of 5 projects could not be analyzed'],
  }
}
