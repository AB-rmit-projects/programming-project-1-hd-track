import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  addDoc,
  collection,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  Timestamp,
  where,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore'
import {
  ACTION_LOGS_COLLECTION,
  INCIDENTS_COLLECTION,
  actionHistoryConstraints,
  getActionLogsCollection,
  getIncidentsCollection,
  incidentDoc,
  ownIncidentsConstraints,
  reviewedActionsConstraints,
} from '@/lib/firebase/firestore'
import { buildActionHistory, deriveIncidentReviewStatus } from '@/features/incidents/actionHistory'
import { startDecisionWrite } from '@/features/incidents/decisionWriter'
import { buildActionLogData } from '@/features/incidents/decisions'
import { parseIncidentDetail } from '@/features/incidents/incidentDetail'
import { parseIncident } from '@/features/incidents/incidentRow'
import { confirmedReviewEvidence, deriveReviewSummary } from '@/features/incidents/reviewSummary'
import type { ActionLog } from '@/types/firestore'
import {
  ALICE,
  BOB,
  PROJECT_ID,
  anonymousVisitor,
  assertEmulatorOnly,
  clearEmulator,
  createTestEnv,
  dbOf,
  terminateClient,
  firebaseAppProjectIds,
  incidentFixture,
  seedActionLog,
  seedDataset,
  seedIncidents,
  unverifiedUser,
  validActionLog,
  verifiedUser,
} from './helpers'

// Phase 5 CP6: the decision workflow against the real Firestore SDK and the
// real, unchanged security rules on the local demo-safecall emulator.
//
// What runs for real: the app's collection helpers and query constraints
// (lib/firebase/firestore.ts), the write adapter (startDecisionWrite →
// buildActionLogData → addDoc), the parsers and the review derivations.
// The only substitution: the app's own Firestore client (getClientDb) is
// replaced by the emulator test context of the operator under test, so the
// app module that would read the real project's config is never loaded.

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/firebase/client', () => ({
  getClientDb: () => {
    if (!db.current) throw new Error('No emulator Firestore selected for this test.')
    return db.current
  },
}))

const NOW = new Date('2026-10-21T00:00:00.000Z')
const NOTE = 'Checked the simulated outage evidence.'
const SIX_FIELDS = ['_schemaVersion', 'actionType', 'createdAt', 'incidentId', 'note', 'ownerUid']
const REFUSED = {
  code: 'permission-denied',
  message:
    'The decision was refused. Your session may have ended, or this incident is not available to your account.',
}
const id = (owner: string, code: string) => `${owner}_${code}`
type Counts = { total: number; awaiting: number; reviewed: number }

let env: RulesTestEnvironment

beforeAll(async () => {
  assertEmulatorOnly() // before any SDK call
  env = await createTestEnv()
})

afterAll(async () => {
  await env.cleanup()
})

beforeEach(async () => {
  db.current = null
  await clearEmulator(env)
})

// Every client a test used is terminated, so no listen stream outlives its
// test (a stream abandoned during a network toggle otherwise makes the
// emulator's next clearFirestore() fail with "Stream is already completed").
const clients = new Set<Firestore>()

afterEach(async () => {
  db.current = null
  for (const client of clients) await terminateClient(client)
  clients.clear()
})

/** The operator whose Firestore the app's helpers will use. */
function signInAs(firestore: Firestore): Firestore {
  clients.add(firestore)
  db.current = firestore
  return firestore
}

/** Records a decision through the app's write adapter and waits for the server's answer. */
async function decide(ownerUid: string, incidentId: string, actionType: string, note = NOTE) {
  const start = startDecisionWrite(ownerUid, incidentId, { actionType, note })
  if (!start.started) throw new Error(`not started: ${JSON.stringify(start.issues)}`)
  return start.confirmed
}

/** An action log by ID, through the app's typed collection helper. */
function logRef(actionLogId: string) {
  return doc(getActionLogsCollection(), actionLogId)
}

/** The actionLogs collection on a given Firestore, for payloads that bypass the adapter. */
function rawLogs(firestore: Firestore) {
  return collection(firestore, ACTION_LOGS_COLLECTION)
}

/** Whether no action log refers to the incident (read with rules bypassed). */
async function nothingStoredFor(incidentId: string): Promise<boolean> {
  let size = -1
  await env.withSecurityRulesDisabled(async (context) => {
    size = (await getDocs(query(rawLogs(dbOf(context)), where('incidentId', '==', incidentId))))
      .size
  })
  return size === 0
}

