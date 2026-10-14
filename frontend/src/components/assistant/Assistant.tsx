import { LoaderCircle, MessageCircle, SendHorizontal, X } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  askAssistant,
  assistantErrorMessage,
  hasContext,
  MAX_ASSISTANT_MESSAGE,
  NO_RESULTS_ANSWER,
  type AskAssistant,
  type AssistantContext,
  type AssistantSource,
  type AssistantTurn,
  SCOPE_INTENTS,
} from '../../api/assistantClient'
import { isCancelled } from '../../api/errors'
import { useRolloutMemory } from '../../hooks/useRolloutMemory'
import { useRoute } from '../../hooks/useRoute'
import { useScan } from '../../hooks/useScan'
import { cx } from '../../lib/cx'
import { SOURCE_LABELS } from '../../lib/exportMarkdown'

export const QUICK_ACTIONS = ["What's the main problem?", 'What should I do next?', 'Explain this scan', 'What can I improve?'] as const

interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
  source?: AssistantSource
  intent?: string
  notice?: string
}

/** What the assistant is answering from, in words. Shown in the header so an answer is never read against the wrong results. */
export function contextLine(context: AssistantContext): string {
  const parts: string[] = []
  if (context.scan) parts.push(`${SOURCE_LABELS[context.scanSource]} ${context.scanId}`.trim())
  if (context.rollout) parts.push('rollout analysis')
  return parts.length > 0 ? `Answering from: ${parts.join(' and ')}` : 'No results yet'
}

/** Changes whenever the results on screen do, so one conversation never spans two sets of results. */
export function contextKey(context: AssistantContext): string {
  const rollout = context.rollout
  return [context.scan ? `${context.scanSource}:${context.scanId}` : '', rollout ? `${rollout.recommendation}:${rollout.refs.map((ref) => ref.commit || ref.ref).join(',')}` : ''].join('|')
}

function greeting(context: AssistantContext): string {
  if (context.scan) return 'Hi. I can explain this scan in plain words. Ask a question, or pick one below.'
  if (context.rollout) return 'Hi. I can explain the rollout analysis on screen. Ask a question, or pick one below.'
  return 'Hi. Run a scan or load the demo run first, then ask me about the results.'
}

/**
 * The line under an answer: how it was made. A fallback says so once, with the
 * reason the model was not used; whether it answered the question is said in
 * the answer itself.
 */
export function answerLabel(message: Pick<Message, 'source' | 'intent' | 'notice'>): string {
  if (message.source === 'gemini') return 'AI answer based on the results on screen. Check it against the evidence.'
  if (message.source !== 'fallback') return ''
  const kind = (SCOPE_INTENTS as readonly string[]).includes(message.intent ?? '')
    ? 'Answered without the AI model.'
    : 'Evidence-based fallback: answered by fixed rules from the results on screen.'
  return message.notice ? `${kind} ${message.notice}` : kind
}

interface AssistantWidgetProps {
  context: AssistantContext
  ask?: AskAssistant
}

/**
 * The assistant: a button in the bottom-right corner that opens a small chat
 * about the results on screen. It sends the question with those results to the
 * backend and shows what comes back. It adds nothing of its own to an answer.
 */
