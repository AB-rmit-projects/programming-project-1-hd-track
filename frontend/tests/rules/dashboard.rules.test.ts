import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  addDoc,
  collection,
  getDocs,
  onSnapshot,
  query,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore'
import { deleteApp, initializeApp, type App } from 'firebase-admin/app'
import {
  FieldValue,
  getFirestore as getAdminFirestore,
  type Firestore as AdminFirestore,
} from 'firebase-admin/firestore'
import {
  ACTION_LOGS_COLLECTION,
  INCIDENTS_COLLECTION,
  ownIncidentsConstraints,
  reviewedActionsConstraints,
} from '@/lib/firebase/firestore'
import { parseIncident } from '@/features/incidents/incidentRow'
import {
  confirmedReviewEvidence,
  deriveReviewSummary,
  type ReviewEvidence,
} from '@/features/incidents/reviewSummary'
import type { ActionType } from '@/types/firestore'
import {
  ALICE,
  BOB,
  PROJECT_ID,
  anonymousVisitor,
  createTestEnv,
  seedActionLog,
  unverifiedUser,
  validActionLog,
  verifiedUser,
} from './helpers'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents, type SeedRecord } from '../../scripts/seed-incidents/dataset'
import { adminIncidentStore, runSeed, type SeedReport } from '../../scripts/seed-incidents/seed'

// Phase 4 dashboard (Screen A) against the real Firestore emulator and the real
// security rules: incidents seeded by the real Phase 3 seed runner, the
// dashboard's own two owner-scoped queries run as a verified operator through
// the client SDK, then the real CP1 parsing and review derivation.
//
// The queries use the same collection names and the same constraint helpers
// as useIncidentDashboard; only the Firestore instance differs (the emulator
// test context instead of getClientDb()).

const NOW = new Date('2026-10-21T00:00:00.000Z')
const CAROL = 'carol-uid' // a verified operator with no incidents

let env: RulesTestEnvironment
let adminApp: App
let adminDb: AdminFirestore
let aliceSeed: SeedReport

const incidentId = (owner: string, code: string) => `${owner}_${code}`

beforeAll(async () => {
  // Set by `firebase emulators:exec`; the Admin SDK then needs no credentials.
  expect(process.env.FIRESTORE_EMULATOR_HOST).toBeTruthy()
  env = await createTestEnv()
  adminApp = initializeApp({ projectId: PROJECT_ID }, 'dashboard-rules-test')
  adminDb = getAdminFirestore(adminApp)
})

afterAll(async () => {
  await deleteApp(adminApp)
  await env.cleanup()
})

beforeEach(async () => {
  await env.clearFirestore()
  const store = adminIncidentStore(adminDb)
  aliceSeed = await runSeed(store, buildSeedIncidents(ALICE, NOW), { write: true })
  await runSeed(store, buildSeedIncidents(BOB, NOW), { write: true })
})

// ── The dashboard's two queries ──────────────────────────────────────────────

function incidentsQuery(db: Firestore, uid: string) {
  return query(collection(db, INCIDENTS_COLLECTION), ...ownIncidentsConstraints(uid))
}

function reviewedQuery(db: Firestore, uid: string) {
  return query(collection(db, ACTION_LOGS_COLLECTION), ...reviewedActionsConstraints(uid))
}

/** CP1 parsing + derivation over query snapshots, as the hook does it. */
function summarise(incidents: QuerySnapshot, reviewed: QuerySnapshot) {
  const parsed = incidents.docs.map((d) => parseIncident(d.id, d.data()))
  const rows = parsed.flatMap((p) => (p.ok ? [p.row] : []))
  const logs = reviewed.docs.map((d) => {
    const { incidentId, actionType } = d.data() as { incidentId: string; actionType: ActionType }
    return { incidentId, actionType }
  })
  return {
    rejected: parsed.filter((p) => !p.ok),
    summary: deriveReviewSummary(rows, logs),
  }
}

/** Runs both dashboard queries as a verified operator and summarises them. */
async function dashboardFor(uid: string) {
  const db = verifiedUser(env, uid)
  const [incidents, reviewed] = await Promise.all([
    getDocs(incidentsQuery(db, uid)),
    getDocs(reviewedQuery(db, uid)),
  ])
  return { incidents, reviewed, ...summarise(incidents, reviewed) }
}

async function countsFor(uid: string) {
  const { summary } = await dashboardFor(uid)
  return { total: summary.total, awaiting: summary.awaiting, reviewed: summary.reviewed }
}

