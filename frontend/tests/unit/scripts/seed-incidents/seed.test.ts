// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Firestore } from 'firebase-admin/firestore'
import { INCIDENTS_COLLECTION as APP_INCIDENTS_COLLECTION } from '@/lib/firebase/firestore'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import {
  buildSeedIncidents,
  type SeedIncidentData,
} from '../../../../scripts/seed-incidents/dataset'
import {
  IDENTITY_FIELDS,
  INCIDENTS_COLLECTION,
  adminIncidentStore,
  exitCodeFor,
  identityOf,
  isAlreadyExistsError,
  mismatchedFields,
  runSeed,
  type ExistingIncident,
  type IncidentStore,
} from '../../../../scripts/seed-incidents/seed'
import { main, type CliDeps } from '../../../../scripts/seed-incidents/cli'

const OWNER = 'demoOperatorUid01'
const NOW = new Date('2026-10-21T00:00:00.000Z')
const records = buildSeedIncidents(OWNER, NOW)
const ids = records.map((r) => r.id)
const idOf = (n: number) => `${OWNER}_INC-${String(n).padStart(3, '0')}`

type Doc = Record<string, unknown>

/**
 * In-memory IncidentStore with create-only semantics, plus hooks for the
 * failure modes the runner must survive. It has no update or delete method.
 */
class FakeStore implements IncidentStore {
  readonly docs = new Map<string, Doc>()
  readonly createCalls: string[] = []
  readonly readCalls: string[] = []
  /** create() throws this error for the id. */
  readonly failCreate = new Map<string, Error>()
  /** Another writer creates this document just before our create() runs. */
  readonly raceOnCreate = new Map<string, Doc>()
  /** read() throws for these ids. */
  readonly failRead = new Set<string>()
  /** The document vanishes right after the race, so the re-read finds nothing. */
  readonly vanishAfterRace = new Set<string>()
  failReadMany = false

  async readMany(requested: string[]) {
    if (this.failReadMany) throw new Error('deadline exceeded')
    const found = new Map<string, ExistingIncident>()
    for (const id of requested) {
      const doc = this.docs.get(id)
      if (doc)
        found.set(
          id,
          identityOf((field) => doc[field])
        )
    }
    return found
  }

  async read(id: string) {
    this.readCalls.push(id)
    if (this.failRead.has(id)) throw new Error('unavailable')
    const doc = this.docs.get(id)
    return doc ? identityOf((field) => doc[field]) : null
  }

  async create(id: string, data: SeedIncidentData) {
    this.createCalls.push(id)
    const failure = this.failCreate.get(id)
    if (failure) throw failure
    const raced = this.raceOnCreate.get(id)
    if (raced && !this.docs.has(id)) {
      this.docs.set(id, raced)
      if (this.vanishAfterRace.has(id)) this.docs.delete(id)
      return 'already-exists' as const
    }
    if (this.docs.has(id)) return 'already-exists' as const
    this.docs.set(id, { ...data })
    return 'created' as const
  }

  /** Pre-populate with the expected seed record plus a sentinel to prove it is never rewritten. */
  preload(n: number, overrides: Doc = {}): Doc {
    const record = records[n - 1]
    if (!record) throw new Error(`no record ${n}`)
    const doc = { ...record.data, likelyCause: `SENTINEL ${n}`, ...overrides }
    this.docs.set(record.id, doc)
    return doc
  }
}

describe('runSeed — dry run', () => {
  it('reports 50 would-create records on an empty collection and writes nothing', async () => {
    const store = new FakeStore()
    const report = await runSeed(store, records, { write: false })
    expect(report).toMatchObject({ mode: 'dry-run', total: 50, status: 'COMPLETE' })
    expect(report.wouldCreate).toEqual(ids)
    expect(report.created).toEqual([])
    expect(store.createCalls).toEqual([])
    expect(store.docs.size).toBe(0)
    expect(exitCodeFor(report)).toBe(0)
  })

  it('reports would-create and skipped counts on a partial collection without writing', async () => {
    const store = new FakeStore()
    for (let n = 1; n <= 20; n++) store.preload(n)
    const report = await runSeed(store, records, { write: false })
    expect(report.wouldCreate).toHaveLength(30)
    expect(report.skipped).toEqual(ids.slice(0, 20))
    expect(store.createCalls).toEqual([])
    expect(report.status).toBe('COMPLETE')
  })

  it('reports a conflict as INCOMPLETE with exit 1 even though nothing is written', async () => {
    const store = new FakeStore()
    store.preload(7, { ownerUid: 'someone-else' })
    const report = await runSeed(store, records, { write: false })
    expect(report.conflicts).toEqual([
      {
        id: idOf(7),
        found: { ...identityOf((f) => records[6]?.data[f]), ownerUid: 'someone-else' },
        mismatched: ['ownerUid'],
      },
    ])
    expect(report.status).toBe('INCOMPLETE')
    expect(exitCodeFor(report)).toBe(1)
    expect(store.createCalls).toEqual([])
  })
})

