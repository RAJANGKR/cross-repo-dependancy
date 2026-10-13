import { Plus, Trash2, X } from 'lucide-react'
import { useId, useState } from 'react'
import { MANIFEST_FILENAMES, type ManifestFilename } from '../../api/types'
import { MAX_PASTED_FILE_BYTES, MAX_PROJECTS } from '../../config'
import { useProjectInput } from '../../hooks/useProjectInput'
import { cx } from '../../lib/cx'
import { contentByteSize, EXAMPLE_MANIFESTS } from '../../lib/detectManifestType'
import type { FileDraft, ProjectDraft, ProjectValidation } from '../../lib/projectInput'
import { Banner } from '../common/Banner'
import { Button } from '../common/Button'

const FIELD =
  'rounded-md border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground/70'

function isManifestFilename(value: string): value is ManifestFilename {
  return (MANIFEST_FILENAMES as readonly string[]).includes(value)
}

interface FileEntryProps {
  projectId: string
  file: FileDraft
  index: number
  error: string | null
  removable: boolean
}

function FileEntry({ projectId, file, index, error, removable }: FileEntryProps) {
  const { setFileContent, setFileType, removeFile } = useProjectInput()
  const typeId = useId()
  const contentId = useId()
  const errorId = useId()
  const kilobytes = (contentByteSize(file.content) / 1024).toFixed(1)

  return (
    <div className="rounded-md border border-border bg-background p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={typeId} className="block text-xs text-muted-foreground">
            File type
          </label>
          <select
            id={typeId}
            value={file.type ?? ''}
            onChange={(event) => {
              if (isManifestFilename(event.target.value)) {
                setFileType(projectId, file.id, event.target.value)
              }
            }}
            className={cx(FIELD, 'mt-1 font-mono')}
          >
            <option value="" disabled>
              Choose a type
            </option>
            {MANIFEST_FILENAMES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <p className="pb-2 text-xs text-muted-foreground">
          {file.type && !file.manual && file.content.trim() !== '' ? 'Detected from content' : ''}
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setFileContent(projectId, file.id, EXAMPLE_MANIFESTS[file.manual && file.type ? file.type : 'package.json'])
            }
            className="rounded-sm px-2 py-1 text-xs text-foreground/70 underline decoration-foreground/30 underline-offset-4 hover:text-foreground"
          >
            Insert example
          </button>
          {removable && (
            <button
              type="button"
              onClick={() => removeFile(projectId, file.id)}
              aria-label={`Remove file ${index + 1}`}
              className="rounded-full p-1.5 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      </div>

      <label htmlFor={contentId} className="mt-3 block text-xs text-muted-foreground">
        Manifest content, file {index + 1}
      </label>
      <textarea
        id={contentId}
        rows={6}
        value={file.content}
        onChange={(event) => setFileContent(projectId, file.id, event.target.value)}
        aria-invalid={error !== null}
        aria-describedby={error ? errorId : undefined}
        placeholder="Paste the contents of package.json, requirements.txt or pom.xml"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className={cx(FIELD, 'mt-1 block w-full resize-y font-mono text-xs leading-relaxed', error && 'border-risk-critical')}
      />
      <div className="mt-1 flex flex-wrap justify-between gap-2 text-xs">
        <p id={errorId} role={error ? 'alert' : undefined} className="text-risk-critical">
          {error}
        </p>
        <p className="tabular-nums text-muted-foreground">
          {kilobytes} KB of {MAX_PASTED_FILE_BYTES / 1024} KB
        </p>
      </div>
    </div>
  )
}

interface ProjectCardProps {
  project: ProjectDraft
  index: number
  validation: ProjectValidation | undefined
}

export function ProjectCard({ project, index, validation }: ProjectCardProps) {
  const { renameProject, removeProject, addFile } = useProjectInput()
  const nameId = useId()
  const nameErrorId = useId()
  // Do not flag an empty name before the user has had a chance to type one.
  const [touched, setTouched] = useState(false)
  const nameError = validation?.nameError ?? null
  const showNameError = nameError !== null && (touched || project.name.trim() !== '')
  const title = project.name.trim() || `Project ${index + 1}`

  return (
    <li className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor={nameId} className="block text-sm font-medium">
            Project name
          </label>
          <input
            id={nameId}
            type="text"
            value={project.name}
            onChange={(event) => renameProject(project.id, event.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={showNameError}
            aria-describedby={showNameError ? nameErrorId : undefined}
            placeholder="billing-service"
            autoComplete="off"
            spellCheck={false}
            className={cx(FIELD, 'mt-1 w-full', showNameError && 'border-risk-critical')}
          />
        </div>
        <Button variant="ghost" size="sm" onClick={() => removeProject(project.id)} aria-label={`Remove project ${title}`}>
          <Trash2 aria-hidden="true" />
          Remove project
        </Button>
      </div>
      <p id={nameErrorId} className="mt-1 min-h-4 text-xs text-risk-critical">
        {showNameError ? nameError : ''}
      </p>

      <div className="mt-2 space-y-3">
        {project.files.map((file, fileIndex) => (
          <FileEntry
            key={file.id}
            projectId={project.id}
            file={file}
            index={fileIndex}
            error={validation?.fileErrors[file.id] ?? null}
            removable={project.files.length > 1}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Button size="sm" onClick={() => addFile(project.id)}>
          <Plus aria-hidden="true" />
          Add file
        </Button>
        <p className="text-xs text-muted-foreground">
          Pasted content is only sent to the analysis request. It is not stored.
        </p>
      </div>
    </li>
  )
}

export function PasteTab() {
  const { state, summary, addProject } = useProjectInput()
  const [limitHit, setLimitHit] = useState(false)

  return (
    <div>
      <Banner tone="info">
        Nothing is fetched from GitHub. The code-usage scan is unavailable in this mode. Library names are
        looked up in public registries. Internal package names that aren&apos;t public are skipped.
      </Banner>

      {state.projects.length > 0 && (
        <ul aria-label="Pasted projects" className="mt-4 space-y-4">
          {state.projects.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              index={index}
              validation={summary.validations[project.id]}
            />
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={() => setLimitHit(!addProject())}>
          <Plus aria-hidden="true" />
          Add project
        </Button>
        <p role="status" className="text-sm text-warning">
          {limitHit && summary.atLimit ? `Limit of ${MAX_PROJECTS} projects reached` : ''}
        </p>
      </div>
    </div>
  )
}
