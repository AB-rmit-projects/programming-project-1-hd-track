import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore'
import {
  ACTION_LOGS_COLLECTION,
  INCIDENTS_COLLECTION,
  actionHistoryConstraints,
  reviewedActionsConstraints,
} from '@/lib/firebase/firestore'
import { ACTION_TYPES } from '@/lib/validations/actionLog'
import {
  ALICE,
  ALICE_INCIDENT,
  BOB,
  BOB_INCIDENT,
  anonymousVisitor,
  createTestEnv,
  dbOf,
  incidentFixture,
  seedActionLog,
  seedDataset,
  seedIncidents,
  unverifiedUser,
  validActionLog,
  verifiedUser,
} from './helpers'

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
    { id: `${ALICE}_INC-002`, ownerUid: ALICE },
    { id: BOB_INCIDENT, ownerUid: BOB },
  ])
})

function create(db: Firestore, data: Record<string, unknown>) {
  return addDoc(collection(db, ACTION_LOGS_COLLECTION), data)
}

const at = (iso: string) => Timestamp.fromDate(new Date(iso))

describe('actionLogs — create: valid requests', () => {
  it.each(['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'])('a verified owner can record %s', async (actionType) => {
    await assertSucceeds(create(verifiedUser(env, ALICE), validActionLog({ actionType })))
  })

  it('accepts a note of exactly 10 characters', async () => {
    await assertSucceeds(create(verifiedUser(env, ALICE), validActionLog({ note: 'a'.repeat(10) })))
  })

  it('accepts a note of exactly 500 characters', async () => {
    await assertSucceeds(create(verifiedUser(env, ALICE), validActionLog({ note: 'a'.repeat(500) })))
  })

  it('accepts inner whitespace and newlines (only the ends must be trimmed)', async () => {
    const note = 'Line one of the note.\nLine two.'
    await assertSucceeds(create(verifiedUser(env, ALICE), validActionLog({ note })))
  })
})

describe('actionLogs — create: identity', () => {
  it('rejects an owner whose email is not verified', async () => {
    await assertFails(create(unverifiedUser(env, ALICE), validActionLog()))
  })

  it('rejects a token with no email_verified claim', async () => {
    await assertFails(create(dbOf(env.authenticatedContext(ALICE)), validActionLog()))
  })

  it('rejects an unauthenticated visitor', async () => {
    await assertFails(create(anonymousVisitor(env), validActionLog()))
  })

  it("rejects ownerUid set to another operator's uid", async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ ownerUid: BOB })))
  })
})

describe('actionLogs — create: fields', () => {
  it.each(['ownerUid', 'incidentId', 'actionType', 'note', 'createdAt', '_schemaVersion'])(
    'rejects a log missing %s',
    async (field) => {
      const data = validActionLog()
      delete data[field]
      await assertFails(create(verifiedUser(env, ALICE), data))
    }
  )

  it('rejects an extra, unexpected field', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ priority: 'high' })))
  })

  it('rejects _schemaVersion other than 1', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ _schemaVersion: 2 })))
  })
})

describe('actionLogs — create: actionType', () => {
  it.each([['CLOSE'], ['reviewed'], [3], [null]])('rejects actionType %s', async (actionType) => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ actionType })))
  })
})

describe('actionLogs — create: note', () => {
  it.each([
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['a leading space', ' Checked the outage evidence.'],
    ['a trailing space', 'Checked the outage evidence. '],
    ['a trailing newline', 'Checked the outage evidence.\n'],
    ['only whitespace', ' '.repeat(12)],
    ['an empty string', ''],
    ['a number', 1234567890],
  ])('rejects a note with %s', async (_label, note) => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ note })))
  })
})

