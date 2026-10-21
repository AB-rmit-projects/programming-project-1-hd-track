import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { addDoc, collection, doc, getDoc, getDocs, query } from 'firebase/firestore'
import { deleteApp, initializeApp, type App } from 'firebase-admin/app'
import {
  Timestamp as AdminTimestamp,
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from 'firebase-admin/firestore'
import {
  ACTION_LOGS_COLLECTION,
  INCIDENTS_COLLECTION,
  ownIncidentsConstraints,
} from '@/lib/firebase/firestore'
import { PROJECT_ID, createTestEnv, unverifiedUser, validActionLog, verifiedUser } from './helpers'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import {
  CATEGORY_DISTRIBUTION,
  buildSeedIncidents,
  type SeedIncidentData,
  type SeedRecord,
} from '../../scripts/seed-incidents/dataset'
import { SCENARIOS } from '../../scripts/seed-incidents/scenarios'
import { adminIncidentStore, runSeed, type IncidentStore } from '../../scripts/seed-incidents/seed'

// Phase 3 seed script against the real Firestore emulator: the real Admin SDK
// getAll()/get()/create() path, ALREADY_EXISTS handling, stored Timestamps,
// then the seeded data read back through the security rules with the client SDK.

const NOW = new Date('2026-10-21T00:00:00.000Z')
const FRONTEND_DIR = resolve(__dirname, '../..')

let env: RulesTestEnvironment
let adminApp: App
let adminDb: AdminFirestore
let store: IncidentStore

beforeAll(async () => {
  // Set by `firebase emulators:exec`; the Admin SDK then needs no credentials.
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy()
  env = await createTestEnv()
  adminApp = initializeApp({ projectId: PROJECT_ID }, 'seed-incidents-rules-test')
  adminDb = getAdminFirestore(adminApp)
  store = adminIncidentStore(adminDb)
})

afterAll(async () => {
  await deleteApp(adminApp)
  await env.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
})

const incidents = () => adminDb.collection(INCIDENTS_COLLECTION)

/** Every incident document with its data and update time, keyed by ID. */
async function snapshotIncidents() {
  const snap = await incidents().get()
  return new Map(snap.docs.map((d) => [d.id, { data: d.data(), updateTime: d.updateTime }]))
}

/** Writes a document directly with the Admin SDK (bypasses the script). */
async function adminCreate(id: string, data: Record<string, unknown>) {
  await incidents().doc(id).create(data)
}

function recordsFor(owner: string): SeedRecord[] {
  return buildSeedIncidents(owner, NOW)
}

function expectUnchanged(
  before: Awaited<ReturnType<typeof snapshotIncidents>>,
  after: Awaited<ReturnType<typeof snapshotIncidents>>,
  ids: Iterable<string>
) {
  for (const id of ids) {
    const was = before.get(id)
    const now = after.get(id)
    expect(now, id).toBeDefined()
    expect(now?.data, id).toEqual(was?.data)
    expect(now?.updateTime.isEqual(was!.updateTime), `${id} updateTime`).toBe(true)
  }
}

describe('seed against an empty emulator database', () => {
  it('creates exactly 50 incidents with deterministic IDs, all fields and real Timestamps', async () => {
    const owner = 'seed-it-empty'
    const records = recordsFor(owner)
    const report = await runSeed(store, records, { write: true })

    expect(report).toMatchObject({
      mode: 'write',
      status: 'COMPLETE',
      skipped: [],
      conflicts: [],
      failed: [],
    })
    expect(report.created).toEqual(records.map((r) => r.id))

    const snap = await incidents().get()
    expect(snap.size).toBe(50)
    expect(snap.docs.map((d) => d.id).sort()).toEqual(records.map((r) => r.id).sort())

    const categories: Record<string, number> = {}
    for (const [index, record] of records.entries()) {
      const stored = snap.docs.find((d) => d.id === record.id)
      expect(stored?.id).toBe(`${owner}_INC-${String(index + 1).padStart(3, '0')}`)
      const data = stored?.data() ?? {}
      expect(Object.keys(data).sort()).toEqual(Object.keys(record.data).sort())
      expect(Object.keys(data)).toHaveLength(15)

      // Plain Dates were stored as Firestore Timestamps, to the millisecond.
      expect(data.lastSignalAt).toBeInstanceOf(AdminTimestamp)
      expect(data.createdAt).toBeInstanceOf(AdminTimestamp)
      expect((data.createdAt as AdminTimestamp).toMillis()).toBe(NOW.getTime())
      expect((data.lastSignalAt as AdminTimestamp).toMillis()).toBe(
        NOW.getTime() - (SCENARIOS[index]?.signalOffsetMinutes ?? 0) * 60_000
      )

      const { lastSignalAt: _l, createdAt: _c, ...rest } = record.data
      expect(data).toMatchObject({ ...rest, isSimulated: true, _schemaVersion: 1, ownerUid: owner })
      categories[String(data.causeCategory)] = (categories[String(data.causeCategory)] ?? 0) + 1
    }
    expect(categories).toEqual(CATEGORY_DISTRIBUTION)
  })
})

describe('idempotency', () => {
  it('a repeated run creates nothing, skips all 50 and leaves data and update times unchanged', async () => {
    const records = recordsFor('seed-it-repeat')
    await runSeed(store, records, { write: true })
    const before = await snapshotIncidents()

    const report = await runSeed(store, records, { write: true })
    expect(report.created).toEqual([])
    expect(report.skipped).toHaveLength(50)
    expect(report.status).toBe('COMPLETE')

    const after = await snapshotIncidents()
    expect(after.size).toBe(50)
    expectUnchanged(before, after, before.keys())
  })

  it('fills a partial dataset: 20 existing records untouched, exactly 30 created', async () => {
    const records = recordsFor('seed-it-partial')
    for (const record of records.slice(0, 20)) {
      await adminCreate(record.id, { ...record.data, likelyCause: `SENTINEL ${record.id}` })
    }
    const before = await snapshotIncidents()

    const report = await runSeed(store, records, { write: true })
    expect(report.created).toEqual(records.slice(20).map((r) => r.id))
    expect(report.skipped).toEqual(records.slice(0, 20).map((r) => r.id))
    expect(report.status).toBe('COMPLETE')

    const after = await snapshotIncidents()
    expect(after.size).toBe(50)
    expectUnchanged(before, after, before.keys())
    for (const record of records.slice(0, 20)) {
      expect(after.get(record.id)?.data.likelyCause).toBe(`SENTINEL ${record.id}`)
    }
  })

  it('preserves a conflicting record, reports it and finishes INCOMPLETE', async () => {
    const records = recordsFor('seed-it-conflict')
    const target = records[6]!
    await adminCreate(target.id, { ...target.data, deviceId: 'SC-0000' })
    const before = await snapshotIncidents()

    const report = await runSeed(store, records, { write: true })
    expect(report.conflicts).toEqual([
      expect.objectContaining({ id: target.id, mismatched: ['deviceId'] }),
    ])
    expect(report.conflicts[0]?.found.deviceId).toBe('SC-0000')
    expect(report.created).toHaveLength(49)
    expect(report.status).toBe('INCOMPLETE')

    const after = await snapshotIncidents()
    expectUnchanged(before, after, [target.id])
    expect(after.get(target.id)?.data.deviceId).toBe('SC-0000')
  })
})

describe('real ALREADY_EXISTS from create() after a stale preflight', () => {
  // The preflight is made to see nothing, so create() itself hits the existing document.
  const stalePreflight = (): IncidentStore => ({ ...store, readMany: async () => new Map() })

  it('re-reads and skips a matching document without touching it', async () => {
    const records = recordsFor('seed-it-race-match')
    const target = records[4]!
    await adminCreate(target.id, { ...target.data, likelyCause: 'written first by someone else' })
    const before = await snapshotIncidents()

    const report = await runSeed(stalePreflight(), records, { write: true })
    expect(report.skipped).toEqual([target.id])
    expect(report.created).toHaveLength(49)
    expect(report.status).toBe('COMPLETE')
    expectUnchanged(before, await snapshotIncidents(), [target.id])
  })

  it('re-reads and reports a conflict for a mismatching document without touching it', async () => {
    const records = recordsFor('seed-it-race-conflict')
    const target = records[4]!
    await adminCreate(target.id, { ...target.data, _schemaVersion: 2 })
    const before = await snapshotIncidents()

    const report = await runSeed(stalePreflight(), records, { write: true })
    expect(report.conflicts).toEqual([
      expect.objectContaining({ id: target.id, mismatched: ['_schemaVersion'] }),
    ])
    expect(report.status).toBe('INCOMPLETE')
    expectUnchanged(before, await snapshotIncidents(), [target.id])
  })
})

describe('dry run', () => {
  it('writes nothing on an empty database', async () => {
    const report = await runSeed(store, recordsFor('seed-it-dry'), { write: false })
    expect(report.wouldCreate).toHaveLength(50)
    expect(report.created).toEqual([])
    expect((await incidents().get()).size).toBe(0)
  })

  it('writes nothing and modifies nothing when some records already exist', async () => {
    const records = recordsFor('seed-it-dry-partial')
    for (const record of records.slice(0, 10)) await adminCreate(record.id, { ...record.data })
    const before = await snapshotIncidents()

    const report = await runSeed(store, records, { write: false })
    expect(report.wouldCreate).toHaveLength(40)
    expect(report.skipped).toHaveLength(10)

    const after = await snapshotIncidents()
    expect(after.size).toBe(10)
    expectUnchanged(before, after, before.keys())
  })
})

describe('isolation from other collections', () => {
  it('leaves existing action logs unchanged and creates no other collections', async () => {
    const owner = 'seed-it-logs'
    const logs = adminDb.collection(ACTION_LOGS_COLLECTION)
    await logs.doc('log-1').create({
      ownerUid: owner,
      incidentId: `${owner}_INC-001`,
      actionType: 'ACKNOWLEDGE',
      note: 'Existing note recorded before seeding.',
      createdAt: new Date('2026-10-20T00:00:00Z'),
      _schemaVersion: 1,
    })
    const before = await logs.doc('log-1').get()

    await runSeed(store, recordsFor(owner), { write: true })

    const after = await logs.doc('log-1').get()
    expect(after.data()).toEqual(before.data())
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true)
    expect((await logs.get()).size).toBe(1)
    const collections = (await adminDb.listCollections()).map((c) => c.id).sort()
    expect(collections).toEqual([ACTION_LOGS_COLLECTION, INCIDENTS_COLLECTION].sort())
  })
})

