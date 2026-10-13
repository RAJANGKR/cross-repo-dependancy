import type { AnalyzeRequest, ManifestFilename } from '../api/types'
import { MAX_PROJECTS } from '../config'
import { validateManifestContent } from './detectManifestType'
import type { ParsedRepo } from './validateRepoUrl'

export type InputTab = 'github' | 'paste'

export interface RepoChip {
  id: string
  /** What the user typed, kept so an invalid chip can be edited. */
  raw: string
  parsed: ParsedRepo | null
}

export interface FileDraft {
  id: string
  type: ManifestFilename | null
  /** True once the user picked a type by hand; auto-detect then stops. */
  manual: boolean
  content: string
}

export interface ProjectDraft {
  id: string
  name: string
  files: FileDraft[]
}

export interface ProjectInputState {
  tab: InputTab
  chips: RepoChip[]
  projects: ProjectDraft[]
}

export interface ProjectValidation {
  nameError: string | null
  fileErrors: Record<string, string | null>
  /** At least one file has content. */
  hasContent: boolean
  valid: boolean
}

export function validateProject(project: ProjectDraft, otherNames: readonly string[]): ProjectValidation {
  const name = project.name.trim()
  let nameError: string | null = null
  if (!name) nameError = 'Enter a project name'
  else if (otherNames.some((other) => other.toLowerCase() === name.toLowerCase())) {
    nameError = 'This name is already used by another project'
  }

  const fileErrors: Record<string, string | null> = {}
  let hasContent = false
  for (const file of project.files) {
    if (file.content.trim() === '') {
      fileErrors[file.id] = null
      continue
    }
    hasContent = true
    fileErrors[file.id] =
      file.type === null
        ? 'Could not detect, choose a type'
        : validateManifestContent(file.type, file.content)
  }

  const valid =
    nameError === null && hasContent && Object.values(fileErrors).every((error) => error === null)
  return { nameError, fileErrors, hasContent, valid }
}

export interface InputSummary {
  validChips: RepoChip[]
  invalidChipCount: number
  validations: Record<string, ProjectValidation>
  invalidProjectCount: number
  /** Valid GitHub chips plus pasted project cards. */
  projectCount: number
  atLimit: boolean
  canAnalyze: boolean
  /** Why the analyze button is disabled, or null when it is enabled. */
  blockedReason: string | null
}

export function summarizeInput(state: ProjectInputState): InputSummary {
  const validChips = state.chips.filter((chip) => chip.parsed !== null)
  const invalidChipCount = state.chips.length - validChips.length
  const repoNames = validChips.map((chip) => chip.parsed?.repo ?? '')

  const validations: Record<string, ProjectValidation> = {}
  for (const project of state.projects) {
    const otherNames = [
      ...repoNames,
      ...state.projects.filter((other) => other.id !== project.id).map((other) => other.name.trim()),
    ].filter((name) => name !== '')
    validations[project.id] = validateProject(project, otherNames)
  }
  const invalidProjectCount = Object.values(validations).filter((item) => !item.valid).length
  const projectCount = validChips.length + state.projects.length
  const validProjectCount = projectCount - invalidProjectCount

  let blockedReason: string | null = null
  if (projectCount === 0) blockedReason = 'Add at least one project to analyze'
  else if (invalidChipCount > 0) blockedReason = 'Fix or remove the invalid link first'
  else if (invalidProjectCount > 0) blockedReason = 'Finish or remove the incomplete pasted project first'
  else if (validProjectCount === 0) blockedReason = 'Add at least one project to analyze'

  return {
    validChips,
    invalidChipCount,
    validations,
    invalidProjectCount,
    projectCount,
    atLimit: projectCount >= MAX_PROJECTS,
    canAnalyze: blockedReason === null,
    blockedReason,
  }
}

/**
 * Builds the POST /api/analyze body. This is the only place pasted content
 * leaves React state, and it goes nowhere except the request body.
 */
export function buildAnalyzeRequest(state: ProjectInputState): AnalyzeRequest {
  return {
    repos: state.chips.flatMap((chip) => (chip.parsed ? [chip.parsed.url] : [])),
    pasted: state.projects.map((project) => ({
      project: project.name.trim(),
      files: project.files.flatMap((file) =>
        file.type !== null && file.content.trim() !== ''
          ? [{ filename: file.type, content: file.content }]
          : [],
      ),
    })),
  }
}
