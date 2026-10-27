import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { assertSucceeds, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { addDoc, collection, getDoc, doc } from 'firebase/firestore'
import { deleteApp, initializeApp, type App } from 'firebase-admin/app'
import {
  Timestamp as AdminTimestamp,
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from 'firebase-admin/firestore'
import { ACTION_LOGS_COLLECTION, INCIDENTS_COLLECTION } from '@/lib/firebase/firestore'
import { parseIncident } from '@/features/incidents/incidentRow'
import { melbourneDateKey } from '@/lib/melbourneTime'
import {
  PROJECT_ID,
  assertEmulatorOnly,
  clearEmulator,
  createTestEnv,
  validActionLog,
  verifiedUser,
} from './helpers'
// The migration lives outside src/, so the @/ alias cannot reach it.
import { buildIncidentVersions } from '../../scripts/migrate-incident-timeline/legacy'
import {
  adminMigrationStore,
  dryRun,
  rollback,
  write,
  type MigrationStore,
  type MigrationTarget,
} from '../../scripts/migrate-incident-timeline/migrate'
import { classify } from '../../scripts/migrate-incident-timeline/plan'
import { LATEST_REPORTED_AT } from '../../scripts/seed-incidents/dataset'

// Emulator rehearsal of the schema v1 → v2 timeline migration: real Admin SDK
// reads, an atomic batch with last-update-time preconditions, verification by
// re-reading, idempotency, rollback, and the negative cases that must write
// nothing. Never runs against a real project (assertEmulatorOnly).

const OWNER = 'migration-owner'
const OTHER = 'migration-other-owner'
const SEED_TIME = new Date('2026-10-23T05:33:44.000Z')

let env: RulesTestEnvironment
let adminApp: App
let adminDb: AdminFirestore
let store: MigrationStore

const versions = buildIncidentVersions(OWNER, SEED_TIME)
const target: MigrationTarget = {
  ownerUid: OWNER,
  seedTime: SEED_TIME,
  allowlist: versions.map((v) => v.id),
  // A fixed real clock after the whole simulated timeline (it ends 27 October, 8:36 am AEDT).
  currentTime: new Date('2026-10-28T00:00:00.000Z'),
}

beforeAll(async () => {
  assertEmulatorOnly()
  env = await createTestEnv()
  adminApp = initializeApp({ projectId: PROJECT_ID }, 'timeline-migration-rules-test')
  adminDb = getAdminFirestore(adminApp)
  store = adminMigrationStore(adminDb)
})

afterAll(async () => {
  await deleteApp(adminApp)
  await env.cleanup()
})

const incidents = () => adminDb.collection(INCIDENTS_COLLECTION)

/** Writes the 50 version 1 documents exactly as the v1 seed did, plus decoys that must never change. */
async function seedV1World() {
  await clearEmulator(env)
  for (const { id, v1 } of versions) await incidents().doc(id).create(v1)
  // Another operator's incidents and both operators' action logs: never touched.
  for (const { id, v1 } of buildIncidentVersions(OTHER, SEED_TIME).slice(0, 5)) {
    await incidents().doc(id).create(v1)
  }
  const logs = adminDb.collection(ACTION_LOGS_COLLECTION)
  await logs.doc('owner-log-1').create({
    ownerUid: OWNER,
    incidentId: versions[0]!.id,
    actionType: 'ACKNOWLEDGE',
    note: 'Before the migration.',
    createdAt: AdminTimestamp.now(),
    _schemaVersion: 1,
  })
  await logs.doc('other-log-1').create({
    ownerUid: OTHER,
    incidentId: 'x',
    actionType: 'REVIEWED',
    note: 'Another operator.',
    createdAt: AdminTimestamp.now(),
    _schemaVersion: 1,
  })
}

/** Every document in both collections with its data and update time. */
async function everything() {
  const [inc, logs] = await Promise.all([
    incidents().get(),
    adminDb.collection(ACTION_LOGS_COLLECTION).get(),
  ])
  return new Map(
    [...inc.docs, ...logs.docs].map((d) => [
      `${d.ref.parent.id}/${d.id}`,
      { data: d.data(), updateTime: d.updateTime },
    ])
  )
}

function expectUnchanged(
  before: Awaited<ReturnType<typeof everything>>,
  after: typeof before,
  keys: string[]
) {
  for (const key of keys) {
    expect(after.get(key)?.data, key).toEqual(before.get(key)?.data)
    expect(
      after.get(key)?.updateTime.isEqual(before.get(key)!.updateTime),
      `${key} updateTime`
    ).toBe(true)
  }
}

/** Changes a document and puts it back: identical data, newer update time. */
async function touch(id: string) {
  const original = (await incidents().doc(id).get()).get('suburb') as string
  await incidents()
    .doc(id)
    .update({ suburb: `${original} (edited)` })
  await incidents().doc(id).update({ suburb: original })
}

const allKeys = (snapshot: Awaited<ReturnType<typeof everything>>) => [...snapshot.keys()]
const decoyKeys = (snapshot: Awaited<ReturnType<typeof everything>>) =>
  allKeys(snapshot).filter(
    (key) => !target.allowlist.some((id) => key === `${INCIDENTS_COLLECTION}/${id}`)
  )

describe('incident timeline migration — emulator rehearsal', () => {
  beforeEach(seedV1World)

  it('dry run plans exactly 50 three-field updates and writes nothing', async () => {
    const before = await everything()
    const { plan, backup } = await dryRun(store, target)
    expect(plan.decision).toBe('PROCEED')
    expect(plan.updates).toHaveLength(50)
    expect(plan.ownerActionLogIds).toEqual(['owner-log-1'])
    expect(backup).toContain(versions[49]!.id)
    expectUnchanged(before, await everything(), allKeys(before))
  })

  it('write converts all 50 to v2 atomically, keeps createdAt and every other field, touches nothing else', async () => {
    const before = await everything()
    const { plan } = await dryRun(store, target)
    const report = await write(store, target, plan.digest)

    expect(report.status).toBe('WRITTEN')
    expect(report.verification).toEqual({ ok: true, failures: [] })
    const after = await everything()
    for (const v of versions) {
      const stored = after.get(`${INCIDENTS_COLLECTION}/${v.id}`)!
      expect(
        classify({ data: stored.data, updateTime: { seconds: 0, nanoseconds: 0 } }, v)
          .classification
      ).toBe('V2_TARGET')
      expect(Object.keys(stored.data)).toHaveLength(16)
      // createdAt stays the fixture's write time, even where the fictional report is later.
      expect((stored.data.createdAt as AdminTimestamp).toMillis()).toBe(SEED_TIME.getTime())
      expect((stored.data.reportedAt as AdminTimestamp).toMillis()).toBe(v.v2.reportedAt.getTime())
      expect(stored.data.ownerUid).toBe(OWNER)
      expect(stored.data.likelyCause).toBe(v.v1.likelyCause)
    }
    expectUnchanged(before, after, decoyKeys(before))
  })

  it('migrated documents read through the rules show the new timeline, and decisions still save', async () => {
    const { plan } = await dryRun(store, target)
    await write(store, target, plan.digest)

    const alice = verifiedUser(env, OWNER)
    const id = versions[4]!.id // INC-005
    const snap = await assertSucceeds(getDoc(doc(alice, INCIDENTS_COLLECTION, id)))
    const parsed = parseIncident(id, snap.data())
    expect(parsed.ok && parsed.row.legacyTimeline).toBe(false)
    expect(parsed.ok && parsed.row.reportedAt?.toISOString()).toBe('2026-10-13T05:08:53.000Z')
    expect(parsed.ok && parsed.row.dataIssues).toEqual([])
    // The actionLogs create rule (incident owned and simulated) still accepts a decision.
    await assertSucceeds(
      addDoc(
        collection(alice, ACTION_LOGS_COLLECTION),
        validActionLog({ ownerUid: OWNER, incidentId: id })
      )
    )
  })

  it('is idempotent: a second run finds nothing to do and changes no update time', async () => {
    const first = await dryRun(store, target)
    await write(store, target, first.plan.digest)
    const migrated = await everything()

    const second = await dryRun(store, target)
    expect(second.plan.decision).toBe('NOTHING_TO_DO')
    expect((await write(store, target, second.plan.digest)).status).toBe('NOTHING_TO_DO')
    expectUnchanged(migrated, await everything(), allKeys(migrated))
  })

  it('refuses to write if anything changed since the approved dry run', async () => {
    const { plan } = await dryRun(store, target)
    // A concurrent edit to one document, then put back: same data, but a new update time.
    await touch(versions[9]!.id)
    const before = await everything()

    const report = await write(store, target, plan.digest)
    expect(report.status).toBe('REFUSED')
    expect(report.reason).toMatch(/state changed/)
    expectUnchanged(before, await everything(), allKeys(before))
  })

  it('the batch precondition blocks a write raced after planning, and nothing at all is written', async () => {
    const { plan } = await dryRun(store, target)
    await touch(versions[30]!.id) // after the plan
    const before = await everything()

    await expect(store.commit(plan.updates)).rejects.toThrow()
    expectUnchanged(before, await everything(), allKeys(before)) // atomic: the other 49 unchanged too
  })

  it('STOPs, writing nothing, when a document was altered (e.g. evidence edited)', async () => {
    await incidents().doc(versions[2]!.id).update({ likelyCause: 'Edited by hand.' })
    const before = await everything()
    const { plan } = await dryRun(store, target)
    expect(plan.decision).toBe('STOP')
    expect(plan.reasons.join()).toContain('likelyCause')
    expect((await write(store, target, plan.digest)).status).toBe('REFUSED')
    expectUnchanged(before, await everything(), allKeys(before))
  })

  it('refuses before reading or writing while a simulated report time is still in the future', async () => {
    const before = await everything()
    const early = { ...target, currentTime: new Date(LATEST_REPORTED_AT.getTime() - 1) }
    await expect(dryRun(store, early)).rejects.toThrow(/future/)
    const { plan } = await dryRun(store, target)
    await expect(write(store, early, plan.digest)).rejects.toThrow(/future/)
    expectUnchanged(before, await everything(), allKeys(before))
  })

  it('migrates the July–October timeline: 12 / 12 / 12 / 14 by Melbourne month', async () => {
    const { plan } = await dryRun(store, target)
    await write(store, target, plan.digest)
    const months: Record<string, number> = {}
    for (const v of versions) {
      const stored = (await incidents().doc(v.id).get()).get('reportedAt') as AdminTimestamp
      const month = melbourneDateKey(stored.toDate()).slice(0, 7)
      months[month] = (months[month] ?? 0) + 1
    }
    expect(months).toEqual({ '2026-07': 12, '2026-08': 12, '2026-09': 12, '2026-10': 14 })
  })

  it('STOPs when the owner has an extra incident outside the allowlist', async () => {
    await incidents()
      .doc(`${OWNER}_INC-051`)
      .create({ ...versions[0]!.v1, incidentCode: 'INC-051' })
    const { plan } = await dryRun(store, target)
    expect(plan.decision).toBe('STOP')
    expect(plan.reasons.join()).toMatch(/outside the allowlist/)
  })

  it('rollback restores the exact version 1 documents', async () => {
    const original = await everything()
    const { plan } = await dryRun(store, target)
    await write(store, target, plan.digest)

    const result = await rollback(store, target)
    expect(result.decision).toBe('PROCEED')
    expect(result.updates).toHaveLength(50)
    const restored = await everything()
    for (const v of versions) {
      const key = `${INCIDENTS_COLLECTION}/${v.id}`
      expect(restored.get(key)?.data).toEqual(original.get(key)?.data)
      expect('reportedAt' in restored.get(key)!.data).toBe(false)
    }
    expect((await dryRun(store, target)).plan.decision).toBe('PROCEED') // ready to migrate again
  })
})
