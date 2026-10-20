import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore'
import { INCIDENTS_COLLECTION, ownIncidentsConstraints } from '@/lib/firebase/firestore'
import {
  ALICE,
  ALICE_INCIDENT,
  BOB,
  BOB_INCIDENT,
  anonymousVisitor,
  createTestEnv,
  dbOf,
  incidentFixture,
  seedIncidents,
  unverifiedUser,
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
    { id: BOB_INCIDENT, ownerUid: BOB },
  ])
})

describe('incidents — reads', () => {
  it('a verified owner can read their own incident', async () => {
    await assertSucceeds(getDoc(doc(verifiedUser(env, ALICE), INCIDENTS_COLLECTION, ALICE_INCIDENT)))
  })

  it("a verified operator cannot read another operator's incident", async () => {
    await assertFails(getDoc(doc(verifiedUser(env, ALICE), INCIDENTS_COLLECTION, BOB_INCIDENT)))
  })

  it('an owner whose email is not verified is denied', async () => {
    await assertFails(getDoc(doc(unverifiedUser(env, ALICE), INCIDENTS_COLLECTION, ALICE_INCIDENT)))
  })

  it('a token with no email_verified claim at all is denied', async () => {
    const noClaim = dbOf(env.authenticatedContext(ALICE))
    await assertFails(getDoc(doc(noClaim, INCIDENTS_COLLECTION, ALICE_INCIDENT)))
  })

  it('an unauthenticated visitor is denied', async () => {
    await assertFails(getDoc(doc(anonymousVisitor(env), INCIDENTS_COLLECTION, ALICE_INCIDENT)))
  })

  it('reading a non-existent incident is denied (not distinguishable from "not yours")', async () => {
    await assertFails(getDoc(doc(verifiedUser(env, ALICE), INCIDENTS_COLLECTION, `${ALICE}_INC-999`)))
  })
})

describe('incidents — list queries (rules are not filters)', () => {
  it('the app query ownIncidentsConstraints(uid) succeeds and returns only own incidents', async () => {
    const db = verifiedUser(env, ALICE)
    const snap = await assertSucceeds(
      getDocs(query(collection(db, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(ALICE)))
    )
    expect(snap.docs.map((d) => d.id)).toEqual([ALICE_INCIDENT])
  })

  it('an unfiltered list query is rejected', async () => {
    await assertFails(getDocs(collection(verifiedUser(env, ALICE), INCIDENTS_COLLECTION)))
  })

  it("a query filtered to another operator's uid is rejected", async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(getDocs(query(collection(db, INCIDENTS_COLLECTION), where('ownerUid', '==', BOB))))
  })

  it('an unverified owner cannot list even with the owner filter', async () => {
    const db = unverifiedUser(env, ALICE)
    await assertFails(getDocs(query(collection(db, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(ALICE))))
  })
})

describe('incidents — clients can never write', () => {
  it('a verified owner cannot create an incident', async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(setDoc(doc(db, INCIDENTS_COLLECTION, `${ALICE}_INC-002`), incidentFixture(ALICE)))
  })

  it('a verified owner cannot update their incident', async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(updateDoc(doc(db, INCIDENTS_COLLECTION, ALICE_INCIDENT), { likelyCause: 'edited' }))
  })

  it('a verified owner cannot delete their incident', async () => {
    await assertFails(deleteDoc(doc(verifiedUser(env, ALICE), INCIDENTS_COLLECTION, ALICE_INCIDENT)))
  })

  it('an unauthenticated visitor cannot create an incident', async () => {
    const db = anonymousVisitor(env)
    await assertFails(setDoc(doc(db, INCIDENTS_COLLECTION, 'x_INC-001'), incidentFixture('x')))
  })
})
