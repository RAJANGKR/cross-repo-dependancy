import { MANIFEST_FILENAMES, type ManifestFilename, type PastedFile, type ScanCreateRequest } from '../api/scanTypes'
import { DEFAULT_REPO_LABELS, MAX_PASTED_FILE_BYTES, MAX_REPOS, MIN_REPOS } from '../config'
import { parseRepoUrl, type ParsedRepo } from './validateRepoUrl'

/** One GitHub row of the form. */
export interface RepoRow {
  id: string
  label: string
  url: string
  /** Optional branch or tag. A /tree/ link in the URL takes precedence. */
  ref: string
}

export interface FileDraft {
  id: string
  filename: ManifestFilename | null
  /** True once the user picked a type by hand; auto-detect then stops. */
  manual: boolean
  content: string
}

/** One pasted project. Its content lives in React state only. */
export interface PastedProject {
  id: string
  name: string
  files: FileDraft[]
}

/** A validated target, as submitted. `label` is display-only and never sent. */
export interface ScanTarget {
  kind: 'github' | 'pasted'
  label: string
  /** Repository or project name, which is how the backend keys its results. */
  name: string
  url: string | null
  ref: string | null
  files: PastedFile[]
}

export const ROW_ERRORS = {
  malformed: 'Use a public repository URL such as https://github.com/owner/repo',
  duplicate: 'This repository and branch are already listed above',
} as const