/** The dashboard's two queries and derivation, exactly as useIncidentDashboard combines them. */
async function dashboardCounts(uid: string) {
  const [incidents, reviewed] = await Promise.all([
    getDocs(query(getIncidentsCollection(), ...ownIncidentsConstraints(uid))),
    getDocs(query(getActionLogsCollection(), ...reviewedActionsConstraints(uid))),
  ])
  const rows = incidents.docs.flatMap((d) => {
    const parsed = parseIncident(d.id, d.data())
    return parsed.ok ? [parsed.row] : []
  })
  const summary = deriveReviewSummary(rows, confirmedReviewEvidence(reviewed.docs))
  const counts: Counts = {
    total: summary.total,
    awaiting: summary.awaiting,
    reviewed: summary.reviewed,
  }
  return { counts, summary, reviewedLogIds: reviewed.docs.map((d) => d.id) }
}

/** The detail page's history query and parsing, exactly as useIncidentDetail combines them. */
async function history(uid: string, incidentId: string) {
  const snapshot = await getDocs(
    query(getActionLogsCollection(), ...actionHistoryConstraints(uid, incidentId))
  )
  const built = buildActionHistory(
    snapshot.docs
      .filter((d) => !d.metadata.hasPendingWrites)
      .map((d) => ({ id: d.id, data: d.data() })),
    { ownerUid: uid, incidentId }
  )
  return { snapshot, ...built, reviewStatus: deriveIncidentReviewStatus(incidentId, built.entries) }
}

// ── Isolation ────────────────────────────────────────────────────────────────

