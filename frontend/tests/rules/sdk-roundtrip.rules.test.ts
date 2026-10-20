import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { addDoc, collection, getDoc, getDocs, query, Timestamp } from 'firebase/firestore'
import { deleteApp, initializeApp, type App } from 'firebase-admin/app'
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore'
import { ACTION_LOGS_COLLECTION, actionHistoryConstraints } from '@/lib/firebase/firestore'
import {
  ALICE,
  ALICE_INCIDENT,
  PROJECT_ID,
  createTestEnv,
  incidentFixture,
  seedIncidents,
  validActionLog,
  verifiedUser,
} from './helpers'

// End-to-end read/write checks over gRPC against the emulator, covering both
// dependency paths touched in Phase 1: the client SDK (scoped @grpc/grpc-js
// override) and the Admin SDK (@google-cloud/firestore → google-gax → grpc-js).

let env: RulesTestEnvironment

beforeAll(async () => {
  env = await createTestEnv()
})

afterAll(async () => {
  await env.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
})

describe('client SDK round trip (through the security rules)', () => {
  it('creates an action log, reads it back with a server timestamp, and finds it in the history query', async () => {
    await seedIncidents(env, [{ id: ALICE_INCIDENT, ownerUid: ALICE }])
    const db = verifiedUser(env, ALICE)
    const before = Date.now()

    const ref = await assertSucceeds(addDoc(collection(db, ACTION_LOGS_COLLECTION), validActionLog({ actionType: 'REVIEWED' })))
    const snap = await assertSucceeds(getDoc(ref))
    const saved = snap.data()

    expect(saved).toMatchObject({
      ownerUid: ALICE,
      incidentId: ALICE_INCIDENT,
      actionType: 'REVIEWED',
      note: 'Checked the simulated outage evidence.',
      _schemaVersion: 1,
    })
    expect(saved?.createdAt).toBeInstanceOf(Timestamp)
    // Server clock and test clock can differ slightly; allow a generous window.
    expect(Math.abs((saved?.createdAt as Timestamp).toMillis() - before)).toBeLessThan(60_000)

    const history = await getDocs(
      query(collection(db, ACTION_LOGS_COLLECTION), ...actionHistoryConstraints(ALICE, ALICE_INCIDENT))
    )
    expect(history.docs.map((d) => d.id)).toEqual([ref.id])
  })
})

describe('Admin SDK round trip (bypasses rules, as the Phase 3 seed script will)', () => {
  let adminApp: App

  beforeAll(() => {
    // With FIRESTORE_EMULATOR_HOST set, the Admin SDK talks to the emulator and needs no credentials.
    expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy()
    adminApp = initializeApp({ projectId: PROJECT_ID }, 'admin-roundtrip')
  })

  afterAll(async () => {
    await deleteApp(adminApp)
  })

  it('create() writes an incident, get() reads it back, and a second create() refuses to overwrite', async () => {
    const adminDb = getAdminFirestore(adminApp)
    const ref = adminDb.collection('incidents').doc(ALICE_INCIDENT)
    // The Admin SDK rejects the client SDK's Timestamp class; plain Dates are
    // converted to Firestore Timestamps by the Admin SDK itself.
    const incident = {
      ...incidentFixture(ALICE),
      lastSignalAt: new Date('2026-10-19T05:12:00Z'),
      createdAt: new Date('2026-10-19T00:00:00Z'),
    }

    await ref.create(incident)
    const snap = await ref.get()
    expect(snap.exists).toBe(true)
    expect(snap.data()).toMatchObject({ ownerUid: ALICE, incidentCode: 'INC-001', isSimulated: true })
    expect(snap.get('lastSignalAt').toDate().toISOString()).toBe('2026-10-19T05:12:00.000Z')

    // create() fails if the document exists — the idempotency primitive Phase 3 relies on.
    await expect(ref.create(incident)).rejects.toMatchObject({ code: 6 }) // ALREADY_EXISTS
  })
})
