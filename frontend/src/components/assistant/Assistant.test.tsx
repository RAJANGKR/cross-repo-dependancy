// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askAssistant,
  assistantErrorMessage,
  assistantRequest,
  NO_RESULTS_ANSWER,
  parseAssistantReply,
  type AskAssistant,
  type AssistantContext,
  type AssistantReply,
} from '../../api/assistantClient'
import { demoRecord } from '../../api/demoScan'
import { ApiFailure } from '../../api/errors'
import rollouts from '../../api/fixtures/rollout-results.json'
import { parseRolloutResult } from '../../api/rolloutClient'
import type { ScanResult } from '../../api/scanTypes'
import { AssistantWidget, contextKey, contextLine, QUICK_ACTIONS } from './Assistant'

afterEach(cleanup)

const RESULT = demoRecord().result as ScanResult
const NOTHING: AssistantContext = { scan: null, scanId: '', scanSource: 'live', rollout: null, view: 'start' }
const SCAN: AssistantContext = { scan: RESULT, scanId: 'scn_1', scanSource: 'live', rollout: null, view: 'results' }
const ROLLOUT = parseRolloutResult(rollouts.consumer_first)
const ANSWER: AssistantReply = { answer: 'The main problem is react.\nNext step: plan the move to 18.3.1.', source: 'gemini', intent: '', notice: '' }

/** An `ask` whose answer is given by the test, so the loading state can be looked at. */
function pending() {
  const settle: { resolve: (reply: AssistantReply) => void; reject: (error: unknown) => void }[] = []
  const ask = vi.fn<AskAssistant>(() => new Promise<AssistantReply>((resolve, reject) => settle.push({ resolve, reject })))
  return {
    ask,
    answer: (reply: AssistantReply, call = settle.length - 1) => act(async () => settle[call]?.resolve(reply)),
    fail: (error: unknown, call = settle.length - 1) => act(async () => settle[call]?.reject(error)),
  }
}

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open assistant' }))
const popup = () => within(screen.getByRole('dialog', { name: 'DriftLock assistant' }))
const input = () => popup().getByRole('textbox', { name: 'Ask about these results' }) as HTMLInputElement
const sendButton = () => popup().getByRole('button', { name: 'Send' }) as HTMLButtonElement
const type = (text: string) => fireEvent.change(input(), { target: { value: text } })
const log = () => popup().getByRole('log', { name: 'Conversation' })