describe('emulator isolation', () => {
  it('runs only against the local demo-safecall emulator, and writes land there', async () => {
    assertEmulatorOnly()
    const alice = signInAs(verifiedUser(env, ALICE))
    await seedIncidents(env, [{ id: id(ALICE, 'INC-001'), ownerUid: ALICE }])
    const outcome = await decide(ALICE, id(ALICE, 'INC-001'), 'ACKNOWLEDGE')
    if (!outcome.ok) throw new Error(outcome.error.code)

    // Every Firebase app this process created belongs to the demo project.
    expect(firebaseAppProjectIds().length).toBeGreaterThan(0)
    expect(new Set(firebaseAppProjectIds())).toEqual(new Set([PROJECT_ID]))
    const app = (alice as unknown as { app: { options: { projectId: string } } }).app
    expect(app.options.projectId).toBe(PROJECT_ID)

    // The document is in the local emulator: read it back over the emulator's
    // own REST API ("Bearer owner" bypasses rules; it only works on an emulator).
    const response = await fetch(
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents/actionLogs/${outcome.actionLogId}`,
      { headers: { Authorization: 'Bearer owner' } }
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { fields: Record<string, unknown> }
    expect(Object.keys(body.fields).sort()).toEqual(SIX_FIELDS)
  })
})

// ── A. Reads ─────────────────────────────────────────────────────────────────

describe('A. incident and history reads', () => {
  const at = (iso: string) => Timestamp.fromDate(new Date(iso))

  beforeEach(async () => {
    await seedIncidents(env, [
      { id: id(ALICE, 'INC-001'), ownerUid: ALICE },
      { id: id(ALICE, 'INC-002'), ownerUid: ALICE },
      { id: id(BOB, 'INC-001'), ownerUid: BOB },
    ])
  })

  it('a verified operator reads their own simulated incident through incidentDoc()', async () => {
    signInAs(verifiedUser(env, ALICE))
    const snap = await assertSucceeds(getDoc(incidentDoc(id(ALICE, 'INC-001'))))
    expect(parseIncidentDetail(snap.id, snap.data(), { ownerUid: ALICE })).toMatchObject({
      ok: true,
    })
  })

  it("another operator's incident and a missing one are refused the same way", async () => {
    signInAs(verifiedUser(env, ALICE))
    const codes: Array<string | undefined> = []
    for (const target of [id(BOB, 'INC-001'), id(ALICE, 'INC-999')]) {
      const error = await getDoc(incidentDoc(target)).then(
        () => ({ code: 'read succeeded' }),
        (e: { code?: string }) => e
      )
      codes.push(error.code)
    }
    expect(codes).toEqual(['permission-denied', 'permission-denied'])
  })

  it('an unverified or signed-out operator cannot read the incident', async () => {
    signInAs(unverifiedUser(env, ALICE))
    await assertFails(getDoc(incidentDoc(id(ALICE, 'INC-001'))))
    signInAs(anonymousVisitor(env))
    await assertFails(getDoc(incidentDoc(id(ALICE, 'INC-001'))))
  })

  it("the history query returns only this operator's logs for this incident", async () => {
    const base = {
      note: NOTE,
      actionType: 'ACKNOWLEDGE',
      _schemaVersion: 1,
      createdAt: at('2026-10-24T01:00:00Z'),
    }
    await seedActionLog(env, 'mine', { ...base, ownerUid: ALICE, incidentId: id(ALICE, 'INC-001') })
    await seedActionLog(env, 'other-incident', {
      ...base,
      ownerUid: ALICE,
      incidentId: id(ALICE, 'INC-002'),
    })
    await seedActionLog(env, 'other-owner', {
      ...base,
      ownerUid: BOB,
      incidentId: id(ALICE, 'INC-001'),
    })

    signInAs(verifiedUser(env, ALICE))
    const result = await history(ALICE, id(ALICE, 'INC-001'))
    expect(result.snapshot.docs.map((d) => d.id)).toEqual(['mine'])
    expect(result.rejectedCount).toBe(0)
  })

  it("a history query for another operator's logs is refused, not filtered", async () => {
    signInAs(verifiedUser(env, ALICE))
    await assertFails(
      getDocs(
        query(getActionLogsCollection(), ...actionHistoryConstraints(BOB, id(BOB, 'INC-001')))
      )
    )
  })

  it('a server-confirmed empty history is empty (first non-cache snapshot)', async () => {
    signInAs(verifiedUser(env, ALICE))
    const snaps: QuerySnapshot<ActionLog>[] = []
    const stop = onSnapshot(
      query(getActionLogsCollection(), ...actionHistoryConstraints(ALICE, id(ALICE, 'INC-001'))),
      { includeMetadataChanges: true },
      (s) => snaps.push(s)
    )
    try {
      await vi.waitFor(() => expect(snaps.some((s) => !s.metadata.fromCache)).toBe(true), {
        timeout: 10_000,
      })
      expect(snaps.find((s) => !s.metadata.fromCache)!.size).toBe(0)
    } finally {
      stop()
    }
  })

  it('logs come back newest first; equal timestamps are ordered deterministically by the app', async () => {
    const base = {
      ownerUid: ALICE,
      incidentId: id(ALICE, 'INC-001'),
      note: NOTE,
      _schemaVersion: 1,
    }
    const tie = at('2026-10-24T02:00:00.000Z')
    await seedActionLog(env, 'b-tie', { ...base, actionType: 'ESCALATE', createdAt: tie })
    await seedActionLog(env, 'a-tie', { ...base, actionType: 'REVIEWED', createdAt: tie })
    await seedActionLog(env, 'oldest', {
      ...base,
      actionType: 'ACKNOWLEDGE',
      createdAt: at('2026-10-24T01:00:00.000Z'),
    })
    await seedActionLog(env, 'newest', {
      ...base,
      actionType: 'REVIEWED',
      createdAt: at('2026-10-24T02:00:00.001Z'),
    })

    signInAs(verifiedUser(env, ALICE))
    const result = await history(ALICE, id(ALICE, 'INC-001'))
    const times = result.snapshot.docs.map((d) => d.data().createdAt.toMillis())
    expect(times).toEqual([...times].sort((x, y) => y - x)) // the query: createdAt descending
    expect(result.snapshot.docs[0]!.id).toBe('newest')
    expect(result.snapshot.docs.at(-1)!.id).toBe('oldest')
    // The app re-sorts and breaks a tie by document ID, whatever the query's tie order.
    expect(result.entries.map((e) => e.id)).toEqual(['newest', 'a-tie', 'b-tie', 'oldest'])
  })
})

// ── B. Real writes ───────────────────────────────────────────────────────────

describe('B. decisions written through the app adapter', () => {
  it.each([
    ['ACKNOWLEDGE', { total: 50, awaiting: 50, reviewed: 0 }],
    ['ESCALATE', { total: 50, awaiting: 50, reviewed: 0 }],
    ['REVIEWED', { total: 50, awaiting: 49, reviewed: 1 }],
  ])(
    '%s creates exactly one six-field log with a server timestamp; counts become %o',
    async (actionType, after) => {
      await seedDataset(env, ALICE, NOW)
      signInAs(verifiedUser(env, ALICE))
      const incident = id(ALICE, 'INC-007')
      expect((await dashboardCounts(ALICE)).counts).toEqual({
        total: 50,
        awaiting: 50,
        reviewed: 0,
      })

      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const before = Date.now()
      const outcome = await decide(ALICE, incident, actionType, `  ${NOTE}\n`)
      expect(fetchSpy).not.toHaveBeenCalled() // nothing beyond the Firestore write, ESCALATE included
      fetchSpy.mockRestore()
      if (!outcome.ok) throw new Error(outcome.error.code)

      const saved = (await getDoc(logRef(outcome.actionLogId))).data()!
      expect(Object.keys(saved).sort()).toEqual(SIX_FIELDS)
      expect(saved).toMatchObject({
        ownerUid: ALICE,
        incidentId: incident,
        actionType,
        note: NOTE,
        _schemaVersion: 1,
      })
      expect(saved.createdAt).toBeInstanceOf(Timestamp)
      expect(Math.abs(saved.createdAt.toMillis() - before)).toBeLessThan(60_000)

      const logs = await history(ALICE, incident)
      expect(logs.entries.map((e) => e.id)).toEqual([outcome.actionLogId])
      expect(logs.reviewStatus).toBe(actionType === 'REVIEWED' ? 'REVIEWED' : 'AWAITING_REVIEW')
      expect((await dashboardCounts(ALICE)).counts).toEqual(after)
    }
  )
})

// ── C. Dashboard progression ─────────────────────────────────────────────────

describe('C. dashboard counts from real records', () => {
  it('progress through ACKNOWLEDGE, ESCALATE and REVIEWED exactly as AC-10 defines', async () => {
    await seedDataset(env, ALICE, NOW)
    await seedDataset(env, BOB, NOW) // another operator's data must never count
    signInAs(verifiedUser(env, ALICE))
    const first = id(ALICE, 'INC-003')
    const second = id(ALICE, 'INC-011')

    const steps: Array<[string, string | null, string, Counts]> = [
      ['before decisions', null, '', { total: 50, awaiting: 50, reviewed: 0 }],
      ['after ACKNOWLEDGE', first, 'ACKNOWLEDGE', { total: 50, awaiting: 50, reviewed: 0 }],
      ['after ESCALATE', first, 'ESCALATE', { total: 50, awaiting: 50, reviewed: 0 }],
      ['after first REVIEWED', first, 'REVIEWED', { total: 50, awaiting: 49, reviewed: 1 }],
      [
        'after second REVIEWED, same incident',
        first,
        'REVIEWED',
        { total: 50, awaiting: 49, reviewed: 1 },
      ],
      [
        'after REVIEWED on another incident',
        second,
        'REVIEWED',
        { total: 50, awaiting: 48, reviewed: 2 },
      ],
    ]

    for (const [label, incident, actionType, expected] of steps) {
      if (incident)
        expect(await decide(ALICE, incident, actionType), label).toMatchObject({ ok: true })
      expect((await dashboardCounts(ALICE)).counts, label).toEqual(expected)
    }

    // The records underneath: 3 REVIEWED logs (2 on one incident), 5 logs in all.
    const { reviewedLogIds, summary } = await dashboardCounts(ALICE)
    expect(reviewedLogIds).toHaveLength(3)
    expect(
      summary.rows
        .filter((r) => r.reviewStatus === 'REVIEWED')
        .map((r) => r.id)
        .sort()
    ).toEqual([first, second].sort())
    expect((await history(ALICE, first)).entries.map((e) => e.actionType)).toEqual([
      'REVIEWED',
      'REVIEWED',
      'ESCALATE',
      'ACKNOWLEDGE',
    ])
    expect((await history(ALICE, second)).entries).toHaveLength(1)

    // Bob's dashboard is untouched by Alice's decisions.
    signInAs(verifiedUser(env, BOB))
    expect((await dashboardCounts(BOB)).counts).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
  })
})

// ── D. Pending writes ────────────────────────────────────────────────────────

describe('D. an offline write: pending, then confirmed by the server', () => {
  it('stays pending (uncounted, unresolved) offline and counts once when the server accepts it', async () => {
    await seedDataset(env, ALICE, NOW)
    const alice = signInAs(verifiedUser(env, ALICE))
    const incident = id(ALICE, 'INC-005')
    const incidents = await getDocs(
      query(getIncidentsCollection(), ...ownIncidentsConstraints(ALICE))
    )
    const rows = incidents.docs.flatMap((d) => {
      const parsed = parseIncident(d.id, d.data())
      return parsed.ok ? [parsed.row] : []
    })

    const reviewedSnaps: QuerySnapshot<ActionLog>[] = []
    const historySnaps: QuerySnapshot<ActionLog>[] = []
    const options = { includeMetadataChanges: true }
    const stopReviewed = onSnapshot(
      query(getActionLogsCollection(), ...reviewedActionsConstraints(ALICE)),
      options,
      (s: QuerySnapshot<ActionLog>) => reviewedSnaps.push(s)
    )
    const stopHistory = onSnapshot(
      query(getActionLogsCollection(), ...actionHistoryConstraints(ALICE, incident)),
      options,
      (s: QuerySnapshot<ActionLog>) => historySnaps.push(s)
    )
    // The same per-document filtering the two hooks apply.
    const reviewedNow = () =>
      deriveReviewSummary(rows, confirmedReviewEvidence(reviewedSnaps.at(-1)!.docs)).reviewed
    const listedNow = () =>
      buildActionHistory(
        historySnaps
          .at(-1)!
          .docs.filter((d) => !d.metadata.hasPendingWrites)
          .map((d) => ({ id: d.id, data: d.data() })),
        { ownerUid: ALICE, incidentId: incident }
      ).entries.map((e) => e.id)

    try {
      await vi.waitFor(
        () => {
          expect(reviewedSnaps.some((s) => !s.metadata.fromCache)).toBe(true)
          expect(historySnaps.some((s) => !s.metadata.fromCache)).toBe(true)
        },
        { timeout: 10_000 }
      )
      expect(reviewedNow()).toBe(0)

      await disableNetwork(alice)
      const start = startDecisionWrite(ALICE, incident, { actionType: 'REVIEWED', note: NOTE })
      if (!start.started) throw new Error('expected a write')
      let settled = false
      void start.confirmed.then(() => {
        settled = true
      })

      // The SDK shows the log locally, marked pending, in both queries.
      await vi.waitFor(
        () => expect(historySnaps.at(-1)!.docs.some((d) => d.metadata.hasPendingWrites)).toBe(true),
        { timeout: 10_000 }
      )
      const pendingId = historySnaps.at(-1)!.docs.find((d) => d.metadata.hasPendingWrites)!.id
      await vi.waitFor(
        () =>
          expect(
            reviewedSnaps
              .at(-1)!
              .docs.some((d) => d.id === pendingId && d.metadata.hasPendingWrites)
          ).toBe(true),
        { timeout: 10_000 }
      )
      expect(reviewedNow()).toBe(0) // not counted
      expect(listedNow()).toEqual([]) // not listed
      // A bounded check that the write isn't reported early (the metadata above is the evidence).
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(settled).toBe(false)

      await enableNetwork(alice)
      await expect(start.confirmed).resolves.toEqual({
        ok: true,
        actionLogId: pendingId,
        actionType: 'REVIEWED',
      })

      // The same document, now accepted: counted once, listed once.
      await vi.waitFor(
        () => {
          expect(historySnaps.at(-1)!.docs.map((d) => [d.id, d.metadata.hasPendingWrites])).toEqual(
            [[pendingId, false]]
          )
          expect(
            reviewedSnaps.at(-1)!.docs.map((d) => [d.id, d.metadata.hasPendingWrites])
          ).toEqual([[pendingId, false]])
        },
        { timeout: 10_000 }
      )
      expect(reviewedNow()).toBe(1)
      expect(listedNow()).toEqual([pendingId])
    } finally {
      await enableNetwork(alice) // never leave the client offline
      stopReviewed()
      stopHistory()
    }

    // An independent readback from a fresh client: exactly one log was stored.
    // (Not on the toggled client: in firebase 11.10 a one-shot getDocs on a
    // query that client is also listening to, after disableNetwork /
    // enableNetwork, makes the SDK fail later with INTERNAL ASSERTION FAILED
    // (ID: ca9) — an SDK defect; the app itself only uses onSnapshot.)
    signInAs(verifiedUser(env, ALICE))
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    expect((await history(ALICE, incident)).entries.map((e) => e.id)).toHaveLength(1)
  })
})

// ── E. Rejected writes ───────────────────────────────────────────────────────

describe('E. refused writes persist nothing and never count', () => {
  beforeEach(async () => {
    await seedIncidents(env, [
      { id: id(ALICE, 'INC-001'), ownerUid: ALICE },
      { id: id(BOB, 'INC-001'), ownerUid: BOB },
    ])
  })

  it.each([
    ["another operator's incident", () => verifiedUser(env, ALICE), ALICE, id(BOB, 'INC-001')],
    ['an unverified operator', () => unverifiedUser(env, ALICE), ALICE, id(ALICE, 'INC-001')],
    ['a signed-out visitor', () => anonymousVisitor(env), ALICE, id(ALICE, 'INC-001')],
    ['a missing incident', () => verifiedUser(env, ALICE), ALICE, id(ALICE, 'INC-999')],
    [
      "a forged owner (Bob signed in, Alice's UID in the payload)",
      () => verifiedUser(env, BOB),
      ALICE,
      id(ALICE, 'INC-001'),
    ],
  ])(
    'the adapter reports %s as a safe refusal, and nothing is stored',
    async (_label, firestore, owner, incident) => {
      signInAs(firestore())
      expect(await decide(owner, incident, 'REVIEWED')).toEqual({ ok: false, error: REFUSED })
      expect(await nothingStoredFor(incident)).toBe(true)
    }
  )

  it.each([
    ['an invalid action type', { actionType: 'CLOSE' }],
    ['a missing field', { note: undefined }],
    ['an unexpected extra field', { escalatedTo: 'welfare-team' }],
    ['a wrong owner UID', { ownerUid: BOB }],
    ['a 9-character note', { note: 'a'.repeat(9) }],
    ['a 501-character note', { note: 'a'.repeat(501) }],
    ['an untrimmed note', { note: ` ${NOTE} ` }],
    ['a client-generated createdAt', { createdAt: Timestamp.now() }],
    ['a back-dated createdAt', { createdAt: Timestamp.fromDate(new Date('2020-01-01T00:00:00Z')) }],
  ])(
    'a forged payload with %s (bypassing the adapter) is refused, stores nothing, counts nothing',
    async (_label, overrides: Record<string, unknown>) => {
      const alice = signInAs(verifiedUser(env, ALICE))
      const payload = validActionLog({
        incidentId: id(ALICE, 'INC-001'),
        actionType: 'REVIEWED',
        ...overrides,
      })
      for (const [key, value] of Object.entries(overrides))
        if (value === undefined) delete payload[key]

      // The adapter would never send these; the rules are the backstop.
      await assertFails(addDoc(rawLogs(alice), payload))
      expect(await nothingStoredFor(id(ALICE, 'INC-001'))).toBe(true)
      expect((await dashboardCounts(ALICE)).reviewedLogIds).toEqual([])
    }
  )

  it('the adapter never sends an invalid decision at all', async () => {
    signInAs(verifiedUser(env, ALICE))
    for (const input of [
      { actionType: 'CLOSE', note: NOTE },
      { actionType: 'REVIEWED', note: 'too short' },
      { note: NOTE },
    ]) {
      expect(startDecisionWrite(ALICE, id(ALICE, 'INC-001'), input).started).toBe(false)
    }
    expect(buildActionLogData(ALICE, '../escape', { actionType: 'REVIEWED', note: NOTE }).ok).toBe(
      false
    )
    expect(await nothingStoredFor(id(ALICE, 'INC-001'))).toBe(true)
  })
})

// ── F. Rationale boundaries through the adapter ──────────────────────────────

describe('F. rationale boundaries and Unicode, written through the adapter', () => {
  beforeEach(async () => {
    await seedIncidents(env, [{ id: id(ALICE, 'INC-001'), ownerUid: ALICE }])
  })

  it.each([
    ['exactly 10 characters', 'a'.repeat(10), 'a'.repeat(10)],
    ['exactly 500 characters', 'a'.repeat(500), 'a'.repeat(500)],
    ['surrounding whitespace', `  \t${NOTE}\n `, NOTE],
    [
      'a multi-line rationale',
      '  Line one of the reason.\r\nLine two.\n',
      'Line one of the reason.\r\nLine two.',
    ],
    ['5 emoji (10 UTF-16 code units)', '\u{1F600}'.repeat(5), '\u{1F600}'.repeat(5)],
    ['250 emoji (500 code units)', '\u{1F600}'.repeat(250), '\u{1F600}'.repeat(250)],
    ['control characters and no-break spaces at the ends', `\u0001  ${NOTE}　\u0002`, NOTE],
    [
      'an inner no-break space and control character',
      'Checked the\u0001evidence.',
      'Checked the\u0001evidence.',
    ],
  ])('%s is accepted and stored normalised', async (_label, typed, stored) => {
    signInAs(verifiedUser(env, ALICE))
    const outcome = await decide(ALICE, id(ALICE, 'INC-001'), 'ACKNOWLEDGE', typed)
    if (!outcome.ok) throw new Error(outcome.error.code)
    expect((await getDoc(logRef(outcome.actionLogId))).data()!.note).toBe(stored)
  })

  it.each([
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['4 emoji (8 code units)', '\u{1F600}'.repeat(4)],
    ['251 emoji (502 code units)', '\u{1F600}'.repeat(251)],
    ['only whitespace and control characters', ' \u0001 \t\u0002 '.repeat(3)],
    ['9 characters padded with control characters', `\u0001${'a'.repeat(9)}\u0001`],
  ])('%s is never sent, and nothing is stored', async (_label, typed) => {
    signInAs(verifiedUser(env, ALICE))
    const start = startDecisionWrite(ALICE, id(ALICE, 'INC-001'), {
      actionType: 'ACKNOWLEDGE',
      note: typed,
    })
    expect(start.started).toBe(false)
    expect(await nothingStoredFor(id(ALICE, 'INC-001'))).toBe(true)
  })
})

// ── G. Integrity ─────────────────────────────────────────────────────────────

describe('G. history and incident integrity', () => {
  const at = (minute: number) => Timestamp.fromDate(new Date(Date.UTC(2026, 9, 24, 1, minute)))

  it('repeated decisions stay in the append-only history; status matches both derivations', async () => {
    await seedDataset(env, ALICE, NOW)
    signInAs(verifiedUser(env, ALICE))
    const incident = id(ALICE, 'INC-020')
    for (const actionType of ['ACKNOWLEDGE', 'ESCALATE', 'ACKNOWLEDGE', 'REVIEWED', 'REVIEWED']) {
      expect(await decide(ALICE, incident, actionType)).toMatchObject({ ok: true })
    }
    const logs = await history(ALICE, incident)
    expect(logs.entries.map((e) => e.actionType)).toEqual([
      'REVIEWED',
      'REVIEWED',
      'ACKNOWLEDGE',
      'ESCALATE',
      'ACKNOWLEDGE',
    ])
    expect(logs.reviewStatus).toBe('REVIEWED')
    const { summary } = await dashboardCounts(ALICE)
    expect(summary.rows.find((r) => r.id === incident)!.reviewStatus).toBe(logs.reviewStatus)
  })

  it("records for another incident or owner never affect this incident's review status", async () => {
    await seedDataset(env, ALICE, NOW)
    await seedDataset(env, BOB, NOW)
    const base = { note: NOTE, actionType: 'REVIEWED', _schemaVersion: 1, createdAt: at(0) }
    // Written with rules bypassed: a client could not create the first one.
    await seedActionLog(env, 'bob-on-alice', {
      ...base,
      ownerUid: BOB,
      incidentId: id(ALICE, 'INC-001'),
    })
    await seedActionLog(env, 'alice-other-incident', {
      ...base,
      ownerUid: ALICE,
      incidentId: id(ALICE, 'INC-002'),
    })

    signInAs(verifiedUser(env, ALICE))
    const logs = await history(ALICE, id(ALICE, 'INC-001'))
    expect(logs.snapshot.size).toBe(0) // the owner-scoped query never returns Bob's log to Alice
    expect(logs.reviewStatus).toBe('AWAITING_REVIEW')
    const alice = await dashboardCounts(ALICE)
    expect(alice.summary.rows.find((r) => r.id === id(ALICE, 'INC-001'))!.reviewStatus).toBe(
      'AWAITING_REVIEW'
    )
    expect(alice.counts.reviewed).toBe(1) // only her own log on INC-002

    signInAs(verifiedUser(env, BOB))
    const bob = await dashboardCounts(BOB)
    expect(bob.reviewedLogIds).toEqual(['bob-on-alice']) // returned to Bob, but…
    expect(bob.counts.reviewed).toBe(0) // …it refers to no incident in his queue
  })

  it('malformed history written with privileged access is shown safely and never counts as REVIEWED', async () => {
    await seedIncidents(env, [{ id: id(ALICE, 'INC-001'), ownerUid: ALICE }])
    const base = { ownerUid: ALICE, incidentId: id(ALICE, 'INC-001'), _schemaVersion: 1 }
    await seedActionLog(env, 'bad-type', {
      ...base,
      actionType: 'reviewed',
      note: NOTE,
      createdAt: at(3),
    })
    await seedActionLog(env, 'bad-note', {
      ...base,
      actionType: 'ACKNOWLEDGE',
      note: 'short',
      createdAt: at(2),
    })
    await seedActionLog(env, 'bad-version', {
      ...base,
      actionType: 'ESCALATE',
      note: NOTE,
      createdAt: at(1),
      _schemaVersion: 2,
    })

    signInAs(verifiedUser(env, ALICE))
    const logs = await history(ALICE, id(ALICE, 'INC-001'))
    expect(logs.entries.map((e) => [e.id, e.dataIssues])).toEqual([
      ['bad-type', ['actionType']],
      ['bad-note', ['note']],
      ['bad-version', ['_schemaVersion']],
    ])
    expect(logs.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('dashboard and detail agree on logs without createdAt: never listed, never counted; a present value counts on both', async () => {
    await seedDataset(env, ALICE, NOW)
    const missing = id(ALICE, 'INC-030')
    const nullTime = id(ALICE, 'INC-031')
    const base = { ownerUid: ALICE, actionType: 'REVIEWED', note: NOTE, _schemaVersion: 1 }
    // Privileged writes only — the rules require createdAt == request.time for clients.
    await seedActionLog(env, 'no-created-at', { ...base, incidentId: missing })
    await seedActionLog(env, 'null-created-at', { ...base, incidentId: nullTime, createdAt: null })

    signInAs(verifiedUser(env, ALICE))
    const statusOn = async (incidentId: string) => {
      const dash = (await dashboardCounts(ALICE)).summary.rows.find(
        (r) => r.id === incidentId
      )!.reviewStatus
      const detail = await history(ALICE, incidentId)
      return { dash, detail: detail.reviewStatus, listed: detail.entries.map((e) => e.id) }
    }
    // Missing field: Firestore leaves it out of the ordered history, so the dashboard ignores it too.
    expect(await statusOn(missing)).toEqual({
      dash: 'AWAITING_REVIEW',
      detail: 'AWAITING_REVIEW',
      listed: [],
    })
    // Present but null: Firestore includes it, the detail lists it ("Time not recorded"); both count it.
    expect(await statusOn(nullTime)).toEqual({
      dash: 'REVIEWED',
      detail: 'REVIEWED',
      listed: ['null-created-at'],
    })
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 49, reviewed: 1 })

    // Legitimate decisions still count normally alongside them: 49 → 48, duplicates once, ACK/ESC never.
    expect(await decide(ALICE, id(ALICE, 'INC-001'), 'ACKNOWLEDGE')).toMatchObject({ ok: true })
    expect(await decide(ALICE, id(ALICE, 'INC-001'), 'ESCALATE')).toMatchObject({ ok: true })
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    expect(await decide(ALICE, id(ALICE, 'INC-001'), 'REVIEWED')).toMatchObject({ ok: true })
    expect(await decide(ALICE, id(ALICE, 'INC-001'), 'REVIEWED')).toMatchObject({ ok: true })
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 48, reviewed: 2 })
    expect(await statusOn(missing)).toMatchObject({
      dash: 'AWAITING_REVIEW',
      detail: 'AWAITING_REVIEW',
    })
  })

  it('a clean dataset with the malformed log still progresses 50/50/0 → 50/49/1 → 50/48/2', async () => {
    await seedDataset(env, ALICE, NOW)
    await seedActionLog(env, 'no-created-at', {
      ownerUid: ALICE,
      incidentId: id(ALICE, 'INC-040'),
      actionType: 'REVIEWED',
      note: NOTE,
      _schemaVersion: 1,
    })
    signInAs(verifiedUser(env, ALICE))
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
    await decide(ALICE, id(ALICE, 'INC-002'), 'REVIEWED')
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    await decide(ALICE, id(ALICE, 'INC-003'), 'REVIEWED')
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 50, awaiting: 48, reviewed: 2 })
  })

  it('a non-simulated incident is readable, blocked by the app AND refused by the rules for decisions', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(dbOf(context), INCIDENTS_COLLECTION, id(ALICE, 'INC-001')), {
        ...incidentFixture(ALICE),
        isSimulated: false,
      })
    })
    signInAs(verifiedUser(env, ALICE))

    const snap = await assertSucceeds(getDoc(incidentDoc(id(ALICE, 'INC-001'))))
    // Application layer: both parsers fail closed, so neither page shows it or offers a form.
    expect(parseIncidentDetail(snap.id, snap.data(), { ownerUid: ALICE })).toMatchObject({
      ok: false,
      reason: 'NOT_SIMULATED',
    })
    expect(parseIncident(snap.id, snap.data())).toMatchObject({
      ok: false,
      reason: 'NOT_SIMULATED',
    })

    // Rules layer (hardened after CP7): the action-log create rule also requires
    // isSimulated == true, so a decision forced past the app is refused.
    expect(await decide(ALICE, id(ALICE, 'INC-001'), 'REVIEWED')).toEqual({
      ok: false,
      error: REFUSED,
    })
    expect(await nothingStoredFor(id(ALICE, 'INC-001'))).toBe(true)
    expect((await dashboardCounts(ALICE)).counts).toEqual({ total: 0, awaiting: 0, reviewed: 0 })
  })
})
