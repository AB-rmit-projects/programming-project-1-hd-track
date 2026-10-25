import { describe, expect, it } from 'vitest'
import { actionLogInputSchema } from '@/lib/validations/actionLog'

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

  it('counts length in UTF-16 code units, as the rules size() does', () => {
    const emoji = '😀' // 2 code units, 1 code point
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(5) }).success).toBe(true)
    expect(actionLogInputSchema.safeParse({ ...valid, note: emoji.repeat(250) }).success).toBe(true)
    expect(actionLogInputSchema.safeParse({ ...valid, note: `${emoji.repeat(4)}a` }).success).toBe(
      false
    )
    expect(
      actionLogInputSchema.safeParse({ ...valid, note: `${emoji.repeat(250)}a` }).success
    ).toBe(false)
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