describe('runSeed — create-only writes', () => {
  it('creates all 50 records on an empty collection, each exactly once and in order', async () => {
    const store = new FakeStore()
    const report = await runSeed(store, records, { write: true })
    expect(report).toMatchObject({ mode: 'write', status: 'COMPLETE', skipped: [], failed: [] })
    expect(report.created).toEqual(ids)
    expect(store.createCalls).toEqual(ids)
    expect(store.docs.get(idOf(1))).toEqual(records[0]?.data)
    expect(exitCodeFor(report)).toBe(0)
  })

  it('creates nothing on a repeated run and leaves every document untouched', async () => {
    const store = new FakeStore()
    await runSeed(store, records, { write: true })
    const before = new Map(store.docs)
    store.createCalls.length = 0

    const report = await runSeed(store, records, { write: true })
    expect(report.created).toEqual([])
    expect(report.skipped).toEqual(ids)
    expect(report.status).toBe('COMPLETE')
    expect(store.createCalls).toEqual([])
    for (const [id, doc] of before) expect(store.docs.get(id)).toBe(doc)
  })

  it('fills in a partial collection and never rewrites the existing records', async () => {
    const store = new FakeStore()
    const preloaded = new Map<string, Doc>()
    for (let n = 1; n <= 20; n++) preloaded.set(idOf(n), store.preload(n))

    const report = await runSeed(store, records, { write: true })
    expect(report.created).toEqual(ids.slice(20))
    expect(report.skipped).toEqual(ids.slice(0, 20))
    expect(report.status).toBe('COMPLETE')
    expect(store.createCalls).toEqual(ids.slice(20))
    for (const [id, doc] of preloaded) {
      expect(store.docs.get(id)).toBe(doc)
      expect(store.docs.get(id)?.likelyCause).toMatch(/^SENTINEL/)
    }
  })

  it.each([
    ['a different owner', { ownerUid: 'someone-else' }],
    ['a different incident code', { incidentCode: 'INC-999' }],
  ])('preserves an existing document with %s and reports it as a conflict', async (_, override) => {
    const store = new FakeStore()
    const original = store.preload(7, override)
    const report = await runSeed(store, records, { write: true })

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.id).toBe(idOf(7))
    expect(report.created).toHaveLength(49)
    expect(store.createCalls).not.toContain(idOf(7))
    expect(store.docs.get(idOf(7))).toBe(original)
    expect(report.status).toBe('INCOMPLETE')
    expect(exitCodeFor(report)).toBe(1)
  })

  it('records individual write failures and still creates every other record', async () => {
    const store = new FakeStore()
    const preloaded = store.preload(1)
    store.failCreate.set(idOf(10), new Error('permission denied'))
    store.failCreate.set(idOf(30), new Error('resource exhausted'))

    const report = await runSeed(store, records, { write: true })
    expect(report.failed).toEqual([
      { id: idOf(10), error: 'permission denied' },
      { id: idOf(30), error: 'resource exhausted' },
    ])
    expect(report.created).toHaveLength(47)
    expect(report.skipped).toEqual([idOf(1)])
    expect(store.docs.get(idOf(1))).toBe(preloaded)
    expect(store.docs.has(idOf(10))).toBe(false)
    expect(report.status).toBe('INCOMPLETE')
    expect(exitCodeFor(report)).toBe(1)
  })

  it('makes no writes when the preflight read fails and marks every record failed', async () => {
    const store = new FakeStore()
    store.failReadMany = true
    const report = await runSeed(store, records, { write: true })
    expect(store.createCalls).toEqual([])
    expect(report.failed).toHaveLength(50)
    expect(report.failed[0]?.error).toMatch(/preflight read failed: deadline exceeded/)
    expect(report.status).toBe('INCOMPLETE')
  })
})