/** Creates an action log through the security rules, as Phase 5's form will. */
async function record(uid: string, actionType: ActionType, code: string) {
  const db = verifiedUser(env, uid)
  await assertSucceeds(
    addDoc(
      collection(db, ACTION_LOGS_COLLECTION),
      validActionLog({ ownerUid: uid, incidentId: incidentId(uid, code), actionType })
    )
  )
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('dashboard data — seeded baseline', () => {
  it('the Phase 3 seed runner created 50 incidents for the operator', async () => {
    expect(aliceSeed.status).toBe('COMPLETE')
    expect(aliceSeed.created).toHaveLength(50)
    const stored = await adminDb
      .collection(INCIDENTS_COLLECTION)
      .where('ownerUid', '==', ALICE)
      .get()
    expect(stored.size).toBe(50)
  })

  it("a verified operator's incident query returns exactly their 50 incidents", async () => {
    const db = verifiedUser(env, ALICE)
    const snap = await assertSucceeds(getDocs(incidentsQuery(db, ALICE)))

    expect(snap.size).toBe(50)
    expect(snap.docs.every((d) => d.data().ownerUid === ALICE)).toBe(true)
    expect(snap.docs.map((d) => d.id).sort()).toEqual(
      buildSeedIncidents(ALICE, NOW)
        .map((r: SeedRecord) => r.id)
        .sort()
    )
  })

  it('the REVIEWED-action query initially returns nothing', async () => {
    const db = verifiedUser(env, ALICE)
    const snap = await assertSucceeds(getDocs(reviewedQuery(db, ALICE)))
    expect(snap.size).toBe(0)
  })

  it('CP1 parsing and derivation give 50 total, 50 awaiting, 0 reviewed with no data issues', async () => {
    const { summary, rejected } = await dashboardFor(ALICE)

    expect(rejected).toEqual([])
    expect(summary).toMatchObject({ total: 50, awaiting: 50, reviewed: 0 })
    expect(summary.rows.every((row) => row.dataIssues.length === 0)).toBe(true)
    expect(summary.rows.every((row) => row.lastSignalAt instanceof Date)).toBe(true)
  })
})

describe('dashboard data — review counts after decisions recorded through the rules', () => {
  it('one REVIEWED log: 50 / 49 / 1, and that incident is reviewed', async () => {
    await record(ALICE, 'REVIEWED', 'INC-007')

    const { summary, reviewed } = await dashboardFor(ALICE)
    expect(reviewed.size).toBe(1)
    expect(summary).toMatchObject({ total: 50, awaiting: 49, reviewed: 1 })
    expect(summary.rows.find((r) => r.incidentCode === 'INC-007')?.reviewStatus).toBe('REVIEWED')
  })

  it('ACKNOWLEDGE and ESCALATE are not returned by the REVIEWED query and never count', async () => {
    await record(ALICE, 'ACKNOWLEDGE', 'INC-001')
    await record(ALICE, 'ESCALATE', 'INC-002')
    expect(await countsFor(ALICE)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })

    await record(ALICE, 'REVIEWED', 'INC-003')
    await record(ALICE, 'ESCALATE', 'INC-003')
    const { summary, reviewed } = await dashboardFor(ALICE)
    expect(reviewed.docs.map((d) => d.data().actionType)).toEqual(['REVIEWED'])
    expect(summary).toMatchObject({ total: 50, awaiting: 49, reviewed: 1 })
  })

  it('three REVIEWED logs for one incident are all returned but count once', async () => {
    for (let i = 0; i < 3; i++) await record(ALICE, 'REVIEWED', 'INC-010')

    const { summary, reviewed } = await dashboardFor(ALICE)
    expect(reviewed.size).toBe(3)
    expect(summary).toMatchObject({ total: 50, awaiting: 49, reviewed: 1 })
  })

  it('a REVIEWED log for an incident outside the queue does not affect the counts', async () => {
    const missing = incidentId(ALICE, 'INC-999')
    // The rules refuse to create it from the client…
    await assertFails(
      addDoc(
        collection(verifiedUser(env, ALICE), ACTION_LOGS_COLLECTION),
        validActionLog({ ownerUid: ALICE, incidentId: missing, actionType: 'REVIEWED' })
      )
    )
    // …so it is written with rules bypassed, as stray data could be.
    await seedActionLog(env, 'stray-log', {
      ...validActionLog({ ownerUid: ALICE, incidentId: missing, actionType: 'REVIEWED' }),
      createdAt: NOW,
    })

    const { summary, reviewed } = await dashboardFor(ALICE)
    expect(reviewed.size).toBe(1) // returned by the owner-scoped query…
    expect(summary).toMatchObject({ total: 50, awaiting: 50, reviewed: 0 }) // …but ignored
  })
})

