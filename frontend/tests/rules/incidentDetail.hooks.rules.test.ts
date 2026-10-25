// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import {
  collection,
  disableNetwork,
  enableNetwork,
  getDocs,
  query,
  where,
  type Firestore,
} from 'firebase/firestore'
import { ACTION_LOGS_COLLECTION } from '@/lib/firebase/firestore'
import { useDecisionSubmission } from '@/features/incidents/hooks/useDecisionSubmission'
import { useIncidentDashboard } from '@/features/incidents/hooks/useIncidentDashboard'
import { useIncidentDetail } from '@/features/incidents/hooks/useIncidentDetail'
import {
  ALICE,
  BOB,
  PROJECT_ID,
  assertEmulatorOnly,
  clearEmulator,
  createTestEnv,
  dbOf,
  terminateClient,
  firebaseAppProjectIds,
  seedDataset,
  verifiedUser,
} from './helpers'

// Phase 5 CP6: the three real hooks the two screens use — useIncidentDetail,
// useDecisionSubmission and useIncidentDashboard — together, against the real
// SDK and the unchanged rules on the local demo-safecall emulator. Like the
// app, they use only onSnapshot listeners and the write adapter. The only
// substitution is the app's Firestore client: getClientDb() returns the
// emulator context of the signed-in operator (the real client module, which
// reads the live project's config, is never loaded).

const db = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/firebase/client', () => ({
  getClientDb: () => {
    if (!db.current) throw new Error('No emulator Firestore selected for this test.')
    return db.current
  },
}))

const NOW = new Date('2026-10-21T00:00:00.000Z')
const NOTE = 'Checked the simulated outage evidence.'
const WAIT = { timeout: 10_000 }
const id = (owner: string, code: string) => `${owner}_${code}`

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
  await seedDataset(env, ALICE, NOW)
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

function signInAs(firestore: Firestore): Firestore {
  clients.add(firestore)
  db.current = firestore
  return firestore
}

interface ScreenProps {
  uid: string
  incidentId: string
  /** Normally the detail hook's own value; a test may force it to model a write started just before a disconnect. */
  forceEligible?: boolean
}

/** Screen B's two hooks wired as IncidentDetail wires them, plus the dashboard hook. */
function useScreens({ uid, incidentId, forceEligible }: ScreenProps) {
  const detail = useIncidentDetail(uid, incidentId)
  const submission = useDecisionSubmission({
    uid,
    incidentId,
    canRecordDecision: forceEligible ?? detail.canRecordDecision,
  })
  const dashboard = useIncidentDashboard(uid)
  return { detail, submission, dashboard }
}

function renderScreens(props: ScreenProps, options: { strict?: boolean } = {}) {
  return renderHook((p: ScreenProps) => useScreens(p), {
    initialProps: props,
    reactStrictMode: options.strict,
  })
}

type Rendered = ReturnType<typeof renderScreens>['result']

function counts(result: Rendered) {
  const summary = result.current.dashboard.summary
  return summary
    ? { total: summary.total, awaiting: summary.awaiting, reviewed: summary.reviewed }
    : null
}

async function allReady(result: Rendered) {
  await waitFor(() => {
    expect(result.current.detail.status).toBe('ready')
    expect(result.current.detail.history.status).toBe('ready')
    expect(result.current.dashboard.status).toBe('ready')
  }, WAIT)
}

/** Submits through the hook and waits for the server's answer. */
async function submitAndSettle(result: Rendered, actionType: string, note = NOTE) {
  let started: string | undefined
  act(() => {
    started = result.current.submission.submit({ actionType, note })
  })
  expect(started).toBe('started')
  await waitFor(() => expect(['saved', 'failed']).toContain(result.current.submission.status), WAIT)
  return result.current.submission
}

/** Every stored action log for an incident, read with rules bypassed. */
async function storedLogs(incidentId: string) {
  let found: string[] = []
  await env.withSecurityRulesDisabled(async (context) => {
    const snap = await getDocs(
      query(
        collection(dbOf(context), ACTION_LOGS_COLLECTION),
        where('incidentId', '==', incidentId)
      )
    )
    found = snap.docs.map((d) => d.id)
  })
  return found
}

