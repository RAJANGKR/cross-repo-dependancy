import { describe, expect, it } from 'vitest'
import { ApiFailure, extractServerMessage, isCancelled, toUiError } from './errors'
import { ReportShapeError } from './parseReport'

describe('toUiError', () => {
  it('maps HTTP 400 to bad-request and keeps the backend message', () => {
    const error = toUiError(new ApiFailure('http', { status: 400, serverMessage: 'Too many projects' }))
    expect(error.kind).toBe('bad-request')
    expect(error.message).toBe('Too many projects')
    expect(error.actions).toContain('edit-input')
  })

  it('maps HTTP 429 to rate-limited with a demo action', () => {
    const error = toUiError(new ApiFailure('http', { status: 429 }))
    expect(error.kind).toBe('rate-limited')
    expect(error.actions).toContain('load-demo')
  })

  it('treats a rate-limit message on another status as rate-limited', () => {
    const error = toUiError(
      new ApiFailure('http', { status: 502, serverMessage: 'GitHub rate limit exceeded' }),
    )
    expect(error.kind).toBe('rate-limited')
  })

  it('maps a network failure to unreachable with retry and demo', () => {
    const error = toUiError(new ApiFailure('network'))
    expect(error.kind).toBe('unreachable')
    expect(error.actions).toEqual(['retry', 'load-demo'])
  })

  it('maps a timeout', () => {
    expect(toUiError(new ApiFailure('timeout')).kind).toBe('timeout')
  })

  it('maps shape mismatches and unknown errors to unexpected-response', () => {
    expect(toUiError(new ApiFailure('shape')).kind).toBe('unexpected-response')
    expect(toUiError(new ReportShapeError('meta')).kind).toBe('unexpected-response')
    expect(toUiError(new TypeError('boom')).kind).toBe('unexpected-response')
  })

  it('maps other HTTP failures to server-error', () => {
    const error = toUiError(new ApiFailure('http', { status: 500 }))
    expect(error.kind).toBe('server-error')
    expect(error.message).toContain('500')
  })
})

describe('isCancelled', () => {
  it('is true only for aborted requests', () => {
    expect(isCancelled(new ApiFailure('aborted'))).toBe(true)
    expect(isCancelled(new ApiFailure('network'))).toBe(false)
    expect(isCancelled(new Error('x'))).toBe(false)
  })
})

describe('extractServerMessage', () => {
  it('reads message, detail and FastAPI validation lists', () => {
    expect(extractServerMessage({ message: 'a' })).toBe('a')
    expect(extractServerMessage({ detail: 'b' })).toBe('b')
    expect(extractServerMessage({ detail: [{ msg: 'c' }, { msg: 'd' }] })).toBe('c. d')
    expect(extractServerMessage('nope')).toBe('')
    expect(extractServerMessage(null)).toBe('')
  })
})