describe('dashboard data — owner isolation', () => {
  it("another operator's incidents and action logs are never returned", async () => {
    await record(BOB, 'REVIEWED', 'INC-001')
    await record(BOB, 'REVIEWED', 'INC-002')

    const alice = await dashboardFor(ALICE)
    expect(alice.incidents.docs.some((d) => d.data().ownerUid !== ALICE)).toBe(false)
    expect(alice.reviewed.size).toBe(0)
    expect(alice.summary).toMatchObject({ total: 50, awaiting: 50, reviewed: 0 })

    // Bob's own dashboard reflects his decisions only.
    expect(await countsFor(BOB)).toEqual({ total: 50, awaiting: 48, reviewed: 2 })
  })

  it("querying another operator's records is rejected outright, not filtered", async () => {
    const db = verifiedUser(env, ALICE)
    await assertFails(getDocs(incidentsQuery(db, BOB)))
    await assertFails(getDocs(reviewedQuery(db, BOB)))
  })

  it('anonymous visitors cannot run either dashboard query', async () => {
    const db = anonymousVisitor(env)
    await assertFails(getDocs(incidentsQuery(db, ALICE)))
    await assertFails(getDocs(reviewedQuery(db, ALICE)))
  })

  it('an owner whose email is not verified cannot run either dashboard query', async () => {
    const db = unverifiedUser(env, ALICE)
    await assertFails(getDocs(incidentsQuery(db, ALICE)))
    await assertFails(getDocs(reviewedQuery(db, ALICE)))
  })

  it('a verified operator with no assigned incidents gets 0 / 0 / 0', async () => {
    const { summary, incidents, reviewed } = await dashboardFor(CAROL)
    expect(incidents.size).toBe(0)
    expect(reviewed.size).toBe(0)
    expect(summary).toEqual({ rows: [], total: 0, awaiting: 0, reviewed: 0 })
  })
})

describe('dashboard data — simulated-data integrity', () => {
  it.each([
    ['isSimulated: false', { isSimulated: false }],
    ['isSimulated missing', { isSimulated: undefined }],
    ['isSimulated: "true"', { isSimulated: 'true' }],
  ])('an owned incident stored with %s is rejected by the parser', async (_label, change) => {
    const id = incidentId(ALICE, 'INC-010')
    const ref = adminDb.collection(INCIDENTS_COLLECTION).doc(id)
    // An administrator-side mistake (Admin SDK, bypasses rules).
    await ref.update(
      change.isSimulated === undefined ? { isSimulated: FieldValue.delete() } : change
    )

    const { incidents, rejected } = await dashboardFor(ALICE)
    expect(incidents.size).toBe(50) // still returned by the owner query
    expect(rejected).toEqual([{ ok: false, id, reason: 'NOT_SIMULATED' }])
  })
})

