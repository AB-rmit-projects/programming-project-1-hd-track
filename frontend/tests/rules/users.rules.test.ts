import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { assertFails, assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { ALICE, BOB, createTestEnv, dbOf, verifiedUser } from './helpers'

// Regression guard: the boilerplate's users rules must behave exactly as before.

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

function profile(uid: string, role: string) {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName: null,
    photoURL: null,
    role,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    _schemaVersion: 1,
  }
}

describe('users — unchanged boilerplate behaviour', () => {
  it('a user can create their own profile with role "user"', async () => {
    await assertSucceeds(setDoc(doc(verifiedUser(env, ALICE), 'users', ALICE), profile(ALICE, 'user')))
  })

  it('a user cannot grant themselves the admin role', async () => {
    await assertFails(setDoc(doc(verifiedUser(env, ALICE), 'users', ALICE), profile(ALICE, 'admin')))
  })

  it("a user cannot read someone else's profile", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(dbOf(context), 'users', BOB), profile(BOB, 'user'))
    })
    await assertFails(getDoc(doc(verifiedUser(env, ALICE), 'users', BOB)))
  })
})