let nextId = 0
export const newId = (prefix: string) => `${prefix}-${(nextId += 1)}`
export const newRow = (index: number): RepoRow => ({ id: newId('row'), label: DEFAULT_REPO_LABELS[index] ?? '', url: '', ref: '' })
export const newFile = (): FileDraft => ({ id: newId('file'), filename: null, manual: false, content: '' })
export const newProject = (): PastedProject => ({ id: newId('project'), name: '', files: [newFile()] })

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*((===|==|>=|<=|~=|!=|>|<)[^#;]+)?(;[^#]*)?(\s+#.*)?$/

/** Guesses the manifest type from pasted content. Returns null when unsure. */
export function detectManifest(content: string): ManifestFilename | null {
  const text = content.trim()
  if (!text) return null
  if (text.startsWith('{')) {
    const json = parseJsonObject(text)
    if (!json) return null
    if ('lockfileVersion' in json || 'packages' in json) return 'package-lock.json'
    return ['dependencies', 'devDependencies', 'peerDependencies', 'name'].some((key) => key in json) ? 'package.json' : null
  }
  if (text.includes('<project') || text.includes('<dependencies')) return 'pom.xml'
  if (/^\[\[package\]\]/m.test(text)) return 'poetry.lock'
  if (/^\[(project|tool\.poetry|build-system)[\].]/m.test(text)) return 'pyproject.toml'
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(#|-r\s|-c\s|-e\s|--)/.test(line))
  return lines.length > 0 && lines.every((line) => REQUIREMENT.test(line)) ? 'requirements.txt' : null
}

export function contentBytes(content: string): number {
  return new TextEncoder().encode(content).length
}

/** Error sentence for one pasted file, or null when it can be sent. */
export function fileError(file: FileDraft): string | null {
  if (file.content.trim() === '') return null
  if (contentBytes(file.content) > MAX_PASTED_FILE_BYTES) return 'This file is over the 200 KB limit and will not be sent'
  if (file.filename === null) return 'Could not detect the file type. Choose one'
  if (file.filename.endsWith('.json') && !parseJsonObject(file.content.trim())) return `This is not valid JSON, so it cannot be read as ${file.filename}`
  return null
}

export interface FormCheck {
  /** One entry per GitHub row: an error sentence, or null. Empty rows are fine. */
  rowErrors: Array<string | null>
  parsed: Array<ParsedRepo | null>
  projectErrors: Record<string, { name: string | null; files: Record<string, string | null> }>
  targets: ScanTarget[]
  /** Why the form cannot be submitted, or null when it can. */
  blocked: string | null
}

/** Validates the whole form and builds the targets it would submit. */
export function checkForm(rows: readonly RepoRow[], projects: readonly PastedProject[]): FormCheck {
  const seen = new Set<string>()
  const targets: ScanTarget[] = []
  const parsed = rows.map((row) => (row.url.trim() === '' ? null : parseRepoUrl(row.url)))
  const rowErrors = rows.map((row, index) => {
    if (row.url.trim() === '') return null
    const repo = parsed[index]
    if (!repo) return ROW_ERRORS.malformed
    const ref = repo.ref ?? (row.ref.trim().replace(/^\/+|\/+$/g, '') || null)
    const key = `${repo.key}@${ref ?? ''}`.toLowerCase()
    if (seen.has(key)) return ROW_ERRORS.duplicate
    seen.add(key)
    targets.push({
      kind: 'github',
      label: row.label.trim() || DEFAULT_REPO_LABELS[index] || repo.repo,
      name: repo.repo,
      url: repo.url,
      ref,
      files: [],
    })
    return null
  })

  const names = new Set(targets.map((target) => target.name.toLowerCase()))
  const projectErrors: FormCheck['projectErrors'] = {}
  let projectProblems = 0
  for (const project of projects) {
    const name = project.name.trim()
    const files: Record<string, string | null> = {}
    for (const file of project.files) files[file.id] = fileError(file)
    const sendable = project.files.filter((file) => file.content.trim() !== '' && file.filename !== null && files[file.id] === null)
    let nameError: string | null = null
    if (!name) nameError = 'Enter a project name'
    else if (names.has(name.toLowerCase())) nameError = 'This name is already used by another project'
    else if (sendable.length === 0 && Object.values(files).every((error) => error === null)) nameError = 'Paste at least one manifest'
    projectErrors[project.id] = { name: nameError, files }
    if (nameError || Object.values(files).some((error) => error !== null)) {
      projectProblems += 1
      continue
    }
    names.add(name.toLowerCase())
    targets.push({
      kind: 'pasted',
      label: name,
      name,
      url: null,
      ref: null,
      files: sendable.map((file) => ({ filename: file.filename as ManifestFilename, content: file.content })),
    })
  }

  const rowProblems = rowErrors.filter((error) => error !== null).length
  let blocked: string | null = null
  if (rowProblems > 0) blocked = `Fix ${rowProblems === 1 ? 'the highlighted link' : `${rowProblems} highlighted links`} first`
  else if (projectProblems > 0) blocked = 'Finish or remove the incomplete pasted project first'
  else if (targets.length < MIN_REPOS) blocked = `Add at least ${MIN_REPOS} repositories or pasted projects to compare`
  else if (targets.length > MAX_REPOS) blocked = `A scan takes at most ${MAX_REPOS} targets`
  return { rowErrors, parsed, projectErrors, targets, blocked }
}

/** The POST /api/v1/scans body. Pasted content goes here and nowhere else. */
export function toScanRequest(targets: readonly ScanTarget[]): ScanCreateRequest {
  return {
    repository_targets: targets.map((target) =>
      target.kind === 'pasted'
        ? { type: 'pasted', name: target.name, files: target.files }
        : { type: 'github', url: target.url ?? '', ...(target.ref ? { ref: target.ref } : {}) },
    ),
  }
}

export const MANIFEST_OPTIONS = MANIFEST_FILENAMES

export const EXAMPLE_MANIFESTS: Partial<Record<ManifestFilename, string>> = {
  'package.json': '{\n  "name": "example-service",\n  "dependencies": {\n    "axios": "^0.27.2",\n    "lodash": "^4.17.20"\n  }\n}',
  'requirements.txt': '# example service\npydantic==1.10.13\nrequests>=2.25,<2.26',
  'pyproject.toml': '[project]\nname = "example-service"\ndependencies = ["pydantic>=2.5,<3", "fastapi>=0.110"]',
  'pom.xml': '<project>\n  <dependencies>\n    <dependency>\n      <groupId>com.fasterxml.jackson.core</groupId>\n      <artifactId>jackson-databind</artifactId>\n      <version>2.9.10</version>\n    </dependency>\n  </dependencies>\n</project>',
}
