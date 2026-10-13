import { ExternalLink, Quote, Sparkles } from 'lucide-react'
import type { ChangelogEvidence } from '../../api/scanTypes'
import { hostOf, safeHttpsUrl } from '../../lib/formatters'
import { CopyButton } from './CopyButton'

/** Source code or a spec fragment, shown as plain text with a copy button. */
export function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative rounded-md border border-border bg-secondary">
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
      <CopyButton text={code} label={label} iconOnly className="absolute right-1 top-1" />
    </div>
  )
}

/**
 * Release-note evidence for one package. The cited excerpt (from the release
 * notes) and the interpretation (written by an AI model) are kept visibly
 * apart, and the absence of evidence is stated instead of being left blank.
 *
 * `concise` is for lists of many packages, where the card already states that
 * compatibility was not verified: missing text is then one short fact instead
 * of a paragraph repeated on every card.
 */
export function ReleaseEvidenceBody({ evidence, concise = false }: { evidence: ChangelogEvidence | null; concise?: boolean }) {
  if (!evidence) {
    return (
      <p className="text-sm text-muted-foreground">
        {concise ? 'No release-note text was returned for this package.' : 'No release evidence was returned for this package. That means it was not assessed, not that it is safe.'}
      </p>
    )
  }
  const link = safeHttpsUrl(evidence.source_url)
  return (
    <div className="space-y-4">
      {evidence.cited_excerpt ? (
        <figure>
          <figcaption className="flex items-center gap-1.5 font-mono text-xs uppercase text-muted-foreground">
            <Quote aria-hidden="true" className="size-3.5" />
            Release note excerpt
          </figcaption>
          <blockquote className="mt-2 border-l-2 border-foreground/30 pl-4 leading-relaxed">
            {evidence.cited_excerpt}
          </blockquote>
        </figure>
      ) : (
        <p className="text-sm text-muted-foreground">
          {concise ? 'No release-note text was retrieved for these versions.' : 'No release-note text was retrieved for these versions, so nothing confirms or rules out a break.'}
        </p>
      )}

      <p className="text-sm">
        {evidence.verified_breaking
          ? 'The backend marks this excerpt as stating a breaking change.'
          : 'The backend does not mark this excerpt as stating a breaking change.'}
      </p>

      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-sm underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
        >
          <ExternalLink aria-hidden="true" className="size-3.5" />
          Source: {hostOf(link)}
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">
          {evidence.source_url ? `Source: ${evidence.source_url}` : 'No source link was provided.'}
        </p>
      )}

      {evidence.notes && (
        <div className="rounded-md border border-dashed border-border bg-secondary/60 p-4">
          <p className="flex items-center gap-1.5 font-mono text-xs uppercase text-muted-foreground">
            <Sparkles aria-hidden="true" className="size-3.5" />
            AI interpretation
          </p>
          <p className="mt-2 text-sm leading-relaxed">{evidence.notes}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Written by an AI model from the excerpt above. It is a reading aid, not a finding.
          </p>
        </div>
      )}
    </div>
  )
}