describe('runSeed — ALREADY_EXISTS after the preflight', () => {
  it('re-reads and skips the record when the existing document matches', async () => {
    const store = new FakeStore()
    const raced = { ...records[4]?.data }
    store.raceOnCreate.set(idOf(5), raced)

    const report = await runSeed(store, records, { write: true })
    expect(store.readCalls).toEqual([idOf(5)])
    expect(report.skipped).toEqual([idOf(5)])
    expect(report.created).toHaveLength(49)
    expect(report.status).toBe('COMPLETE')
    expect(store.docs.get(idOf(5))).toBe(raced)
  })

  it('re-reads and reports a conflict when the existing document does not match', async () => {
    const store = new FakeStore()
    const raced = { ...records[4]?.data, ownerUid: 'someone-else' }
    store.raceOnCreate.set(idOf(5), raced)

    const report = await runSeed(store, records, { write: true })
    expect(report.conflicts).toEqual([
      {
        id: idOf(5),
        found: { ...identityOf((f) => records[4]?.data[f]), ownerUid: 'someone-else' },
        mismatched: ['ownerUid'],
      },
    ])
    expect(report.skipped).toEqual([])
    expect(store.docs.get(idOf(5))).toBe(raced)
    expect(report.status).toBe('INCOMPLETE')
    expect(exitCodeFor(report)).toBe(1)
  })

  it('reports a failure when the re-read itself fails', async () => {
    const store = new FakeStore()
    store.raceOnCreate.set(idOf(5), { ...records[4]?.data })
    store.failRead.add(idOf(5))

    const report = await runSeed(store, records, { write: true })
    expect(report.failed).toEqual([
      { id: idOf(5), error: 'already exists, and the re-read failed: unavailable' },
    ])
    expect(report.skipped).toEqual([])
    expect(report.status).toBe('INCOMPLETE')
  })

  it('reports a failure when the re-read finds no document', async () => {
    const store = new FakeStore()
    store.raceOnCreate.set(idOf(5), { ...records[4]?.data })
    store.vanishAfterRace.add(idOf(5))

    const report = await runSeed(store, records, { write: true })
    expect(report.failed).toEqual([
      { id: idOf(5), error: 'reported as existing but not found on re-read' },
    ])
    expect(report.status).toBe('INCOMPLETE')
  })
})

describe('runSeed — identity checks on existing documents', () => {
  it('compares exactly ownerUid, incidentCode, deviceId, isSimulated and _schemaVersion', () => {
    expect(IDENTITY_FIELDS).toEqual([
      'ownerUid',
      'incidentCode',
      'deviceId',
      'isSimulated',
      '_schemaVersion',
    ])
  })

  it.each([
    ['a different deviceId', { deviceId: 'SC-0000' }, ['deviceId']],
    ['isSimulated false', { isSimulated: false }, ['isSimulated']],
    ['isSimulated stored as a string', { isSimulated: 'true' }, ['isSimulated']],
    ['a newer _schemaVersion', { _schemaVersion: 2 }, ['_schemaVersion']],
    ['_schemaVersion stored as a string', { _schemaVersion: '1' }, ['_schemaVersion']],
    ['a null ownerUid', { ownerUid: null }, ['ownerUid']],
    ['a numeric incidentCode', { incidentCode: 7 }, ['incidentCode']],
    [
      'several wrong identity fields',
      { deviceId: 'SC-0000', isSimulated: false, _schemaVersion: 0 },
      ['deviceId', 'isSimulated', '_schemaVersion'],
    ],
  ])('reports %s as a conflict and leaves the document untouched', async (_, override, fields) => {
    const store = new FakeStore()
    const original = store.preload(7, override)
    const report = await runSeed(store, records, { write: true })

    expect(report.conflicts).toEqual([expect.objectContaining({ id: idOf(7), mismatched: fields })])
    expect(report.skipped).toEqual([])
    expect(report.created).toHaveLength(49)
    expect(store.createCalls).not.toContain(idOf(7))
    expect(store.docs.get(idOf(7))).toBe(original)
    expect(report.status).toBe('INCOMPLETE')
    expect(exitCodeFor(report)).toBe(1)
  })

  it.each([
    ['missing deviceId', 'deviceId'],
    ['missing isSimulated', 'isSimulated'],
    ['missing _schemaVersion', '_schemaVersion'],
  ] as const)('reports a malformed record (%s) as a conflict', async (_, field) => {
    const store = new FakeStore()
    const original = store.preload(12)
    delete original[field]
    const report = await runSeed(store, records, { write: false })

    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.mismatched).toEqual([field])
    expect(report.conflicts[0]?.found[field]).toBeUndefined()
    expect(store.docs.get(idOf(12))).toBe(original)
    expect(report.status).toBe('INCOMPLETE')
  })

  it('reports an empty document as a conflict on every identity field', async () => {
    const store = new FakeStore()
    store.docs.set(idOf(1), {})
    const report = await runSeed(store, records, { write: true })
    expect(report.conflicts[0]).toMatchObject({ id: idOf(1), mismatched: [...IDENTITY_FIELDS] })
    expect(store.docs.get(idOf(1))).toEqual({})
    expect(exitCodeFor(report)).toBe(1)
  })

  it('skips — and never rewrites — a record whose descriptive fields differ', async () => {
    const store = new FakeStore()
    const original = store.preload(9, {
      likelyCause: 'Edited by an administrator',
      evidenceSummary: 'Different evidence text',
      recommendedAction: 'Different action',
      status: 'SILENT',
      suburb: 'Elsewhere',
      lastSignalAt: new Date('2020-01-01T00:00:00Z'),
      createdAt: new Date('2020-01-01T00:00:00Z'),
    })
    const snapshot = structuredClone(original)

    const report = await runSeed(store, records, { write: true })
    expect(report.skipped).toEqual([idOf(9)])
    expect(report.conflicts).toEqual([])
    expect(store.createCalls).not.toContain(idOf(9))
    expect(store.docs.get(idOf(9))).toBe(original)
    expect(store.docs.get(idOf(9))).toEqual(snapshot)
    expect(report.status).toBe('COMPLETE')
  })

  it('applies the same identity checks after an ALREADY_EXISTS race', async () => {
    const store = new FakeStore()
    const raced = { ...records[4]?.data, _schemaVersion: 2, likelyCause: 'other text' }
    store.raceOnCreate.set(idOf(5), raced)

    const report = await runSeed(store, records, { write: true })
    expect(report.conflicts).toEqual([
      expect.objectContaining({ id: idOf(5), mismatched: ['_schemaVersion'] }),
    ])
    expect(store.docs.get(idOf(5))).toBe(raced)
    expect(report.status).toBe('INCOMPLETE')
  })

  it('mismatchedFields uses strict equality', () => {
    const record = records[0]
    if (!record) throw new Error('missing record')
    const exact = identityOf((f) => record.data[f])
    expect(mismatchedFields(exact, record)).toEqual([])
    expect(mismatchedFields({ ...exact, _schemaVersion: '1', isSimulated: 1 }, record)).toEqual([
      'isSimulated',
      '_schemaVersion',
    ])
  })
})