describe('the real hooks against the emulator', () => {
  it('a full session: decisions save, the history and the dashboard follow from confirmed data only', async () => {
    signInAs(verifiedUser(env, ALICE))
    const first = id(ALICE, 'INC-003')
    const second = id(ALICE, 'INC-011')
    const { result, rerender, unmount } = renderScreens({ uid: ALICE, incidentId: first })
    try {
      await allReady(result)
      expect(result.current.detail.incident?.id).toBe(first)
      expect(result.current.detail.history.entries).toEqual([])
      expect(result.current.detail.reviewStatus).toBe('AWAITING_REVIEW')
      expect(counts(result)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })

      const steps: Array<
        [string, number, string, { total: number; awaiting: number; reviewed: number }]
      > = [
        ['ACKNOWLEDGE', 1, 'AWAITING_REVIEW', { total: 50, awaiting: 50, reviewed: 0 }],
        ['ESCALATE', 2, 'AWAITING_REVIEW', { total: 50, awaiting: 50, reviewed: 0 }],
        ['REVIEWED', 3, 'REVIEWED', { total: 50, awaiting: 49, reviewed: 1 }],
        ['REVIEWED', 4, 'REVIEWED', { total: 50, awaiting: 49, reviewed: 1 }],
      ]
      for (const [actionType, entries, reviewStatus, expected] of steps) {
        const submission = await submitAndSettle(result, actionType)
        expect(submission.status, actionType).toBe('saved')
        expect(submission.saved?.actionType).toBe(actionType)
        // The listeners deliver the server-confirmed log; nothing is listed before that.
        await waitFor(() => {
          expect(result.current.detail.history.entries).toHaveLength(entries)
          expect(result.current.detail.history.pendingCount).toBe(0)
          expect(counts(result)).toEqual(expected)
        }, WAIT)
        expect(result.current.detail.reviewStatus).toBe(reviewStatus)
        expect(result.current.detail.history.entries?.[0]?.actionType).toBe(actionType)
      }

      // Another incident: its own empty history, then a REVIEWED that moves the dashboard to 2.
      rerender({ uid: ALICE, incidentId: second })
      await allReady(result)
      expect(result.current.detail.incident?.id).toBe(second)
      expect(result.current.detail.history.entries).toEqual([])
      expect(result.current.submission.status).toBe('idle')
      expect((await submitAndSettle(result, 'REVIEWED')).status).toBe('saved')
      await waitFor(
        () => expect(counts(result)).toEqual({ total: 50, awaiting: 48, reviewed: 2 }),
        WAIT
      )

      expect(await storedLogs(first)).toHaveLength(4)
      expect(await storedLogs(second)).toHaveLength(1)
      expect(new Set(firebaseAppProjectIds())).toEqual(new Set([PROJECT_ID]))
    } finally {
      unmount()
    }
  })

  it('going offline makes the incident stale, so a new decision is not allowed; back online it is', async () => {
    const alice = signInAs(verifiedUser(env, ALICE))
    const incident = id(ALICE, 'INC-005')
    const { result, unmount } = renderScreens({ uid: ALICE, incidentId: incident })
    try {
      await allReady(result)
      expect(result.current.detail.canRecordDecision).toBe(true)

      await disableNetwork(alice)
      await waitFor(() => expect(result.current.detail.status).toBe('stale'), WAIT)
      expect(result.current.detail.canRecordDecision).toBe(false)
      expect(result.current.detail.incident?.id).toBe(incident) // still shown, marked stale
      let outcome: string | undefined
      act(() => {
        outcome = result.current.submission.submit({ actionType: 'REVIEWED', note: NOTE })
      })
      expect(outcome).toBe('ineligible')

      await enableNetwork(alice)
      await waitFor(() => expect(result.current.detail.status).toBe('ready'), WAIT)
      expect(result.current.detail.canRecordDecision).toBe(true)
      expect(await storedLogs(incident)).toEqual([])
    } finally {
      await enableNetwork(alice)
      unmount()
    }
  })

  it('a write started just before a disconnect stays pending — unlisted, uncounted, unsaved — until the server accepts it', async () => {
    const alice = signInAs(verifiedUser(env, ALICE))
    const incident = id(ALICE, 'INC-005')
    const { result, unmount } = renderScreens({
      uid: ALICE,
      incidentId: incident,
      forceEligible: true,
    })
    try {
      await allReady(result)
      await disableNetwork(alice)
      let started: string | undefined
      act(() => {
        started = result.current.submission.submit({ actionType: 'REVIEWED', note: NOTE })
      })
      expect(started).toBe('started')

      // The real SDK delivers the local document marked pending.
      await waitFor(() => expect(result.current.detail.history.pendingCount).toBe(1), WAIT)
      expect(result.current.submission.status).toBe('saving')
      expect(result.current.submission.saved).toBeNull()
      expect(result.current.detail.history.entries).toEqual([])
      expect(result.current.detail.reviewStatus).toBe('AWAITING_REVIEW')
      expect(result.current.dashboard.summary?.reviewed).toBe(0)

      await enableNetwork(alice)
      await waitFor(() => expect(result.current.submission.status).toBe('saved'), WAIT)
      await waitFor(() => {
        expect(result.current.detail.history.entries).toHaveLength(1)
        expect(result.current.detail.history.pendingCount).toBe(0)
        expect(result.current.dashboard.summary?.reviewed).toBe(1)
      }, WAIT)
      expect(result.current.detail.reviewStatus).toBe('REVIEWED')
      expect(result.current.detail.history.entries?.[0]?.id).toBe(
        result.current.submission.saved?.actionLogId
      )
      expect(await storedLogs(incident)).toHaveLength(1) // once, not twice
    } finally {
      await enableNetwork(alice)
      unmount()
    }
  })

  it("another operator's incident is unavailable through the hooks, and a forced write is refused by the rules", async () => {
    await seedDataset(env, BOB, NOW)
    signInAs(verifiedUser(env, ALICE))
    const bobs = id(BOB, 'INC-001')
    const { result, unmount } = renderScreens({ uid: ALICE, incidentId: bobs, forceEligible: true })
    try {
      await waitFor(() => expect(result.current.detail.status).toBe('unavailable'), WAIT)
      expect(result.current.detail.incident).toBeNull()
      expect(result.current.detail.canRecordDecision).toBe(false)
      expect(result.current.detail.history.status).toBe('withheld')

      const submission = await submitAndSettle(result, 'REVIEWED')
      expect(submission.status).toBe('failed')
      expect(submission.error?.code).toBe('permission-denied')
      expect(await storedLogs(bobs)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('under Strict Mode, mounting writes nothing and one submit stores exactly one log', async () => {
    signInAs(verifiedUser(env, ALICE))
    const incident = id(ALICE, 'INC-009')
    const { result, unmount } = renderScreens(
      { uid: ALICE, incidentId: incident },
      { strict: true }
    )
    try {
      await allReady(result)
      expect(await storedLogs(incident)).toEqual([])
      expect((await submitAndSettle(result, 'ACKNOWLEDGE')).status).toBe('saved')
      await waitFor(() => expect(result.current.detail.history.entries).toHaveLength(1), WAIT)
      expect(await storedLogs(incident)).toHaveLength(1)
    } finally {
      unmount()
    }
  })
})