describe('failure handling', () => {
  it('records one invalid record as failed and still creates the independent valid records', async () => {
    const records = recordsFor('seed-it-failure')
    const existing = records[0]!
    await adminCreate(existing.id, { ...existing.data })
    const before = await snapshotIncidents()

    const broken = records[9]!
    // undefined is not a valid Firestore value, so the Admin SDK rejects this create().
    const invalid = {
      ...broken,
      data: { ...broken.data, deviceId: undefined } as unknown as SeedIncidentData,
    }
    const report = await runSeed(
      store,
      records.map((r) => (r.id === broken.id ? invalid : r)),
      {
        write: true,
      }
    )

    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.id).toBe(broken.id)
    expect(report.failed[0]?.error).toMatch(/undefined/i)
    expect(report.created).toHaveLength(48)
    expect(report.skipped).toEqual([existing.id])
    expect(report.status).toBe('INCOMPLETE')

    const after = await snapshotIncidents()
    expect(after.size).toBe(49)
    expect(after.has(broken.id)).toBe(false)
    expectUnchanged(before, after, [existing.id])
  })
})

describe('seeded incidents through the security rules', () => {
  const OWNER = 'seed-it-owner-a'
  const OTHER = 'seed-it-owner-b'

  it('the verified owner can query their 50 incidents; another owner cannot read them', async () => {
    const records = recordsFor(OWNER)
    await runSeed(store, records, { write: true })

    const ownerDb = verifiedUser(env, OWNER)
    const mine = await assertSucceeds(
      getDocs(query(collection(ownerDb, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(OWNER)))
    )
    expect(mine.size).toBe(50)

    const otherDb = verifiedUser(env, OTHER)
    const theirs = await assertSucceeds(
      getDocs(query(collection(otherDb, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(OTHER)))
    )
    expect(theirs.size).toBe(0)
    const seeded = records[0]!.id
    await assertFails(getDoc(doc(otherDb, INCIDENTS_COLLECTION, seeded)))
    await assertFails(
      getDocs(query(collection(otherDb, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(OWNER)))
    )
    // Unverified email: even the owner is denied (rules require email_verified).
    await assertFails(getDoc(doc(unverifiedUser(env, OWNER), INCIDENTS_COLLECTION, seeded)))
    await assertSucceeds(getDoc(doc(ownerDb, INCIDENTS_COLLECTION, seeded)))
  })

  it('the verified owner can create a valid action log for a seeded incident', async () => {
    const records = recordsFor(OWNER)
    await runSeed(store, records, { write: true })

    const ownerDb = verifiedUser(env, OWNER)
    await assertSucceeds(
      addDoc(
        collection(ownerDb, ACTION_LOGS_COLLECTION),
        validActionLog({ ownerUid: OWNER, incidentId: records[0]!.id })
      )
    )
    // …but not one that references another owner's incident.
    await assertFails(
      addDoc(
        collection(verifiedUser(env, OTHER), ACTION_LOGS_COLLECTION),
        validActionLog({ ownerUid: OTHER, incidentId: records[0]!.id })
      )
    )
  })
})

interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** Runs the real CLI exactly as `pnpm seed:incidents` does, in a child process. */
function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...envOverrides }
  for (const [key, value] of Object.entries(envOverrides))
    if (value === undefined) delete childEnv[key]
  return new Promise<CliRun>((done) => {
    execFile(
      process.execPath,
      ['--experimental-strip-types', 'scripts/seed-incidents/cli.ts', ...args],
      { cwd: FRONTEND_DIR, env: childEnv, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
        done({ code, stdout, stderr })
      }
    )
  })
}

describe('CLI end to end (real process, real emulator)', () => {
  const OWNER = 'seed-it-cli-operator'
  const ARGS = ['--project', PROJECT_ID, '--owner-uid', OWNER]

  it('dry run → write → repeat write, with the expected output and exit codes', async () => {
    const dry = await runCli(ARGS)
    expect(dry.stderr.split('\n').filter((line) => line.startsWith('Refused'))).toEqual([])
    expect(dry.code).toBe(0)
    expect(dry.stdout).toContain('DRY RUN (read-only, nothing written)')
    expect(dry.stdout).toContain('would create: 50')
    expect((await incidents().get()).size).toBe(0)

    const first = await runCli([...ARGS, '--write'])
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('created: 50')
    expect(first.stdout).toContain('Status:  COMPLETE')
    const afterFirst = await snapshotIncidents()
    expect(afterFirst.size).toBe(50)

    const second = await runCli([...ARGS, '--write', '--json'])
    expect(second.code).toBe(0)
    const report: unknown = JSON.parse(second.stdout)
    expect(report).toMatchObject({
      projectId: PROJECT_ID,
      ownerUid: OWNER,
      mode: 'write',
      created: [],
      status: 'COMPLETE',
    })
    expect((report as { skipped: string[] }).skipped).toHaveLength(50)
    expectUnchanged(afterFirst, await snapshotIncidents(), afterFirst.keys())
  }, 90_000)

  it('exits 1 and reports INCOMPLETE when a conflicting record exists', async () => {
    const target = recordsFor(OWNER)[2]!
    await adminCreate(target.id, { ...target.data, isSimulated: false })

    const run = await runCli([...ARGS, '--write'])
    expect(run.code).toBe(1)
    expect(run.stdout).toContain(`CONFLICT ${target.id}: unexpected isSimulated=false`)
    expect(run.stdout).toContain('Status:  INCOMPLETE')
    expect((await incidents().doc(target.id).get()).get('isSimulated')).toBe(false)
  }, 60_000)

  it('exits 2 and touches nothing when the emulator host is missing or the project is not demo-', async () => {
    const noHost = await runCli([...ARGS, '--write'], { FIRESTORE_EMULATOR_HOST: undefined })
    expect(noHost.code).toBe(2)
    expect(noHost.stderr).toContain('Production seeding is not enabled')

    const realProject = await runCli([
      '--project',
      'safecall-prod',
      '--owner-uid',
      OWNER,
      '--write',
    ])
    expect(realProject.code).toBe(2)
    expect((await incidents().get()).size).toBe(0)
  }, 60_000)
})