describe('adminIncidentStore — Admin SDK adapter', () => {
  /**
   * A stand-in exposing only collection(), getAll(), doc().get() and
   * doc().create(). Any call to set/update/delete/batch would throw a TypeError.
   */
  function fakeDb(existing: Record<string, Doc>, createError?: unknown) {
    const collections: string[] = []
    const created: Array<{ id: string; data: unknown }> = []
    const snapshotOf = (id: string) => ({
      id,
      exists: id in existing,
      get: (field: string) => existing[id]?.[field],
    })
    const db = {
      collection(name: string) {
        collections.push(name)
        return {
          doc: (id: string) => ({
            id,
            get: async () => snapshotOf(id),
            create: async (data: unknown) => {
              if (createError) throw createError
              created.push({ id, data })
            },
          }),
        }
      },
      getAll: vi.fn(async (...refs: Array<{ id: string }>) => refs.map((r) => snapshotOf(r.id))),
    }
    return { db: db as unknown as Firestore, raw: db, collections, created }
  }

  it('only ever addresses the incidents collection', () => {
    const { db, collections } = fakeDb({})
    adminIncidentStore(db)
    expect(collections).toEqual(['incidents'])
    expect(INCIDENTS_COLLECTION).toBe(APP_INCIDENTS_COLLECTION)
  })

  it('readMany returns only existing documents, keyed by document ID', async () => {
    const { db } = fakeDb({ a: { ...records[0]?.data, likelyCause: 'ignored' } })
    const found = await adminIncidentStore(db).readMany(['a', 'b'])
    expect([...found.entries()]).toEqual([
      [
        'a',
        {
          ownerUid: OWNER,
          incidentCode: 'INC-001',
          deviceId: records[0]?.data.deviceId,
          isSimulated: true,
          _schemaVersion: 1,
        },
      ],
    ])
  })

  it('readMany skips getAll entirely for an empty list', async () => {
    const { db, raw } = fakeDb({})
    await expect(adminIncidentStore(db).readMany([])).resolves.toEqual(new Map())
    expect(raw.getAll).not.toHaveBeenCalled()
  })

  it('read returns null for a missing document', async () => {
    const { db } = fakeDb({})
    await expect(adminIncidentStore(db).read('missing')).resolves.toBeNull()
  })

  it('create() maps gRPC ALREADY_EXISTS (code 6) to "already-exists"', async () => {
    const data = records[0]!.data
    const ok = fakeDb({})
    await expect(adminIncidentStore(ok.db).create('x', data)).resolves.toBe('created')
    expect(ok.created).toEqual([{ id: 'x', data }])

    const exists = fakeDb({}, Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }))
    await expect(adminIncidentStore(exists.db).create('x', data)).resolves.toBe('already-exists')
  })

  it('create() rethrows every other error', async () => {
    const failing = fakeDb({}, Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }))
    await expect(adminIncidentStore(failing.db).create('x', records[0]!.data)).rejects.toThrow(
      'PERMISSION_DENIED'
    )
  })
})