export function AssistantWidget({ context, ask = askAssistant }: AssistantWidgetProps) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; question: string } | null>(null)
  const [restarted, setRestarted] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const nextId = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const key = contextKey(context)

  // New results, new conversation: earlier answers were about something else.
  const lastKey = useRef(key)
  const asked = useRef(false)
  asked.current = messages.length > 0
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    controller.current?.abort()
    controller.current = null
    setBusy(false)
    setError(null)
    setRestarted(asked.current)
    setMessages([])
  }, [key])

  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [messages, busy, error])

  const add = useCallback((message: Omit<Message, 'id'>) => {
    nextId.current += 1
    const id = nextId.current
    setMessages((current) => [...current, { ...message, id }])
  }, [])

  const send = useCallback(
    async (raw: string, retry = false) => {
      const question = raw.trim().slice(0, MAX_ASSISTANT_MESSAGE)
      if (!question || busy) return
      setError(null)
      setRestarted(false)
      setInput('')
      const history: AssistantTurn[] = messages.map((message) => ({ role: message.role, content: message.text }))
      if (!retry) add({ role: 'user', text: question })
      // Without results there is nothing to send: the answer is the same wherever it is given.
      if (!hasContext(context)) {
        add({ role: 'assistant', text: NO_RESULTS_ANSWER, source: 'no_context' })
        return
      }
      const current = new AbortController()
      controller.current = current
      setBusy(true)
      try {
        const reply = await ask(question, retry ? history.slice(0, -1) : history, context, { signal: current.signal })
        if (controller.current !== current) return
        add({ role: 'assistant', text: reply.answer, source: reply.source, intent: reply.intent, notice: reply.notice })
      } catch (failure) {
        if (controller.current !== current || isCancelled(failure)) return
        setError({ text: assistantErrorMessage(failure), question })
      } finally {
        if (controller.current === current) {
          controller.current = null
          setBusy(false)
        }
      }
    },
    [add, ask, busy, context, messages],
  )

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void send(input)
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      setOpen(false)
    }
  }

  const line = useMemo(() => contextLine(context), [context])

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3 print:hidden">
      {open && (
        <section
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={onKeyDown}
          className="pointer-events-auto flex max-h-[min(34rem,calc(100vh-6.5rem))] w-[min(24rem,calc(100vw-2rem))] animate-fade-in flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-pop"
        >
          <header className="flex items-start gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 id={titleId} className="text-sm font-medium">
                DriftLock assistant
              </h2>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={line}>
                {line}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="rounded-full p-1.5 text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </header>

          <div ref={logRef} role="log" aria-live="polite" aria-label="Conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-sm">
            {restarted && <p className="text-xs text-muted-foreground">The results on screen changed, so this is a new conversation.</p>}
            <p className="max-w-[90%] rounded-lg border border-border bg-background px-3 py-2">{greeting(context)}</p>
            {messages.map((message) =>
              message.role === 'user' ? (
                <p key={message.id} className="ml-auto w-fit max-w-[85%] whitespace-pre-line break-words rounded-lg bg-secondary px-3 py-2">
                  <span className="sr-only">You: </span>
                  {message.text}
                </p>
              ) : (
                <div key={message.id} className="max-w-[90%]">
                  <p className="whitespace-pre-line break-words rounded-lg border border-border bg-background px-3 py-2">
                    <span className="sr-only">Assistant: </span>
                    {message.text}
                  </p>
                  {answerLabel(message) && <p className="mt-1 px-1 text-xs text-muted-foreground">{answerLabel(message)}</p>}
                </div>
              ),
            )}
            {busy && (
              <p role="status" className="flex w-fit items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-muted-foreground">
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                Reading the results...
              </p>
            )}
            {error && (
              <div role="alert" className="rounded-lg border border-risk-critical/30 bg-risk-critical-tint px-3 py-2">
                <p>{error.text}</p>
                <button type="button" onClick={() => void send(error.question, true)} className="mt-1 text-xs font-medium underline underline-offset-4">
                  Try again
                </button>
              </div>
            )}
          </div>

          <div className="border-t border-border px-4 py-3">
            <ul aria-label="Suggested questions" className="flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send(question)}
                    className="rounded-full border border-foreground/20 px-2.5 py-1 text-xs transition-colors hover:border-foreground hover:bg-foreground/5 disabled:opacity-50"
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
            <form onSubmit={submit} className="mt-3 flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                maxLength={MAX_ASSISTANT_MESSAGE}
                aria-label="Ask about these results"
                placeholder="Ask about these results"
                autoComplete="off"
                className="h-9 min-w-0 flex-1 rounded-full border border-input bg-background px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-foreground"
              />
              <button
                type="submit"
                disabled={busy || input.trim() === ''}
                aria-label="Send"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
              >
                <SendHorizontal aria-hidden="true" className="size-4" />
              </button>
            </form>
          </div>
        </section>
      )}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={open ? 'Hide assistant' : 'Open assistant'}
        aria-expanded={open}
        title="DriftLock assistant"
        className={cx(
          'pointer-events-auto flex size-12 items-center justify-center rounded-full border border-foreground/20 shadow-pop transition-colors',
          open ? 'bg-card text-foreground hover:bg-secondary' : 'bg-foreground text-background hover:bg-foreground/90',
        )}
      >
        {open ? <X aria-hidden="true" className="size-5" /> : <MessageCircle aria-hidden="true" className="size-5" />}
      </button>
    </div>
  )
}

/** The assistant wired to the app: it reads the completed scan, the latest rollout analysis and the current screen. */
export function Assistant() {
  const { state } = useScan()
  const { rollout } = useRolloutMemory()
  const route = useRoute()
  const done = state.phase === 'done' && state.record.result ? state : null
  const view = route.name === 'rollout' ? 'rollout' : route.name === 'results' ? 'results' : 'start'
  const context = useMemo<AssistantContext>(
    () => ({ scan: done?.record.result ?? null, scanId: done?.record.scan_id ?? '', scanSource: done?.source ?? 'live', rollout, view }),
    [done, rollout, view],
  )
  return <AssistantWidget context={context} />
}
