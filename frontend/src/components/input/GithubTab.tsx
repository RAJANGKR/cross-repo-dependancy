import { Check, CircleX, GitBranch, GitCommitHorizontal, Pencil, Plus, X } from 'lucide-react'
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { MAX_PROJECTS } from '../../config'
import { useProjectInput, type AddUrlsResult } from '../../hooks/useProjectInput'
import { shortCommit } from '../../lib/formatters'
import type { RepoChip as RepoChipModel } from '../../lib/projectInput'
import { Button } from '../common/Button'

/** Resolved branch and commit per cleaned repo URL (lower case), from the last report. */
export type ResolvedRefs = ReadonlyMap<string, { ref: string; commit: string }>

function feedbackFor(result: AddUrlsResult): string {
  const parts: string[] = []
  if (result.duplicates > 0) parts.push('Already added')
  if (result.overLimit > 0) parts.push(`Limit of ${MAX_PROJECTS} projects reached`)
  return parts.join('. ')
}

interface RepoChipProps {
  chip: RepoChipModel
  resolved: { ref: string; commit: string } | undefined
  onRemove: () => void
  onEdit: () => void
}

export function RepoChip({ chip, resolved, onRemove, onEdit }: RepoChipProps) {
  const { parsed } = chip
  if (!parsed) {
    return (
      <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-risk-critical/40 bg-risk-critical-tint px-3 py-2 text-sm">
        <CircleX aria-hidden="true" className="size-4 shrink-0 text-risk-critical" />
        <span className="min-w-0 break-all font-mono text-xs">{chip.raw}</span>
        <span className="text-risk-critical">Needs a public github.com/owner/repo URL</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${chip.raw}`}
            className="rounded-full p-1 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${chip.raw}`}
            className="rounded-full p-1 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      </li>
    )
  }

  const name = `${parsed.owner}/${parsed.repo}`
  const ref = resolved?.ref || parsed.ref
  return (
    <li className="flex items-center gap-2 rounded-full border border-border bg-card py-1.5 pl-3 pr-1.5 text-sm">
      <Check aria-hidden="true" className="size-4 shrink-0 text-success" />
      <span className="sr-only">Valid: </span>
      <span className="font-medium">{name}</span>
      {ref && (
        <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 font-mono text-xs text-muted-foreground">
          <GitBranch aria-hidden="true" className="size-3" />
          <span className="sr-only">Branch </span>
          {ref}
        </span>
      )}
      {resolved?.commit && (
        <span className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground">
          <GitCommitHorizontal aria-hidden="true" className="size-3" />
          <span className="sr-only">Commit </span>
          {shortCommit(resolved.commit)}
        </span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="rounded-full p-1 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  )
}

export function GithubTab({ resolvedRefs }: { resolvedRefs: ResolvedRefs }) {
  const { state, addUrls, removeChip } = useProjectInput()
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const inputId = useId()
  const hintId = useId()

  const commit = (text: string) => {
    if (text.trim() === '') return
    setFeedback(feedbackFor(addUrls(text)))
    setDraft('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault()
      commit(draft)
    }
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    commit(`${draft} ${event.clipboardData.getData('text')}`)
  }

  const editChip = (chip: RepoChipModel) => {
    removeChip(chip.id)
    setDraft(chip.raw)
    setFeedback('')
    inputRef.current?.focus()
  }

  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium">
        GitHub repository links
      </label>
      <div className="mt-2 flex items-start gap-2">
        <textarea
          ref={inputRef}
          id={inputId}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => commit(draft)}
          aria-describedby={hintId}
          placeholder="https://github.com/owner/repo"
          spellCheck={false}
          autoComplete="off"
          className="min-h-16 flex-1 resize-y rounded-md border border-input bg-card px-4 py-3 font-mono text-sm placeholder:text-muted-foreground/70"
        />
        <Button onClick={() => commit(draft)} disabled={draft.trim() === ''} className="mt-1">
          <Plus aria-hidden="true" />
          Add link
        </Button>
      </div>
      <p id={hintId} className="mt-2 text-sm text-muted-foreground">
        Paste several links at once, separated by spaces, commas or new lines. Add /tree/branch-name to
        check unfinished work.
      </p>
      <p role="status" className="mt-1 min-h-5 text-sm text-warning">
        {feedback}
      </p>

      {state.chips.length > 0 && (
        <ul aria-label="GitHub projects" className="mt-2 flex flex-wrap gap-2">
          {state.chips.map((chip) => (
            <RepoChip
              key={chip.id}
              chip={chip}
              resolved={chip.parsed ? resolvedRefs.get(chip.parsed.url.toLowerCase()) : undefined}
              onRemove={() => removeChip(chip.id)}
              onEdit={() => editChip(chip)}
            />
          ))}
        </ul>
      )}

      <p className="mt-6 border-t border-border pt-4 text-sm text-muted-foreground">
        DriftLock reads only what is pushed. Unpushed work is invisible, and unwritten code cannot be
        scanned.
      </p>
    </div>
  )
}
