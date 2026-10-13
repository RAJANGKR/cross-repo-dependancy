import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ManifestFilename } from '../api/types'
import { MAX_PROJECTS } from '../config'
import { detectManifestType } from '../lib/detectManifestType'
import {
  summarizeInput,
  type FileDraft,
  type InputSummary,
  type InputTab,
  type ProjectDraft,
  type ProjectInputState,
  type RepoChip,
} from '../lib/projectInput'
import { parseRepoUrl, splitUrls } from '../lib/validateRepoUrl'

export interface AddUrlsResult {
  added: number
  duplicates: number
  /** Links left out because the 10 project limit was reached. */
  overLimit: number
}

export interface ProjectInputApi {
  state: ProjectInputState
  summary: InputSummary
  setTab: (tab: InputTab) => void
  addUrls: (text: string) => AddUrlsResult
  removeChip: (id: string) => void
  /** Adds an empty pasted project. Returns false at the project limit. */
  addProject: () => boolean
  removeProject: (id: string) => void
  renameProject: (id: string, name: string) => void
  addFile: (projectId: string) => void
  removeFile: (projectId: string, fileId: string) => void
  setFileContent: (projectId: string, fileId: string, content: string) => void
  setFileType: (projectId: string, fileId: string, type: ManifestFilename) => void
}

const ProjectInputContext = createContext<ProjectInputApi | null>(null)

/**
 * Holds everything the user has entered. It lives above the screens so input
 * survives a cancel or "Analyze again". It is React state only: nothing here is
 * written to localStorage, sessionStorage, IndexedDB, cookies, the URL or logs.
 */
export function ProjectInputProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ProjectInputState>({ tab: 'github', chips: [], projects: [] })
  const idRef = useRef(0)
  const nextId = useCallback((prefix: string) => `${prefix}-${(idRef.current += 1)}`, [])
  const summary = useMemo(() => summarizeInput(state), [state])

  const newFile = useCallback(
    (): FileDraft => ({ id: nextId('file'), type: null, manual: false, content: '' }),
    [nextId],
  )

  const setTab = useCallback((tab: InputTab) => setState((prev) => ({ ...prev, tab })), [])

  const addUrls = useCallback(
    (text: string): AddUrlsResult => {
      const result: AddUrlsResult = { added: 0, duplicates: 0, overLimit: 0 }
      const keys = new Set(state.chips.map((chip) => chip.parsed?.key ?? `raw:${chip.raw}`))
      let count = summary.projectCount
      const additions: RepoChip[] = []

      for (const raw of splitUrls(text)) {
        const parsed = parseRepoUrl(raw)
        const key = parsed?.key ?? `raw:${raw}`
        if (keys.has(key)) {
          result.duplicates += 1
          continue
        }
        if (parsed && count >= MAX_PROJECTS) {
          result.overLimit += 1
          continue
        }
        keys.add(key)
        if (parsed) count += 1
        additions.push({ id: nextId('chip'), raw, parsed })
        result.added += 1
      }

      if (additions.length > 0) {
        setState((prev) => ({ ...prev, chips: [...prev.chips, ...additions] }))
      }
      return result
    },
    [state.chips, summary.projectCount, nextId],
  )

  const removeChip = useCallback(
    (id: string) =>
      setState((prev) => ({ ...prev, chips: prev.chips.filter((chip) => chip.id !== id) })),
    [],
  )

  const updateProject = useCallback(
    (id: string, change: (project: ProjectDraft) => ProjectDraft) =>
      setState((prev) => ({
        ...prev,
        projects: prev.projects.map((project) => (project.id === id ? change(project) : project)),
      })),
    [],
  )

  const addProject = useCallback((): boolean => {
    if (summary.projectCount >= MAX_PROJECTS) return false
    const project: ProjectDraft = { id: nextId('project'), name: '', files: [newFile()] }
    setState((prev) => ({ ...prev, projects: [...prev.projects, project] }))
    return true
  }, [summary.projectCount, nextId, newFile])

  const removeProject = useCallback(
    (id: string) =>
      setState((prev) => ({
        ...prev,
        projects: prev.projects.filter((project) => project.id !== id),
      })),
    [],
  )

  const renameProject = useCallback(
    (id: string, name: string) => updateProject(id, (project) => ({ ...project, name })),
    [updateProject],
  )

  const addFile = useCallback(
    (projectId: string) =>
      updateProject(projectId, (project) => ({ ...project, files: [...project.files, newFile()] })),
    [updateProject, newFile],
  )

  const removeFile = useCallback(
    (projectId: string, fileId: string) =>
      updateProject(projectId, (project) => ({
        ...project,
        files: project.files.filter((file) => file.id !== fileId),
      })),
    [updateProject],
  )

  const setFileContent = useCallback(
    (projectId: string, fileId: string, content: string) =>
      updateProject(projectId, (project) => ({
        ...project,
        files: project.files.map((file) =>
          file.id === fileId
            ? { ...file, content, type: file.manual ? file.type : detectManifestType(content) }
            : file,
        ),
      })),
    [updateProject],
  )

  const setFileType = useCallback(
    (projectId: string, fileId: string, type: ManifestFilename) =>
      updateProject(projectId, (project) => ({
        ...project,
        files: project.files.map((file) =>
          file.id === fileId ? { ...file, type, manual: true } : file,
        ),
      })),
    [updateProject],
  )

  const value = useMemo<ProjectInputApi>(
    () => ({
      state,
      summary,
      setTab,
      addUrls,
      removeChip,
      addProject,
      removeProject,
      renameProject,
      addFile,
      removeFile,
      setFileContent,
      setFileType,
    }),
    [
      state,
      summary,
      setTab,
      addUrls,
      removeChip,
      addProject,
      removeProject,
      renameProject,
      addFile,
      removeFile,
      setFileContent,
      setFileType,
    ],
  )

  return <ProjectInputContext.Provider value={value}>{children}</ProjectInputContext.Provider>
}

export function useProjectInput(): ProjectInputApi {
  const api = useContext(ProjectInputContext)
  if (!api) throw new Error('useProjectInput must be used inside <ProjectInputProvider>')
  return api
}