describe('actionLogs — create: timestamp must be server-generated', () => {
  it('rejects a client-side Timestamp.now()', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ createdAt: Timestamp.now() })))
  })

  it('rejects a back-dated timestamp', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ createdAt: at('2020-01-01T00:00:00Z') })))
  })

  it('rejects a string date', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ createdAt: '2026-10-20T00:00:00Z' })))
  })
})

describe('actionLogs — create: incident reference', () => {
  it("rejects a reference to another operator's incident", async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ incidentId: BOB_INCIDENT })))
  })

  it('rejects a reference to an incident that does not exist', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ incidentId: `${ALICE}_INC-999` })))
  })

  it.each([
    ['a path separator', `${ALICE}_INC-001/../${BOB}_INC-001`],
    ['an empty id', ''],
    ['a non-string id', 42],
  ])('rejects an incidentId with %s', async (_label, incidentId) => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ incidentId })))
  })

  it('lets Bob log against his own incident (rules are per-operator, not per-user-hardcoded)', async () => {
    const data = validActionLog({ ownerUid: BOB, incidentId: BOB_INCIDENT })
    await assertSucceeds(create(verifiedUser(env, BOB), data))
  })
})

describe('actionLogs — create: the incident must be simulated', () => {
  const OWN_REAL = `${ALICE}_INC-REAL`

  /** Alice's own incident with isSimulated replaced (or removed when undefined), written with rules bypassed. */
  async function ownIncidentWith(isSimulated: unknown) {
    const data: Record<string, unknown> = { ...incidentFixture(ALICE), isSimulated }
    if (isSimulated === undefined) delete data.isSimulated
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(dbOf(context), INCIDENTS_COLLECTION, OWN_REAL), data)
    })
  }

  it.each(ACTION_TYPES)("%s is accepted on the owner's simulated incident", async (actionType) => {
    await assertSucceeds(create(verifiedUser(env, ALICE), validActionLog({ actionType })))
  })

  it.each(ACTION_TYPES)("%s is refused on the owner's own non-simulated incident", async (actionType) => {
    await ownIncidentWith(false)
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ actionType, incidentId: OWN_REAL })))
  })

  it.each([
    ['missing', undefined],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('an incident whose isSimulated is %s does not authorise a write', async (_label, isSimulated) => {
    await ownIncidentWith(isSimulated)
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ incidentId: OWN_REAL })))
  })

  it('other and unverified operators stay refused on a simulated incident', async () => {
    await assertFails(create(verifiedUser(env, BOB), validActionLog({ ownerUid: BOB })))
    await assertFails(create(unverifiedUser(env, ALICE), validActionLog()))
  })

  it('an invalid payload stays refused on a simulated incident', async () => {
    await assertFails(create(verifiedUser(env, ALICE), validActionLog({ note: 'short' })))
  })

  it('every one of the 50 Phase 3 incidents accepts a decision', async () => {
    const seeded = await seedDataset(env, ALICE, new Date('2026-10-21T00:00:00.000Z'))
    expect(seeded).toHaveLength(50)
    const db = verifiedUser(env, ALICE)
    for (const { id } of seeded) {
      await assertSucceeds(create(db, validActionLog({ incidentId: id, actionType: 'REVIEWED' })))
    }
  })
})

