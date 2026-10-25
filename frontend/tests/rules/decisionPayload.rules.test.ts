import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { addDoc, collection, getDoc, Timestamp } from 'firebase/firestore'
import { ACTION_LOGS_COLLECTION } from '@/lib/firebase/firestore'
import { ACTION_TYPES } from '@/lib/validations/actionLog'
import { buildActionLogData } from '@/features/incidents/decisions'
import {
  ALICE,
  ALICE_INCIDENT,
  BOB,
  BOB_INCIDENT,
  createTestEnv,
  seedIncidents,
  validActionLog,
  verifiedUser,
} from './helpers'

// The payload the app will write (buildActionLogData) against the real rules,
// and the rationale checks on both sides compared case by case: the client
// must never accept a note the rules refuse, nor refuse one they accept.
//
// Findings these tests pin down (local emulator, rules unchanged):
// - The rules' size() counts UTF-16 code units, like String.length — not
//   code points or UTF-8 bytes — so the 10–500 limits mean the same on both sides.
// - The rules' trim() removes every character up to U+0020, including control
//   characters JavaScript's trim() keeps (U+0000, U+0001, U+001F …), and keeps
//   Unicode whitespace JavaScript removes (no-break space, U+2028, U+FEFF …).
//   trimNote() removes both sets, so `note == note.trim()` holds for every note
//   the client accepts.

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
  await seedIncidents(env, [
    { id: ALICE_INCIDENT, ownerUid: ALICE },
    { id: BOB_INCIDENT, ownerUid: BOB },
  ])
})

const NOTE = 'Checked the simulated outage evidence.'

function write(data: Record<string, unknown>) {
  return addDoc(collection(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION), data)
}

function built(input: unknown, incidentId = ALICE_INCIDENT) {
  const result = buildActionLogData(ALICE, incidentId, input)
  if (!result.ok) throw new Error(`expected a payload, got ${JSON.stringify(result.issues)}`)
  return result.data
}

describe('decision payload — what buildActionLogData produces passes the rules', () => {
  it.each(ACTION_TYPES)(
    'a %s decision is accepted and stored with exactly the six fields',
    async (actionType) => {
      const ref = await assertSucceeds(write(built({ actionType, note: NOTE })))
      const saved = (await getDoc(ref)).data()

      expect(Object.keys(saved ?? {}).sort()).toEqual(
        ['_schemaVersion', 'actionType', 'createdAt', 'incidentId', 'note', 'ownerUid'].sort()
      )
      expect(saved).toMatchObject({
        ownerUid: ALICE,
        incidentId: ALICE_INCIDENT,
        actionType,
        note: NOTE,
        _schemaVersion: 1,
      })
      // The server filled in its own time for the serverTimestamp() sentinel.
      expect(saved?.createdAt).toBeInstanceOf(Timestamp)
    }
  )

  it("a well-formed payload for another operator's incident is still refused — the rules decide, not the client", async () => {
    await assertFails(write(built({ actionType: 'REVIEWED', note: NOTE }, BOB_INCIDENT)))
  })
})

const EMOJI = '\u{1F600}' // two UTF-16 code units
const E_ACUTE = 'é' // two code points, one visible character

