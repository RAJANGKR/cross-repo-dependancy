// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { demoRecord } from '../../api/demoScan'
import raw from '../../api/fixtures/backend-scan.json'
import { parseScanRecord } from '../../api/parseScan'
import type { DependencyDrift } from '../../api/scanTypes'
import { TONE_STYLES } from '../../lib/classify'
import { conciseStepFor, EVIDENCE_UNAVAILABLE, nextStepFor } from '../../lib/nextStep'
import { ReleaseEvidence } from './ReleaseEvidence'

afterEach(cleanup)

/** Rows from a response captured from the real backend: four drifted packages, none with release-note text. */
const liveRows = (parseScanRecord(raw).result?.drift_matrix ?? []) as DependencyDrift[]
/** The bundled demo scan has packages with quoted release notes, which the captured response lacks. */
const demoRows = (demoRecord().result?.drift_matrix ?? []) as DependencyDrift[]

const show = (rows: DependencyDrift[], onOpen = vi.fn()) => {
  render(<ReleaseEvidence rows={rows} warnings={[]} repoLabel={(name) => name} onOpen={onOpen} />)
  return onOpen
}
const card = (name: string) => screen.getByRole('heading', { name }).closest('li') as HTMLElement
const collapsed = (element: Element) => element.closest('details:not([open])') !== null && element.closest('summary') === null

describe('risk intelligence cards', () => {
  it('show dependency, risk status, one next action, one reason and the recommended version', () => {
    show(liveRows)
    const axios = within(card('axios'))
    expect(axios.getByText('Suspected breaking').parentElement?.className ?? '').toContain(TONE_STYLES.high.text)
    expect(axios.getByText('Next action')).toBeTruthy()
    expect(axios.getByText('Read the release notes and run tests before aligning to 1.20.0.')).toBeTruthy()
    expect(axios.getByText('Why')).toBeTruthy()
    expect(axios.getByText('The versions are a major release apart and their ranges do not overlap.')).toBeTruthy()
    expect(axios.getByText('Recommended version')).toBeTruthy()
    expect(axios.getByText('1.20.0')).toBeTruthy()
    // All of it is readable without opening anything.
    for (const text of ['Next action', 'Why', 'Recommended version', 'Read the release notes and run tests before aligning to 1.20.0.']) {
      expect(collapsed(axios.getByText(text))).toBe(false)
    }
    // One action per card.
    expect(screen.getAllByText('Next action')).toHaveLength(liveRows.filter((row) => row.drift_disparity !== 'INFO' && row.drift_disparity !== 'IN_SYNC').length)
  })

  it('replace the long missing-evidence paragraphs with one concise, neutral line', () => {
    show(liveRows)
    expect(EVIDENCE_UNAVAILABLE).toBe('Evidence unavailable — compatibility not verified')
    const notes = screen.getAllByText(EVIDENCE_UNAVAILABLE)
    expect(notes).toHaveLength(4)                                   // once per card, since no card has release-note text
    for (const note of notes) {
      expect(collapsed(note)).toBe(false)
      expect(note.className).toContain('text-muted-foreground')     // neutral: not a finding, not an all-clear
      expect(note.className).not.toContain('risk-low')
    }
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/No release evidence was returned for this package/)
    expect(text).not.toMatch(/not that it is safe|nothing confirms or rules out a break/)
    // An unknown-impact package is still named as unknown and still gets an action.
    const requests = within(card('requests'))
    expect(requests.getByText('Unknown impact')).toBeTruthy()
    expect(requests.getByText('Run a compatibility test before aligning to 2.31.0.')).toBeTruthy()
    expect(requests.queryByText(/No issue/)).toBeNull()
  })

  it('keep the release evidence and the full explanation behind "View release evidence"', () => {
    show(demoRows)
    const confirmed = demoRows.find((row) => row.compatibility_risk === 'CONFIRMED_BREAKING' && row.evidence?.cited_excerpt) as DependencyDrift
    const item = card(confirmed.dependency_name)
    const details = item.querySelector('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect(within(item).getByText('View release evidence')).toBeTruthy()
    const excerpt = within(item).getByText(confirmed.evidence?.cited_excerpt ?? '')
    const full = within(item).getByText(nextStepFor(confirmed) ?? '')
    const versions = within(item).getByText('Versions in use')
    for (const hidden of [excerpt, full, versions, within(item).getByText('Generated from rules, based on the classification above.')]) {
      expect(collapsed(hidden)).toBe(true)
    }
    details.open = true
    expect(collapsed(excerpt)).toBe(false)
    // A confirmed break is stated as such and is not followed by "compatibility not verified".
    expect(within(item).getByText('Release notes state a breaking change.')).toBeTruthy()
    expect(within(item).queryByText(EVIDENCE_UNAVAILABLE)).toBeNull()
  })

  it('still open the full detail panel', () => {
    const onOpen = show(liveRows)
    fireEvent.click(within(card('axios')).getByRole('button', { name: /Open details/ }))
    expect(onOpen).toHaveBeenCalledWith('npm:axios')
  })

  it('derive the short action from the classification and never call missing evidence safe', () => {
    const base = liveRows.find((row) => row.dependency_name === 'axios') as DependencyDrift
    const step = (patch: Partial<DependencyDrift>) => conciseStepFor({ ...base, ...patch })
    expect(step({ compatibility_risk: 'UNKNOWN_IMPACT' })).toEqual({ action: 'Run a compatibility test before aligning to 1.20.0.', reason: '', evidenceUnavailable: true })
    expect(step({ compatibility_risk: 'NONE' })).toEqual({ action: 'Align to 1.20.0 at the next routine update.', reason: 'No issue was identified.', evidenceUnavailable: true })
    expect(step({ compatibility_risk: 'NONE', recommended_version: null })?.action).toBe('Align on one version at the next routine update.')
    // A break confirmed by a migration rule, without release-note text, is not described as unverified.
    expect(step({ compatibility_risk: 'CONFIRMED_BREAKING', evidence: null })).toEqual({ action: 'Plan a code change before upgrading to 1.20.0.', reason: 'A breaking change is confirmed for these versions.', evidenceUnavailable: false })
    expect(step({ compatibility_risk: 'SOMETHING_NEW' })?.action).toBe('Review this drift manually before aligning to 1.20.0.')
    expect(step({ drift_disparity: 'IN_SYNC' })).toBeNull()
    for (const risk of ['CONFIRMED_BREAKING', 'SUSPECTED_BREAKING', 'UNKNOWN_IMPACT', 'NONE', 'SOMETHING_NEW']) {
      const made = step({ compatibility_risk: risk })
      expect(`${made?.action} ${made?.reason}`).not.toMatch(/\bsafe\b|compatible\b/i)
    }
  })
})
