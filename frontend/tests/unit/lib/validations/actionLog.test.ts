import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  actionLogInputSchema,
  INCIDENT_ID_PATTERN,
  incidentIdSchema,
  trimNote,
} from '@/lib/validations/actionLog'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents, incidentDocId } from '../../../../scripts/seed-incidents/dataset'

const valid = { actionType: 'REVIEWED', note: 'Checked the simulated outage evidence.' }

describe('actionLogInputSchema', () => {
  it.each(['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'])('accepts %s', (actionType) => {
    expect(actionLogInputSchema.safeParse({ ...valid, actionType }).success).toBe(true)
  })

  it.each(['CLOSE', 'reviewed', '', undefined])('rejects actionType %s', (actionType) => {
    const result = actionLogInputSchema.safeParse({ ...valid, actionType })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Choose ACKNOWLEDGE, ESCALATE or REVIEWED.')
  })

  it('accepts exactly 10 and exactly 500 characters', () => {
    expect(actionLogInputSchema.safeParse({ ...valid, note: 'a'.repeat(10) }).success).toBe(true)
    expect(actionLogInputSchema.safeParse({ ...valid, note: 'a'.repeat(500) }).success).toBe(true)
  })

  it.each([
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['only whitespace', ' '.repeat(20)],
    ['9 characters padded with spaces', `   ${'a'.repeat(9)}   `],
  ])('rejects a note with %s', (_label, note) => {
    const result = actionLogInputSchema.safeParse({ ...valid, note })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Enter between 10 and 500 characters.')
  })

  it('returns the trimmed note, which is what the Firestore rules require', () => {
    const result = actionLogInputSchema.safeParse({ ...valid, note: '  Checked the evidence.  \n' })
    expect(result.success && result.data.note).toBe('Checked the evidence.')
  })

  it('does not let surrounding whitespace push a long note under the limit', () => {
    const note = `  ${'a'.repeat(500)}  `
    const result = actionLogInputSchema.safeParse({ ...valid, note })
    expect(result.success && result.data.note.length).toBe(500)
  })
})

describe('actionLogInputSchema — trimming matches the Firestore rules', () => {
  // The rules' trim() also strips control characters up to U+0020 that
  // JavaScript's trim() keeps; see tests/rules/decisionPayload.rules.test.ts.
  it.each([
    ['a trailing U+0001', 'Checked the evidence.\u0001'],
    ['a leading U+0000', '\u0000Checked the evidence.'],
    ['a trailing U+001F', 'Checked the evidence.\u001f'],
    ['a leading no-break space', '\u00a0Checked the evidence.'],
    ['mixed characters at both ends', '\u0001\u00a0 Checked the evidence.\u3000\u0002'],
  ])('removes %s', (_label, note) => {
    const result = actionLogInputSchema.safeParse({ ...valid, note })
    expect(result.success && result.data.note).toBe('Checked the evidence.')
  })

  it('rejects a note that is too short once control characters are removed', () => {
    const result = actionLogInputSchema.safeParse({
      ...valid,
      note: `\u0001${'a'.repeat(9)}\u0001`,
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Enter between 10 and 500 characters.')
  })

  it('counts length in UTF-16 code units, as the rules do', () => {
    const emoji = '\u{1F600}'
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(5) }).success).toBe(true)
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(4) }).success).toBe(false)
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(250) }).success).toBe(true)
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(251) }).success).toBe(
      false
    )
  })

  it('rejects a note that is not a string', () => {
    expect(actionLogInputSchema.safeParse({ ...valid, note: 1234567890 }).success).toBe(false)
    expect(actionLogInputSchema.safeParse({ ...valid, note: undefined }).success).toBe(false)
  })
})

describe('trimNote', () => {
  it('keeps inner whitespace, newlines and control characters', () => {
    expect(trimNote('  Line one.\n\u00a0Line\u0001two.  ')).toBe('Line one.\n\u00a0Line\u0001two.')
  })

  it('keeps characters neither side treats as trimmable', () => {
    expect(trimNote('note\u007f')).toBe('note\u007f')
    expect(trimNote('note\u200b')).toBe('note\u200b')
  })

  it('returns an empty string for a note made only of trimmable characters', () => {
    expect(trimNote(' \t\u0001\u00a0\u2028\ufeff ')).toBe('')
  })

  it('does not split a surrogate pair at either end', () => {
    expect(trimNote(' \u{1F600} ')).toBe('\u{1F600}')
  })
})

describe('incidentIdSchema', () => {
  it('accepts every incident ID the Phase 3 seed creates', () => {
    const ids = buildSeedIncidents('demoOperatorUid01', new Date('2026-10-21T00:00:00Z')).map(
      (r) => r.id
    )
    expect(ids).toHaveLength(50)
    for (const id of ids) expect(incidentIdSchema.safeParse(id).success).toBe(true)
  })

  it('accepts the longest seed ID (a 120-character owner UID plus the code)', () => {
    const id = incidentDocId('u'.repeat(120), 'INC-050')
    expect(id).toHaveLength(128)
    expect(incidentIdSchema.safeParse(id).success).toBe(true)
  })

  it.each([
    ['an empty ID', ''],
    ['129 characters', 'a'.repeat(129)],
    ['a slash', 'alice_INC-001/actionLogs'],
    ['path traversal', '../incidents/bob_INC-001'],
    ['a dot', 'alice.INC-001'],
    ['a percent-encoded slash', 'alice%2FINC-001'],
    ['a space', 'alice INC-001'],
    ['a trailing newline', 'alice_INC-001\n'],
    ['a non-ASCII letter', 'alicé_INC-001'],
    ['a query string', 'alice_INC-001?x=1'],
  ])('rejects %s', (_label, id) => {
    const result = incidentIdSchema.safeParse(id)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Invalid incident ID.')
  })

  it.each([undefined, null, 42])('rejects a non-string value (%s)', (id) => {
    expect(incidentIdSchema.safeParse(id).success).toBe(false)
  })

  it('is the same pattern the actionLogs create rule matches against', () => {
    const rules = readFileSync(
      resolve(__dirname, '../../../../../firebase/firestore.rules'),
      'utf8'
    )
    const rulePattern = /incidentId\.matches\('([^']+)'\)/.exec(rules)?.[1]
    // Rules' matches() must match the whole string, so the rule needs no anchors.
    expect(rulePattern).toBe('[A-Za-z0-9_-]{1,128}')
    expect(INCIDENT_ID_PATTERN.source).toBe(`^${rulePattern}$`)
  })
})