describe('dashboard data — live listeners (the Phase 5 refresh path)', () => {
  it('onSnapshot delivers server-confirmed data, then a newly recorded REVIEWED log', async () => {
    const db = verifiedUser(env, ALICE)
    const incidentSnaps: QuerySnapshot[] = []
    const reviewedSnaps: QuerySnapshot[] = []
    const options = { includeMetadataChanges: true }

    const stopIncidents = onSnapshot(incidentsQuery(db, ALICE), options, (s: QuerySnapshot) =>
      incidentSnaps.push(s)
    )
    const stopReviewed = onSnapshot(reviewedQuery(db, ALICE), options, (s: QuerySnapshot) =>
      reviewedSnaps.push(s)
    )

    try {
      const confirmed = (snaps: QuerySnapshot[]) => snaps.filter((s) => !s.metadata.fromCache)

      await vi.waitFor(
        () => {
          expect(confirmed(incidentSnaps).length).toBeGreaterThan(0)
          expect(confirmed(reviewedSnaps).length).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
      const firstIncidents = confirmed(incidentSnaps)[0]!
      const firstReviewed = confirmed(reviewedSnaps)[0]!
      expect(firstIncidents.size).toBe(50)
      expect(firstReviewed.size).toBe(0)
      expect(summarise(firstIncidents, firstReviewed).summary).toMatchObject({
        total: 50,
        awaiting: 50,
        reviewed: 0,
      })
      // No cached snapshot claimed an empty incident list before the server answered.
      expect(incidentSnaps.some((s) => s.metadata.fromCache && s.empty)).toBe(false)

      await addDoc(
        collection(db, ACTION_LOGS_COLLECTION),
        validActionLog({
          ownerUid: ALICE,
          incidentId: incidentId(ALICE, 'INC-005'),
          actionType: 'REVIEWED',
        })
      )

      // The live listener receives the new log once the server has committed it.
      await vi.waitFor(
        () => {
          const latest = reviewedSnaps.at(-1)!
          expect(latest.size).toBe(1)
          expect(latest.metadata.fromCache).toBe(false)
          expect(latest.metadata.hasPendingWrites).toBe(false)
        },
        { timeout: 10_000 }
      )
      expect(summarise(incidentSnaps.at(-1)!, reviewedSnaps.at(-1)!).summary).toMatchObject({
        total: 50,
        awaiting: 49,
        reviewed: 1,
      })
      expect(incidentSnaps.length).toBeGreaterThan(0)
    } finally {
      stopIncidents()
      stopReviewed()
    }
  })
})

describe('dashboard data — unconfirmed writes (real SDK metadata, Phase 5 CP2)', () => {
  // The client SDK shows a new document in query results as soon as it is
  // written locally, marked hasPendingWrites, before the server has answered.
  // These run the dashboard's REVIEWED query and its real filter
  // (confirmedReviewEvidence) over every snapshot the SDK delivers.

  const options = { includeMetadataChanges: true }

  function reviewedCount(incidents: QuerySnapshot, reviewed: QuerySnapshot) {
    const rows = incidents.docs.flatMap((d) => {
      const parsed = parseIncident(d.id, d.data())
      return parsed.ok ? [parsed.row] : []
    })
    // The emulator context's queries are untyped; keep each document's real
    // SDK metadata and type only its data, as getActionLogsCollection() does.
    const docs = reviewed.docs.map((d) => ({
      metadata: d.metadata,
      data: () => d.data() as ReviewEvidence,
    }))
    return deriveReviewSummary(rows, confirmedReviewEvidence(docs)).reviewed
  }

  it('a REVIEWED log counts only after the server accepts it, through a metadata change', async () => {
    const db = verifiedUser(env, ALICE)
    const incidents = await getDocs(incidentsQuery(db, ALICE))
    const snaps: QuerySnapshot[] = []
    const stop = onSnapshot(reviewedQuery(db, ALICE), options, (s: QuerySnapshot) => snaps.push(s))

    try {
      await vi.waitFor(() => expect(snaps.some((s) => !s.metadata.fromCache)).toBe(true), {
        timeout: 10_000,
      })
      const write = addDoc(
        collection(db, ACTION_LOGS_COLLECTION),
        validActionLog({
          ownerUid: ALICE,
          incidentId: incidentId(ALICE, 'INC-005'),
          actionType: 'REVIEWED',
        })
      )

      await assertSucceeds(write)
      await vi.waitFor(
        () => {
          const latest = snaps.at(-1)!
          expect(latest.size).toBe(1)
          expect(latest.docs[0]!.metadata.hasPendingWrites).toBe(false)
        },
        { timeout: 10_000 }
      )

      // The SDK did deliver the log while it was pending, and it did not count then.
      const pendingSnaps = snaps.filter((s) => s.docs.some((d) => d.metadata.hasPendingWrites))
      expect(pendingSnaps.length).toBeGreaterThan(0)
      for (const s of pendingSnaps) expect(reviewedCount(incidents, s)).toBe(0)

      // Accepted: the same document again with the flag cleared, now counted.
      const pendingId = pendingSnaps[0]!.docs[0]!.id
      expect(snaps.at(-1)!.docs[0]!.id).toBe(pendingId)
      expect(reviewedCount(incidents, snaps.at(-1)!)).toBe(1)
    } finally {
      stop()
    }
  })

  it('a REVIEWED log the rules reject is shown pending, then dropped, and never counts', async () => {
    const db = verifiedUser(env, ALICE)
    const incidents = await getDocs(incidentsQuery(db, ALICE))
    const snaps: QuerySnapshot[] = []
    const stop = onSnapshot(reviewedQuery(db, ALICE), options, (s: QuerySnapshot) => snaps.push(s))

    try {
      await vi.waitFor(() => expect(snaps.some((s) => !s.metadata.fromCache)).toBe(true), {
        timeout: 10_000,
      })
      // A 5-character note: valid in shape, refused by the create rule.
      await assertFails(
        addDoc(
          collection(db, ACTION_LOGS_COLLECTION),
          validActionLog({
            ownerUid: ALICE,
            incidentId: incidentId(ALICE, 'INC-005'),
            actionType: 'REVIEWED',
            note: 'short',
          })
        )
      )
      await vi.waitFor(() => expect(snaps.at(-1)!.size).toBe(0), { timeout: 10_000 })

      expect(snaps.some((s) => s.docs.some((d) => d.metadata.hasPendingWrites))).toBe(true)
      for (const s of snaps) expect(reviewedCount(incidents, s)).toBe(0)
    } finally {
      stop()
    }
  })
})