describe('assistant popup', () => {
  it('is a button in the corner that opens and closes a small chat', () => {
    render(<AssistantWidget context={SCAN} ask={vi.fn<AskAssistant>()} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Open assistant' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.closest('div')?.className).toContain('fixed bottom-4 right-4')

    open()
    expect(popup().getByRole('heading', { name: 'DriftLock assistant' })).toBeTruthy()
    expect(popup().getByText('Hi. I can explain this scan in plain words. Ask a question, or pick one below.')).toBeTruthy()
    expect(popup().getByText('Answering from: Live scan scn_1')).toBeTruthy()
    expect(within(popup().getByRole('list', { name: 'Suggested questions' })).getAllByRole('button').map((chip) => chip.textContent)).toEqual([...QUICK_ACTIONS])
    expect(QUICK_ACTIONS).toEqual(["What's the main problem?", 'What should I do next?', 'Explain this scan', 'What can I improve?'])
    expect(document.activeElement).toBe(input())
    expect(sendButton().disabled).toBe(true)                                       // nothing to send yet
    expect(screen.getByRole('button', { name: 'Hide assistant' }).getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(popup().getByRole('button', { name: 'Close assistant' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Hide assistant' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends a typed question with the results on screen, shows a loading state, then the answer', async () => {
    const { ask, answer } = pending()
    render(<AssistantWidget context={SCAN} ask={ask} />)
    open()
    type('  Why is react flagged?  ')
    expect(sendButton().disabled).toBe(false)
    fireEvent.click(sendButton())

    expect(ask).toHaveBeenCalledTimes(1)
    const [question, history, context] = ask.mock.calls[0] ?? []
    expect(question).toBe('Why is react flagged?')
    expect(history).toEqual([])
    expect(context).toBe(SCAN)                                                       // the results on screen, not a copy of something else
    expect(within(log()).getByText('Why is react flagged?')).toBeTruthy()
    expect(within(log()).getByRole('status').textContent).toBe('Reading the results...')
    expect(input().value).toBe('')
    expect(sendButton().disabled).toBe(true)
    expect(within(popup().getByRole('list', { name: 'Suggested questions' })).getAllByRole('button').every((chip) => (chip as HTMLButtonElement).disabled)).toBe(true)

    await answer(ANSWER)
    expect(within(log()).queryByRole('status')).toBeNull()
    const shown = within(log()).getByText(/The main problem is react\./)
    expect(shown.textContent).toBe('Assistant: The main problem is react.\nNext step: plan the move to 18.3.1.')
    expect(shown.className).toContain('whitespace-pre-line')                         // the model's short lines stay separate lines
    expect(within(log()).getByText('AI answer based on the results on screen. Check it against the evidence.')).toBeTruthy()
  })

  it('sends a suggested question on click, and Enter submits what was typed', async () => {
    const { ask, answer } = pending()
    render(<AssistantWidget context={SCAN} ask={ask} />)
    open()
    fireEvent.click(popup().getByRole('button', { name: 'What should I do next?' }))
    expect(ask.mock.calls[0]?.[0]).toBe('What should I do next?')
    await answer(ANSWER)

    type('And after that?')
    fireEvent.submit(input().closest('form') as HTMLFormElement)
    expect(ask).toHaveBeenCalledTimes(2)
    // A follow-up carries the conversation so far, and the same results.
    const [question, history, context] = ask.mock.calls[1] ?? []
    expect(question).toBe('And after that?')
    expect(history).toEqual([{ role: 'user', content: 'What should I do next?' }, { role: 'assistant', content: ANSWER.answer }])
    expect(context).toBe(SCAN)
  })

  it('labels a fallback once, as evidence-based or as answered without the model, with the reason', async () => {
    const { ask, answer } = pending()
    render(<AssistantWidget context={SCAN} ask={ask} />)
    open()
    fireEvent.click(popup().getByRole('button', { name: 'Explain this scan' }))
    await answer({ answer: 'This scan compared 9 shared package(s) across 3 repositories.', source: 'fallback', intent: 'explain_scan', notice: "Google's AI model is overloaded right now." })
    expect(within(log()).getByText(/This scan compared 9 shared package/)).toBeTruthy()
    expect(within(log()).getByText("Evidence-based fallback: answered by fixed rules from the results on screen. Google's AI model is overloaded right now.")).toBeTruthy()
    expect(within(log()).queryByText(/AI answer based on|does not answer/)).toBeNull()

    // A question outside the results is labelled as answered without the model, not as evidence.
    fireEvent.click(popup().getByRole('button', { name: 'What can I improve?' }))
    await answer({ answer: "I can't help with that. I only know the DriftLock results on screen.", source: 'fallback', intent: 'out_of_scope', notice: "Google's AI model is overloaded right now." })
    expect(within(log()).getByText("Answered without the AI model. Google's AI model is overloaded right now.")).toBeTruthy()
  })

  it('shows an error instead of an answer, and "Try again" asks the same question once more', async () => {
    const { ask, answer, fail } = pending()
    render(<AssistantWidget context={SCAN} ask={ask} />)
    open()
    fireEvent.click(popup().getByRole('button', { name: "What's the main problem?" }))
    await fail(new ApiFailure('network'))

    const alert = within(log()).getByRole('alert')
    expect(alert.textContent).toContain('The assistant could not reach the backend. Check that it is running, then try again.')
    expect(within(log()).queryByRole('status')).toBeNull()
    expect(within(log()).queryByText(/AI answer based on|fallback|without the AI model/)).toBeNull()   // nothing is passed off as an answer
    expect((popup().getByRole('button', { name: 'Explain this scan' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(ask).toHaveBeenCalledTimes(2)
    expect(ask.mock.calls[1]?.[0]).toBe("What's the main problem?")
    expect(ask.mock.calls[1]?.[1]).toEqual([])                                       // the question is not sent twice as history
    expect(within(log()).queryByRole('alert')).toBeNull()
    await answer(ANSWER)
    expect(within(log()).getAllByText("What's the main problem?")).toHaveLength(1)   // and not shown twice
    expect(within(log()).getByText(/The main problem is react\./)).toBeTruthy()
  })

  it('asks for a scan first when there are no results, without calling the backend', () => {
    const ask = vi.fn<AskAssistant>()
    render(<AssistantWidget context={NOTHING} ask={ask} />)
    open()
    expect(popup().getByText('Hi. Run a scan or load the demo run first, then ask me about the results.')).toBeTruthy()
    expect(popup().getByText('No results yet')).toBeTruthy()
    fireEvent.click(popup().getByRole('button', { name: "What's the main problem?" }))
    expect(within(log()).getByText(/Run a scan from the start page, or load the demo run/).textContent).toBe(`Assistant: ${NO_RESULTS_ANSWER}`)
    expect(ask).not.toHaveBeenCalled()
    expect(within(log()).queryByText(/AI answer based on/)).toBeNull()
  })

  it('starts a new conversation when the results change, and drops an answer that was about the old ones', async () => {
    const { ask, answer } = pending()
    const { rerender } = render(<AssistantWidget context={SCAN} ask={ask} />)
    open()
    fireEvent.click(popup().getByRole('button', { name: 'Explain this scan' }))
    await answer(ANSWER)
    fireEvent.click(popup().getByRole('button', { name: 'What can I improve?' }))      // still waiting for this one

    const next: AssistantContext = { ...SCAN, scanId: 'scn_2', rollout: ROLLOUT }
    rerender(<AssistantWidget context={next} ask={ask} />)
    expect(popup().getByText('Answering from: Live scan scn_2 and rollout analysis')).toBeTruthy()
    expect(within(log()).getByText('The results on screen changed, so this is a new conversation.')).toBeTruthy()
    expect(within(log()).queryByText(/The main problem is react\./)).toBeNull()
    expect(within(log()).queryByRole('status')).toBeNull()
    expect(ask.mock.calls[1]?.[3]?.signal?.aborted).toBe(true)

    await answer({ answer: 'An answer about the old scan.', source: 'gemini', intent: '', notice: '' }, 1)
    expect(within(log()).queryByText('An answer about the old scan.')).toBeNull()

    fireEvent.click(popup().getByRole('button', { name: 'What should I do next?' }))
    const [, history, context] = ask.mock.calls[2] ?? []
    expect(history).toEqual([])                                                       // nothing from the other scan is carried over
    expect(context).toBe(next)
  })
})

describe('assistant context', () => {
  it('names what the assistant is answering from, and changes key when that changes', () => {
    expect(contextLine(NOTHING)).toBe('No results yet')
    expect(contextLine({ ...SCAN, scanSource: 'demo', scanId: 'scn_b8' })).toBe('Answering from: Demo data scn_b8')
    expect(contextLine({ ...SCAN, scanSource: 'sample' })).toBe('Answering from: Sample data scn_1')
    expect(contextLine({ ...NOTHING, rollout: ROLLOUT })).toBe('Answering from: rollout analysis')
    const keys = [NOTHING, SCAN, { ...SCAN, scanId: 'scn_2' }, { ...SCAN, scanSource: 'demo' as const }, { ...SCAN, rollout: ROLLOUT }, { ...SCAN, rollout: parseRolloutResult(rollouts.neither) }].map(contextKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(contextKey({ ...SCAN })).toBe(contextKey(SCAN))
    expect(contextKey({ ...SCAN, view: 'rollout' })).toBe(contextKey(SCAN))            // moving between screens keeps the conversation
  })
})

describe('assistant client', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const failureOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (reason: unknown) => reason)
    if (!(error instanceof ApiFailure)) throw new Error('Expected an ApiFailure')
    return error
  }

  it('builds a bounded request from the results on screen', () => {
    const history = Array.from({ length: 11 }, (_, index) => ({ role: index % 2 === 0 ? ('user' as const) : ('assistant' as const), content: `turn ${index} ${'x'.repeat(3000)}` }))
    const body = assistantRequest(`  ${'q'.repeat(700)}  `, history, { scan: RESULT, scanId: 'scn_1', scanSource: 'sample', rollout: ROLLOUT, view: 'rollout' })
    expect(body.message).toHaveLength(600)
    expect(body.history).toHaveLength(8)
    expect(body.history[0]?.content.startsWith('turn 3 ')).toBe(true)                 // the most recent turns
    expect(body.history.every((turn) => turn.content.length <= 2000)).toBe(true)
    expect(body.context).toMatchObject({ scan_id: 'scn_1', scan_source: 'sample', rollout: ROLLOUT, view: 'rollout' })
    expect(body.context.scan?.drift_matrix).toBe(RESULT.drift_matrix)
    expect(body.context.scan?.contract_analysis).toBe(RESULT.contract_analysis)
    expect(body.context.scan?.graph_summary).toBeNull()                               // not read by the assistant, so not sent
    expect(RESULT.graph_summary).not.toBeNull()                                       // and the result on screen is left as it was
    expect(assistantRequest('hi', [], NOTHING).context).toEqual({ scan: null, scan_id: '', scan_source: 'live', rollout: null, view: 'start' })
    expect(JSON.stringify(body).toLowerCase()).not.toContain('api_key')
  })

  it('posts to /api/v1/assistant/chat and reads the reply', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ ...ANSWER, used: { scan: true, rollout: false } })))
    const reply = await askAssistant('What next?', [], SCAN, { fetchImpl, baseUrl: 'http://backend.test' })
    expect(reply).toEqual(ANSWER)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://backend.test/api/v1/assistant/chat')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('include')
    expect(JSON.parse(String(init?.body))).toMatchObject({ message: 'What next?', history: [], context: { scan_id: 'scn_1', scan_source: 'live' } })
  })

  it('turns every failure into a message, and never into an answer', async () => {
    const ask = (reply: () => Promise<Response>) => failureOf(askAssistant('q', [], SCAN, { fetchImpl: reply, baseUrl: 'http://backend.test', timeoutMs: 30 }))
    expect(assistantErrorMessage(await ask(() => Promise.reject(new TypeError('offline'))))).toBe('The assistant could not reach the backend. Check that it is running, then try again.')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(json({ error_code: 'SIGN_IN_REQUIRED', message: 'Sign in with GitHub to use the assistant.' }, 401))))).toBe('Sign in with GitHub to use the assistant.')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(json({ detail: 'Not Found' }, 404))))).toBe('This backend has no assistant yet. Update and restart the backend, then try again.')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(json({ error_code: 'INVALID_REQUEST', message: 'The request body is not valid: message' }, 400))))).toBe('The request body is not valid: message')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(json({ error_code: 'CONTEXT_TOO_LARGE', message: 'The results sent with this question are too large for the assistant.' }, 413))))).toContain('too large')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(new Response('boom', { status: 500 }))))).toBe('The assistant failed to answer (status 500). Try again.')
    expect(assistantErrorMessage(await ask(() => Promise.resolve(new Response('<html>', { status: 200 }))))).toContain('could not read')
    const slow = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
    expect(assistantErrorMessage(await ask(slow as () => Promise<Response>))).toBe('The assistant took too long to answer. Try again.')
    expect(assistantErrorMessage(new Error('anything else'))).toBe('The assistant could not answer. Try again.')
  })

  it('refuses a reply without text or of an unknown kind', () => {
    expect(parseAssistantReply({ answer: ' ok ', source: 'fallback', intent: 'next_step', notice: 'why' })).toEqual({ answer: 'ok', source: 'fallback', intent: 'next_step', notice: 'why' })
    expect(parseAssistantReply({ answer: 'ok', source: 'gemini' })).toEqual({ answer: 'ok', source: 'gemini', intent: '', notice: '' })
    for (const body of [null, {}, { answer: '', source: 'gemini' }, { answer: 'text' }, { answer: 'text', source: 'made-up' }, { answer: 42, source: 'gemini' }]) {
      expect(() => parseAssistantReply(body)).toThrow(ApiFailure)
    }
  })
})