describe('isAlreadyExistsError', () => {
  it('matches only a numeric code 6', () => {
    expect(isAlreadyExistsError({ code: 6 })).toBe(true)
    expect(isAlreadyExistsError(Object.assign(new Error('x'), { code: 6 }))).toBe(true)
    expect(isAlreadyExistsError({ code: '6' })).toBe(false)
    expect(isAlreadyExistsError({ code: 7 })).toBe(false)
    expect(isAlreadyExistsError(new Error('ALREADY_EXISTS'))).toBe(false)
    expect(isAlreadyExistsError(null)).toBe(false)
  })
})

describe('main — reporting and exit codes (fake store)', () => {
  const ENV = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }
  const ARGS = ['--project', 'demo-safecall', '--owner-uid', OWNER]

  function deps(store: FakeStore) {
    const close = vi.fn(async () => {})
    const d = {
      readEmulatorPort: () => 8080,
      probe: async () => ({ ok: true }) as const,
      openStore: vi.fn(async () => ({ store, close })),
      now: () => NOW,
    } satisfies CliDeps
    return { d, close }
  }

  function io() {
    const out: string[] = []
    const err: string[] = []
    return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
  }

  it('dry run: exit 0, read-only report, no writes, connection closed', async () => {
    const store = new FakeStore()
    const { d, close } = deps(store)
    const o = io()
    await expect(main(ARGS, ENV, o.io, d)).resolves.toBe(0)
    expect(o.out.join('\n')).toMatch(/DRY RUN \(read-only, nothing written\)/)
    expect(o.out.join('\n')).toMatch(/would create: 50/)
    expect(o.out.join('\n')).toMatch(/Status: {2}COMPLETE/)
    expect(store.createCalls).toEqual([])
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('write: exit 0 and 50 created; the same run again is all skipped', async () => {
    const store = new FakeStore()
    const { d } = deps(store)
    await expect(main([...ARGS, '--write'], ENV, io().io, d)).resolves.toBe(0)
    expect(store.docs.size).toBe(50)

    const again = io()
    await expect(main([...ARGS, '--write'], ENV, again.io, d)).resolves.toBe(0)
    expect(again.out.join('\n')).toMatch(/created: 0/)
    expect(again.out.join('\n')).toMatch(/skipped \(already present, untouched\): 50/)
  })

  it('a conflict prints INCOMPLETE with the conflicting ID and exits 1', async () => {
    const store = new FakeStore()
    store.preload(3, { ownerUid: 'someone-else' })
    const { d, close } = deps(store)
    const o = io()
    await expect(main([...ARGS, '--write'], ENV, o.io, d)).resolves.toBe(1)
    const text = o.out.join('\n')
    expect(text).toContain(`CONFLICT ${idOf(3)}: unexpected ownerUid="someone-else"`)
    expect(text).toMatch(/Status: {2}INCOMPLETE/)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('lists every mismatched identity field for a conflict, marking missing ones', async () => {
    const store = new FakeStore()
    const doc = store.preload(4, { isSimulated: false })
    delete doc.deviceId
    const { d } = deps(store)
    const o = io()
    await expect(main(ARGS, ENV, o.io, d)).resolves.toBe(1)
    expect(o.out.join('\n')).toContain(
      `CONFLICT ${idOf(4)}: unexpected deviceId=missing isSimulated=false`
    )
  })

  it('--json prints a machine-readable report with the target and status', async () => {
    const store = new FakeStore()
    const { d } = deps(store)
    const o = io()
    await expect(main([...ARGS, '--json'], ENV, o.io, d)).resolves.toBe(0)
    const parsed: unknown = JSON.parse(o.out.join(''))
    expect(parsed).toMatchObject({
      projectId: 'demo-safecall',
      emulatorHost: '127.0.0.1:8080',
      ownerUid: OWNER,
      mode: 'dry-run',
      total: 50,
      status: 'COMPLETE',
    })
  })

  it('builds the records from the injected clock', async () => {
    const store = new FakeStore()
    const { d } = deps(store)
    await main([...ARGS, '--write'], ENV, io().io, d)
    expect(store.docs.get(idOf(1))?.createdAt).toEqual(NOW)
  })
})
