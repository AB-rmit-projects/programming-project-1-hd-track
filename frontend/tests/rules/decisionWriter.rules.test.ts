import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  collection,
  getDoc,
  getDocs,
  doc,
  onSnapshot,
  query,
  Timestamp,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore'
import { ACTION_LOGS_COLLECTION, actionHistoryConstraints } from '@/lib/firebase/firestore'
import { startDecisionWrite } from '@/features/incidents/decisionWriter'
import {
  ALICE,
  ALICE_INCIDENT,
  BOB_INCIDENT,
  BOB,
  createTestEnv,
  seedIncidents,
  unverifiedUser,
  verifiedUser,
} from './helpers'

// The real CP4 write adapter (startDecisionWrite → buildActionLogData → addDoc)
// against the unchanged rules on the local demo-safecall emulator. Only the
// Firestore instance is swapped: getClientDb() returns the emulator context of
// the operator under test instead of the app's own client.

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/firebase/client', () => ({ getClientDb: () => db.current }))

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

function signInAs(firestore: Firestore) {
  db.current = firestore
  return firestore
}

async function writeAs(firestore: Firestore, incidentId: string, input: unknown) {
  signInAs(firestore)
  const start = startDecisionWrite(ALICE, incidentId, input)
  if (!start.started) throw new Error(`expected a write, got ${JSON.stringify(start.issues)}`)
  return start.confirmed
}

describe('startDecisionWrite against the rules (local emulator)', () => {
  it.each(['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'])(
    'a %s decision is accepted and stored with exactly the six fields',
    async (actionType) => {
      const alice = verifiedUser(env, ALICE)
      const outcome = await writeAs(alice, ALICE_INCIDENT, { actionType, note: `  ${NOTE}\n` })
      if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`)
      expect(outcome.actionType).toBe(actionType)

      const saved = (await getDoc(doc(alice, ACTION_LOGS_COLLECTION, outcome.actionLogId))).data()
      expect(Object.keys(saved ?? {}).sort()).toEqual(
        ['_schemaVersion', 'actionType', 'createdAt', 'incidentId', 'note', 'ownerUid'].sort()
      )
      expect(saved).toMatchObject({
        ownerUid: ALICE,
        incidentId: ALICE_INCIDENT,
        actionType,
        note: NOTE,
      })
      expect(saved?.createdAt).toBeInstanceOf(Timestamp) // filled in by the server
    }
  )

  it("a decision on another operator's incident is refused, with the write's own safe message", async () => {
    const outcome = await writeAs(verifiedUser(env, ALICE), BOB_INCIDENT, {
      actionType: 'REVIEWED',
      note: NOTE,
    })
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'permission-denied',
        message:
          'The decision was refused. Your session may have ended, or this incident is not available to your account.',
      },
    })
  })

  it('an operator whose email is not verified is refused', async () => {
    const outcome = await writeAs(unverifiedUser(env, ALICE), ALICE_INCIDENT, {
      actionType: 'ACKNOWLEDGE',
      note: NOTE,
    })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'permission-denied' } })
  })

  it('invalid input never reaches the database', async () => {
    const alice = signInAs(verifiedUser(env, ALICE))
    const start = startDecisionWrite(ALICE, ALICE_INCIDENT, {
      actionType: 'REVIEWED',
      note: 'short',
    })
    expect(start.started).toBe(false)
    const logs = await getDocs(
      query(
        collection(alice, ACTION_LOGS_COLLECTION),
        ...actionHistoryConstraints(ALICE, ALICE_INCIDENT)
      )
    )
    expect(logs.size).toBe(0)
  })

  it('the outcome arrives only after the SDK has shown the write as pending; the history then confirms it', async () => {
    const alice = signInAs(verifiedUser(env, ALICE))
    const snaps: QuerySnapshot[] = []
    const stop = onSnapshot(
      query(
        collection(alice, ACTION_LOGS_COLLECTION),
        ...actionHistoryConstraints(ALICE, ALICE_INCIDENT)
      ),
      { includeMetadataChanges: true },
      (s: QuerySnapshot) => snaps.push(s)
    )
    try {
      await vi.waitFor(() => expect(snaps.some((s) => !s.metadata.fromCache)).toBe(true), {
        timeout: 10_000,
      })

      const start = startDecisionWrite(ALICE, ALICE_INCIDENT, {
        actionType: 'REVIEWED',
        note: NOTE,
      })
      if (!start.started) throw new Error('expected a write')
      const outcome = await start.confirmed
      if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`)

      // Before the server answered, the SDK already showed the document as pending.
      expect(
        snaps.some((s) =>
          s.docs.some((d) => d.id === outcome.actionLogId && d.metadata.hasPendingWrites)
        )
      ).toBe(true)
      await vi.waitFor(
        () => {
          const latest = snaps.at(-1)!
          expect(latest.docs.map((d) => [d.id, d.metadata.hasPendingWrites])).toEqual([
            [outcome.actionLogId, false],
          ])
        },
        { timeout: 10_000 }
      )
    } finally {
      stop()
    }
  })
})
