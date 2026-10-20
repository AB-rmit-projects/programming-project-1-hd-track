import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, serverTimestamp, setDoc, Timestamp, type Firestore } from 'firebase/firestore'
import { ACTION_LOGS_COLLECTION, INCIDENTS_COLLECTION } from '@/lib/firebase/firestore'

/** This suite uses the demo project `demo-safecall` and is configured to run against the local Firestore emulator. */
export const PROJECT_ID = 'demo-safecall'

export const ALICE = 'alice-uid'
export const BOB = 'bob-uid'
export const ALICE_INCIDENT = `${ALICE}_INC-001`
export const BOB_INCIDENT = `${BOB}_INC-001`

export async function createTestEnv(): Promise<RulesTestEnvironment> {
  return initializeTestEnvironment({
    projectId: PROJECT_ID,
    // Host/port come from FIRESTORE_EMULATOR_HOST, set by `firebase emulators:exec`.
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../../firebase/firestore.rules'), 'utf8'),
    },
  })
}

/**
 * The test context returns the compat Firestore class, which the library
 * documents as usable with the v9 modular API; this narrows the type so the
 * same modular calls the app makes can be used in tests.
 */
export function dbOf(context: RulesTestContext): Firestore {
  return context.firestore() as unknown as Firestore
}

export function verifiedUser(env: RulesTestEnvironment, uid: string): Firestore {
  return dbOf(env.authenticatedContext(uid, { email_verified: true }))
}

export function unverifiedUser(env: RulesTestEnvironment, uid: string): Firestore {
  return dbOf(env.authenticatedContext(uid, { email_verified: false }))
}

export function anonymousVisitor(env: RulesTestEnvironment): Firestore {
  return dbOf(env.unauthenticatedContext())
}

export function incidentFixture(ownerUid: string) {
  return {
    ownerUid,
    incidentCode: 'INC-001',
    deviceId: 'SC-4821',
    status: 'OFFLINE',
    suburb: 'Ballarat',
    state: 'VIC',
    postcode: '3350',
    lastSignalAt: Timestamp.fromDate(new Date('2026-10-19T05:12:00Z')),
    causeCategory: 'UNPLANNED_OUTAGE',
    likelyCause: 'Simulated network outage near the last-known location.',
    recommendedAction: 'Escalate for welfare check',
    evidenceSummary: 'Simulated outage overlap; no live data.',
    isSimulated: true,
    createdAt: Timestamp.fromDate(new Date('2026-10-19T00:00:00Z')),
    _schemaVersion: 1,
  }
}

/** Writes incidents the way the admin seed script will: with rules bypassed. */
export async function seedIncidents(
  env: RulesTestEnvironment,
  incidents: Array<{ id: string; ownerUid: string }>
) {
  await env.withSecurityRulesDisabled(async (context) => {
    const db = dbOf(context)
    for (const { id, ownerUid } of incidents) {
      await setDoc(doc(db, INCIDENTS_COLLECTION, id), incidentFixture(ownerUid))
    }
  })
}

/** Writes action logs directly (rules bypassed) to set up read/query tests. */
export async function seedActionLog(
  env: RulesTestEnvironment,
  id: string,
  data: Record<string, unknown>
) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(dbOf(context), ACTION_LOGS_COLLECTION, id), data)
  })
}

/** A create payload that satisfies every rule; tests override one field at a time. */
export function validActionLog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerUid: ALICE,
    incidentId: ALICE_INCIDENT,
    actionType: 'ACKNOWLEDGE',
    note: 'Checked the simulated outage evidence.',
    createdAt: serverTimestamp(),
    _schemaVersion: 1,
    ...overrides,
  }
}