describe('actionLogs — reads and the app queries', () => {
  beforeEach(async () => {
    const base = { incidentId: ALICE_INCIDENT, note: 'Seeded decision note.', _schemaVersion: 1 }
    await seedActionLog(env, 'a1', { ...base, ownerUid: ALICE, actionType: 'ACKNOWLEDGE', createdAt: at('2026-10-19T01:00:00Z') })
    await seedActionLog(env, 'a2', { ...base, ownerUid: ALICE, actionType: 'ESCALATE', createdAt: at('2026-10-19T03:00:00Z') })
    await seedActionLog(env, 'a3', { ...base, ownerUid: ALICE, actionType: 'REVIEWED', createdAt: at('2026-10-19T02:00:00Z') })
    await seedActionLog(env, 'a4', { ...base, ownerUid: ALICE, incidentId: `${ALICE}_INC-002`, actionType: 'REVIEWED', createdAt: at('2026-10-19T04:00:00Z') })
    await seedActionLog(env, 'a5', { ...base, ownerUid: ALICE, incidentId: `${ALICE}_INC-002`, actionType: 'REVIEWED', createdAt: at('2026-10-19T05:00:00Z') })
    await seedActionLog(env, 'b1', { ...base, ownerUid: BOB, incidentId: BOB_INCIDENT, actionType: 'REVIEWED', createdAt: at('2026-10-19T06:00:00Z') })
  })

  it('a verified owner can read their own log', async () => {
    await assertSucceeds(getDoc(doc(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'a1')))
  })

  it("an operator cannot read another operator's log", async () => {
    await assertFails(getDoc(doc(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'b1')))
  })

  it('an unverified owner cannot read their log', async () => {
    await assertFails(getDoc(doc(unverifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'a1')))
  })

  it('an unauthenticated visitor cannot read logs', async () => {
    await assertFails(getDoc(doc(anonymousVisitor(env), ACTION_LOGS_COLLECTION, 'a1')))
  })

  it('history query: actionHistoryConstraints returns only this incident, newest first', async () => {
    const db = verifiedUser(env, ALICE)
    const snap = await assertSucceeds(
      getDocs(query(collection(db, ACTION_LOGS_COLLECTION), ...actionHistoryConstraints(ALICE, ALICE_INCIDENT)))
    )
    expect(snap.docs.map((d) => d.id)).toEqual(['a2', 'a3', 'a1'])
  })

  it('review-count query: reviewedActionsConstraints returns only own REVIEWED logs', async () => {
    const db = verifiedUser(env, ALICE)
    const snap = await assertSucceeds(
      getDocs(query(collection(db, ACTION_LOGS_COLLECTION), ...reviewedActionsConstraints(ALICE)))
    )
    expect(snap.docs.map((d) => d.id).sort()).toEqual(['a3', 'a4', 'a5'])
    // Two REVIEWED logs on INC-002 still count as one reviewed incident.
    const reviewedIncidents = new Set(snap.docs.map((d) => d.data().incidentId))
    expect(reviewedIncidents).toEqual(new Set([ALICE_INCIDENT, `${ALICE}_INC-002`]))
  })

  it('a history query without the ownerUid filter is rejected', async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(getDocs(query(collection(db, ACTION_LOGS_COLLECTION), where('incidentId', '==', ALICE_INCIDENT))))
  })

  it('an unfiltered list query is rejected', async () => {
    await assertFails(getDocs(collection(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION)))
  })

  it("a query for another operator's REVIEWED logs is rejected", async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(getDocs(query(collection(db, ACTION_LOGS_COLLECTION), ...reviewedActionsConstraints(BOB))))
  })
})

describe('actionLogs — append-only for clients', () => {
  beforeEach(async () => {
    await seedActionLog(env, 'a1', {
      ownerUid: ALICE,
      incidentId: ALICE_INCIDENT,
      actionType: 'ACKNOWLEDGE',
      note: 'Seeded decision note.',
      createdAt: at('2026-10-19T01:00:00Z'),
      _schemaVersion: 1,
    })
  })

  it('the owner cannot update a saved log', async () => {
    await assertFails(updateDoc(doc(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'a1'), { note: 'Rewritten afterwards.' }))
  })

  it('the owner cannot overwrite a saved log with setDoc', async () => {
    await assertFails(setDoc(doc(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'a1'), validActionLog()))
  })

  it('the owner cannot delete a saved log', async () => {
    await assertFails(deleteDoc(doc(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION, 'a1')))
  })

  it('another operator cannot delete the log either', async () => {
    await assertFails(deleteDoc(doc(verifiedUser(env, BOB), ACTION_LOGS_COLLECTION, 'a1')))
  })
})