/** [label, raw rationale, whether both sides must accept it] */
const RATIONALES: Array<[string, string, 'accept' | 'reject']> = [
  // Length, in UTF-16 code units on both sides.
  ['exactly 10 characters', 'a'.repeat(10), 'accept'],
  ['exactly 500 characters', 'a'.repeat(500), 'accept'],
  ['9 characters', 'a'.repeat(9), 'reject'],
  ['501 characters', 'a'.repeat(501), 'reject'],
  ['an empty string', '', 'reject'],
  ['5 emoji (10 code units)', EMOJI.repeat(5), 'accept'],
  ['4 emoji (8 code units)', EMOJI.repeat(4), 'reject'],
  ['250 emoji (500 code units)', EMOJI.repeat(250), 'accept'],
  ['251 emoji (502 code units)', EMOJI.repeat(251), 'reject'],
  ['5 combining accents (10 code units)', E_ACUTE.repeat(5), 'accept'],
  ['500 two-byte UTF-8 letters', 'é'.repeat(500), 'accept'],
  // Whitespace the client trims away.
  ['a leading space', ` ${NOTE}`, 'accept'],
  ['a trailing space and newline', `${NOTE} \n`, 'accept'],
  ['a trailing tab', `${NOTE}\t`, 'accept'],
  ['a trailing carriage return', `${NOTE}\r`, 'accept'],
  ['a leading no-break space', ` ${NOTE}`, 'accept'],
  ['a trailing no-break space', `${NOTE} `, 'accept'],
  ['a trailing line separator (U+2028)', `${NOTE} `, 'accept'],
  ['a trailing byte-order mark (U+FEFF)', `${NOTE}﻿`, 'accept'],
  ['a trailing ideographic space (U+3000)', `${NOTE}　`, 'accept'],
  // Control characters: the rules' trim() strips them, so the client must too.
  ['a trailing U+0001', `${NOTE}\u0001`, 'accept'],
  ['a trailing U+001F', `${NOTE}\u001f`, 'accept'],
  ['a leading U+0000', `\u0000${NOTE}`, 'accept'],
  ['mixed control and Unicode whitespace at both ends', `\u0001  ${NOTE}　\u0002`, 'accept'],
  ['9 characters padded with control characters', `\u0001${'a'.repeat(9)}\u0001`, 'reject'],
  // Kept as they are by both sides.
  ['a trailing DEL (U+007F)', `${NOTE}\u007f`, 'accept'],
  ['a trailing next-line (U+0085)', `${NOTE}\u0085`, 'accept'],
  ['a trailing zero-width space (U+200B)', `${NOTE}​`, 'accept'],
  ['an inner no-break space', 'Checked the evidence.', 'accept'],
  ['an inner control character', 'Checked\u0001the evidence.', 'accept'],
  // Nothing left after trimming.
  ['only spaces', ' '.repeat(12), 'reject'],
  ['only no-break spaces', ' '.repeat(12), 'reject'],
  ['only control characters', '\u0001'.repeat(12), 'reject'],
  // Multi-line rationales.
  ['two lines (LF)', 'Line one of the note.\nLine two.', 'accept'],
  ['two lines (CRLF)', 'Line one of the note.\r\nLine two.', 'accept'],
]

describe('rationale — client validation and the rules agree', () => {
  it.each(RATIONALES)('%s: both sides %s', async (_label, raw, expected) => {
    const client = buildActionLogData(ALICE, ALICE_INCIDENT, { actionType: 'REVIEWED', note: raw })
    expect(client.ok).toBe(expected === 'accept')

    // Accepted: write exactly what the client built. Refused: write the
    // JavaScript-trimmed note, the closest well-formed attempt, to show the
    // rules refuse it too.
    const payload = client.ok
      ? client.data
      : validActionLog({ actionType: 'REVIEWED', note: raw.trim() })
    if (expected === 'accept') await assertSucceeds(write(payload))
    else await assertFails(write(payload))
  })

  it('an accepted note is written exactly as the client trimmed it', async () => {
    const ref = await assertSucceeds(
      write(built({ actionType: 'ACKNOWLEDGE', note: `\u0001  ${NOTE}\n\u0002` }))
    )
    expect((await getDoc(ref)).data()?.note).toBe(NOTE)
  })
})

describe('rules behaviour the client relies on (notes written directly, bypassing the client)', () => {
  it('size() counts UTF-16 code units: 5 emoji meet the 10-character minimum', async () => {
    await assertSucceeds(write(validActionLog({ note: EMOJI.repeat(5) })))
  })

  it('size() counts UTF-16 code units: 251 emoji exceed the 500-character maximum', async () => {
    await assertFails(write(validActionLog({ note: EMOJI.repeat(251) })))
  })

  it('trim() strips a trailing control character, so an untrimmed U+0001 is refused', async () => {
    await assertFails(write(validActionLog({ note: `${NOTE}\u0001` })))
  })

  it('trim() keeps a trailing no-break space, so the rules alone would accept it', async () => {
    await assertSucceeds(write(validActionLog({ note: `${NOTE} ` })))
  })
})
