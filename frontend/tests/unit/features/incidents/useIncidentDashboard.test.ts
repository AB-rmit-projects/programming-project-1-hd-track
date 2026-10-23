import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onSnapshot, Timestamp, type FirestoreError } from 'firebase/firestore'
import { getClientDb } from '@/lib/firebase/client'
import {
  SERVER_CONFIRMATION_TIMEOUT_MS,
  useIncidentDashboard,
  type IncidentDashboardState,
} from '@/features/incidents/hooks/useIncidentDashboard'
import type { ActionType } from '@/types/firestore'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

// ── Mocked Firestore SDK ─────────────────────────────────────────────────────
// No Firebase connection: collection/where/query return plain descriptions,
// and onSnapshot records each listener so tests can push snapshots into it.
// The real ownIncidentsConstraints / reviewedActionsConstraints run on top of
// these, so the assertions check the constraints the app actually builds.
// Timestamp stays real, because parseIncident requires real Timestamps.

interface FakeQuery {
  path: string
  constraints: unknown[]
}

interface Listener {
  query: FakeQuery
  options: unknown
  next: (snapshot: unknown) => void
  error: (error: FirestoreError) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const listeners = vi.hoisted(() => [] as Listener[])

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: vi.fn((field: string, direction: string) => ({ orderBy: [field, direction] })),
  query: vi.fn((ref: { path: string }, ...constraints: unknown[]) => ({
    path: ref.path,
    constraints,
  })),
  onSnapshot: vi.fn(
    (q: FakeQuery, options: unknown, next: Listener['next'], error: Listener['error']) => {
      const unsubscribe = vi.fn()
      listeners.push({ query: q, options, next, error, unsubscribe })
      return unsubscribe
    }
  ),
}))

vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn(() => ({ fake: 'db' })) }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = 'alice-uid'
const BOB = 'bob-uid'
const NOW = new Date('2026-10-21T00:00:00.000Z')

interface FakeDoc {
  id: string
  data: () => Record<string, unknown>
}

/** The 50 Phase 3 incidents for an owner, as the client SDK returns them. */
function seededDocs(owner: string): FakeDoc[] {
  return buildSeedIncidents(owner, NOW).map(({ id, data }) => {
    const stored = {
      ...data,
      lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
      createdAt: Timestamp.fromDate(data.createdAt),
    }
    return { id, data: () => stored }
  })
}

function logDoc(owner: string, actionType: ActionType, code: string, n = 0): FakeDoc {
  const stored = { ownerUid: owner, incidentId: `${owner}_${code}`, actionType }
  return { id: `log-${code}-${actionType}-${n}`, data: () => stored }
}

function snapshot(docs: FakeDoc[], { fromCache = false } = {}) {
  return { docs, empty: docs.length === 0, metadata: { fromCache, hasPendingWrites: false } }
}

function firestoreError(code: string): FirestoreError {
  return Object.assign(new Error(code), { code, name: 'FirebaseError' }) as FirestoreError
}

/** The newest listener on a collection (a re-subscription replaces the old one). */
function listenerFor(path: 'incidents' | 'actionLogs'): Listener {
  const found = listeners.filter((l) => l.query.path === path).at(-1)
  if (!found) throw new Error(`no ${path} listener`)
  return found
}

function push(path: 'incidents' | 'actionLogs', docs: FakeDoc[], opts?: { fromCache?: boolean }) {
  act(() => listenerFor(path).next(snapshot(docs, opts)))
}

/** Both queries confirmed by the server. */
function confirmBoth(incidents: FakeDoc[], logs: FakeDoc[] = []) {
  push('incidents', incidents)
  push('actionLogs', logs)
}

function counts(state: IncidentDashboardState) {
  return state.summary
    ? {
        total: state.summary.total,
        awaiting: state.summary.awaiting,
        reviewed: state.summary.reviewed,
      }
    : null
}

function renderDashboard(uid: string | null) {
  return renderHook(({ uid }: { uid: string | null }) => useIncidentDashboard(uid), {
    initialProps: { uid },
  })
}

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useIncidentDashboard — queries', () => {
  it('subscribes to exactly two owner-scoped queries, with metadata changes', () => {
    renderDashboard(ALICE)

    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(listenerFor('incidents').query.constraints).toEqual([
      { where: ['ownerUid', '==', ALICE] },
    ])
    expect(listenerFor('actionLogs').query.constraints).toEqual([
      { where: ['ownerUid', '==', ALICE] },
      { where: ['actionType', '==', 'REVIEWED'] },
    ])
    for (const listener of listeners) {
      expect(listener.options).toEqual({ includeMetadataChanges: true })
    }
  })

  it.each([null, ''])('with no UID (%j) it is idle and never touches Firestore', (uid) => {
    const { result } = renderDashboard(uid)

    expect(result.current.status).toBe('idle')
    expect(result.current.ownerUid).toBeNull()
    expect(result.current.summary).toBeNull()
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(getClientDb).not.toHaveBeenCalled()
  })
})

describe('useIncidentDashboard — readiness', () => {
  it('starts loading, with no counts', () => {
    const { result } = renderDashboard(ALICE)
    expect(result.current.status).toBe('loading')
    expect(result.current.ownerUid).toBe(ALICE)
    expect(result.current.summary).toBeNull()
  })

  it('stays loading while only the incidents query is confirmed', () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', seededDocs(ALICE))
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('stays loading while only the REVIEWED query is confirmed', () => {
    const { result } = renderDashboard(ALICE)
    push('actionLogs', [])
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('a cached empty incidents result is not treated as a confirmed empty dataset', () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', [], { fromCache: true })
    push('actionLogs', [])
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()

    push('incidents', []) // now confirmed by the server
    expect(result.current.status).toBe('ready')
    expect(counts(result.current)).toEqual({ total: 0, awaiting: 0, reviewed: 0 })
  })

  it('cached data for both queries, never confirmed, is still loading', () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', seededDocs(ALICE), { fromCache: true })
    push('actionLogs', [], { fromCache: true })
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('both confirmed: ready with 50 / 50 / 0 for the seeded dataset', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))

    expect(result.current.status).toBe('ready')
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
    expect(result.current.summary?.rows).toHaveLength(50)
    expect(result.current.dataIssueCount).toBe(0)
    expect(result.current.error).toBeNull()
  })

  it('counts rows that needed fallbacks', () => {
    const docs = seededDocs(ALICE)
    const damaged = { ...docs[0]!.data(), suburb: '' }
    docs[0] = { id: docs[0]!.id, data: () => damaged }

    const { result } = renderDashboard(ALICE)
    confirmBoth(docs)
    expect(result.current.status).toBe('ready')
    expect(result.current.dataIssueCount).toBe(1)
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
  })
})

describe('useIncidentDashboard — live review counts', () => {
  it('a new REVIEWED log snapshot updates the counts without re-subscribing', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))

    push('actionLogs', [logDoc(ALICE, 'REVIEWED', 'INC-007')])

    expect(counts(result.current)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    expect(onSnapshot).toHaveBeenCalledTimes(2)
  })

  it('duplicate REVIEWED logs for one incident count once', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE), [
      logDoc(ALICE, 'REVIEWED', 'INC-003', 1),
      logDoc(ALICE, 'REVIEWED', 'INC-003', 2),
      logDoc(ALICE, 'REVIEWED', 'INC-003', 3),
    ])
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
  })

  it('ACKNOWLEDGE and ESCALATE never change the reviewed total, even if they reach the hook', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE), [
      logDoc(ALICE, 'ACKNOWLEDGE', 'INC-001'),
      logDoc(ALICE, 'ESCALATE', 'INC-002'),
    ])
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
  })
})

describe('useIncidentDashboard — offline timeout and retry', () => {
  it(`reports offline after ${SERVER_CONFIRMATION_TIMEOUT_MS} ms without server confirmation`, () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', seededDocs(ALICE), { fromCache: true })
    push('actionLogs', [], { fromCache: true })

    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS - 1))
    expect(result.current.status).toBe('loading')

    act(() => vi.advanceTimersByTime(1))
    expect(result.current.status).toBe('offline')
    expect(result.current.summary).toBeNull()
  })

  it('reports offline when no snapshot arrives at all', () => {
    const { result } = renderDashboard(ALICE)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(result.current.status).toBe('offline')
  })

  it('reports offline when only one query is confirmed in time', () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', seededDocs(ALICE))
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(result.current.status).toBe('offline')
    expect(result.current.summary).toBeNull()
  })

  it('recovers from offline by itself once the server confirms both queries', () => {
    const { result } = renderDashboard(ALICE)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    confirmBoth(seededDocs(ALICE))
    expect(result.current.status).toBe('ready')
  })

  it('retry() replaces both listeners and restarts the timeout', () => {
    const { result } = renderDashboard(ALICE)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(result.current.status).toBe('offline')
    const [oldIncidents, oldReviewed] = listeners

    act(() => result.current.retry())

    expect(oldIncidents!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(oldReviewed!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(onSnapshot).toHaveBeenCalledTimes(4)
    expect(listenerFor('incidents')).not.toBe(oldIncidents)
    expect(result.current.status).toBe('loading')

    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS - 1))
    expect(result.current.status).toBe('loading')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.status).toBe('offline')

    confirmBoth(seededDocs(ALICE))
    expect(result.current.status).toBe('ready')
  })

  it('after retry, a late callback from the old listener is ignored', () => {
    const { result } = renderDashboard(ALICE)
    const [oldIncidents, oldReviewed] = listeners
    act(() => result.current.retry())

    act(() => {
      oldIncidents!.next(snapshot(seededDocs(ALICE)))
      oldReviewed!.next(snapshot([]))
    })

    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('retry() from ready shows loading at once, not the previous subscription data', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })
})

describe('useIncidentDashboard — stale data', () => {
  it('ready → stale (cached snapshot keeps the last data) → ready', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE), [logDoc(ALICE, 'REVIEWED', 'INC-001')])
    expect(result.current.status).toBe('ready')

    push('actionLogs', [logDoc(ALICE, 'REVIEWED', 'INC-001')], { fromCache: true })
    expect(result.current.status).toBe('stale')
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })

    push('actionLogs', [logDoc(ALICE, 'REVIEWED', 'INC-001')])
    expect(result.current.status).toBe('ready')
  })

  it('a cached incidents snapshot after confirmation is stale too', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    push('incidents', seededDocs(ALICE), { fromCache: true })
    expect(result.current.status).toBe('stale')
    expect(result.current.summary?.total).toBe(50)
  })
})

describe('useIncidentDashboard — errors', () => {
  it.each(['incidents', 'actionLogs'] as const)(
    'an error on the %s listener gives an error state with no counts',
    (path) => {
      const { result } = renderDashboard(ALICE)
      confirmBoth(seededDocs(ALICE))
      expect(result.current.status).toBe('ready')

      act(() => listenerFor(path).error(firestoreError('permission-denied')))

      expect(result.current.status).toBe('error')
      expect(result.current.error?.code).toBe('permission-denied')
      expect(result.current.summary).toBeNull()
    }
  )

  it('an error before any data is still an error, not loading or offline', () => {
    const { result } = renderDashboard(ALICE)
    act(() => listenerFor('actionLogs').error(firestoreError('unavailable')))
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(result.current.status).toBe('error')
    expect(result.current.error?.code).toBe('unavailable')
  })

  it('retry() after an error subscribes again and can become ready', () => {
    const { result } = renderDashboard(ALICE)
    act(() => listenerFor('incidents').error(firestoreError('unavailable')))
    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    expect(result.current.error).toBeNull()
    confirmBoth(seededDocs(ALICE))
    expect(result.current.status).toBe('ready')
  })
})

describe('useIncidentDashboard — simulated-data integrity', () => {
  function withOneNonSimulated(owner: string): FakeDoc[] {
    const docs = seededDocs(owner)
    const bad = { ...docs[9]!.data(), isSimulated: false }
    docs[9] = { id: docs[9]!.id, data: () => bad }
    return docs
  }

  it('one incident not marked isSimulated: true withholds every row and count', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(withOneNonSimulated(ALICE))

    expect(result.current.status).toBe('integrity-error')
    expect(result.current.integrityErrorCount).toBe(1)
    expect(result.current.summary).toBeNull()
  })

  it('applies to cached snapshots too, before server confirmation', () => {
    const { result } = renderDashboard(ALICE)
    push('incidents', withOneNonSimulated(ALICE), { fromCache: true })
    expect(result.current.status).toBe('integrity-error')
    expect(result.current.summary).toBeNull()
  })

  it('keeps listening, and recovers when the record is corrected', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(withOneNonSimulated(ALICE))
    expect(result.current.status).toBe('integrity-error')
    expect(listenerFor('incidents').unsubscribe).not.toHaveBeenCalled()

    push('incidents', seededDocs(ALICE))

    expect(result.current.status).toBe('ready')
    expect(counts(result.current)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
  })
})

describe('useIncidentDashboard — owner isolation', () => {
  it("switching UID never returns the previous owner's data, not even for one render", () => {
    const seen: Array<{ uidProp: string | null; state: IncidentDashboardState }> = []
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => {
        const state = useIncidentDashboard(uid)
        seen.push({ uidProp: uid, state })
        return state
      },
      { initialProps: { uid: ALICE as string | null } }
    )
    confirmBoth(seededDocs(ALICE))
    expect(result.current.summary?.total).toBe(50)
    const aliceListeners = [...listeners]

    rerender({ uid: BOB })

    const bobRenders = seen.filter((entry) => entry.uidProp === BOB)
    expect(bobRenders.length).toBeGreaterThan(0)
    for (const { state } of bobRenders) {
      expect(state.ownerUid).toBe(BOB)
      expect(state.status).toBe('loading')
      expect(state.summary).toBeNull()
    }
    for (const listener of aliceListeners) expect(listener.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("the new owner's listeners are scoped to the new UID", () => {
    const { rerender } = renderDashboard(ALICE)
    rerender({ uid: BOB })

    expect(onSnapshot).toHaveBeenCalledTimes(4)
    expect(listenerFor('incidents').query.constraints).toEqual([{ where: ['ownerUid', '==', BOB] }])
    expect(listenerFor('actionLogs').query.constraints).toEqual([
      { where: ['ownerUid', '==', BOB] },
      { where: ['actionType', '==', 'REVIEWED'] },
    ])
  })

  it("late callbacks from the previous owner's listeners are ignored", () => {
    const { result, rerender } = renderDashboard(ALICE)
    const [aliceIncidents, aliceReviewed] = listeners
    rerender({ uid: BOB })

    act(() => {
      aliceIncidents!.next(snapshot(seededDocs(ALICE)))
      aliceReviewed!.next(snapshot([logDoc(ALICE, 'REVIEWED', 'INC-001')]))
      aliceIncidents!.error(firestoreError('permission-denied'))
    })

    expect(result.current.ownerUid).toBe(BOB)
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
    expect(result.current.error).toBeNull()

    confirmBoth(seededDocs(BOB))
    expect(result.current.status).toBe('ready')
    expect(result.current.summary?.rows.every((row) => row.id.startsWith(`${BOB}_`))).toBe(true)
  })

  it('switching back to a previous owner starts from loading, not their old data', () => {
    const { result, rerender } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    rerender({ uid: BOB })
    rerender({ uid: ALICE })

    expect(result.current.ownerUid).toBe(ALICE)
    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('after switching A → B → A, a late callback from the first A subscription is ignored', () => {
    // The UID and generation are the same as the current subscription's, so
    // only the per-subscription `active` flag can tell the two apart.
    const { result, rerender } = renderDashboard(ALICE)
    const [firstIncidents, firstReviewed] = listeners
    rerender({ uid: BOB })
    rerender({ uid: ALICE })

    act(() => {
      firstIncidents!.next(snapshot(seededDocs(ALICE)))
      firstReviewed!.next(snapshot([logDoc(ALICE, 'REVIEWED', 'INC-001')]))
    })

    expect(result.current.status).toBe('loading')
    expect(result.current.summary).toBeNull()
  })

  it('signing out (UID → null) unsubscribes and returns idle with no data', () => {
    const { result, rerender } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    rerender({ uid: null })

    expect(result.current.status).toBe('idle')
    expect(result.current.summary).toBeNull()
    for (const listener of listeners) expect(listener.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useIncidentDashboard — cleanup', () => {
  it('unmount stops both listeners and the timer; later callbacks do nothing', () => {
    const { unmount } = renderDashboard(ALICE)
    const [incidents, reviewed] = listeners
    expect(vi.getTimerCount()).toBe(1)

    unmount()

    expect(incidents!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(reviewed!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(() =>
      act(() => {
        incidents!.next(snapshot(seededDocs(ALICE)))
        vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS)
      })
    ).not.toThrow()
  })

  it('a UID change leaves exactly one timer and two live listeners', () => {
    const { rerender } = renderDashboard(ALICE)
    rerender({ uid: BOB })

    expect(vi.getTimerCount()).toBe(1)
    const live = listeners.filter((l) => l.unsubscribe.mock.calls.length === 0)
    expect(live).toHaveLength(2)
    expect(live.every((l) => JSON.stringify(l.query.constraints).includes(BOB))).toBe(true)
  })
})

describe('useIncidentDashboard — a failed Firestore client (synchronous SDK throws)', () => {
  // After "INTERNAL ASSERTION FAILED (ID: ca9)" the SDK's queue is failed and
  // onSnapshot / unsubscribe throw synchronously ("(ID: b815)") on every call.
  const failedQueue = () =>
    new Error(
      'FIRESTORE (11.10.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815) CONTEXT: {"hc":"…"}'
    )
  const throwFailedQueue = () => {
    throw failedQueue()
  }

  it('onSnapshot throwing becomes an error state instead of an uncaught render error', () => {
    vi.mocked(onSnapshot)
      .mockImplementationOnce(throwFailedQueue)
      .mockImplementationOnce(throwFailedQueue)

    const { result } = renderDashboard(ALICE)

    expect(result.current.status).toBe('error')
    expect(result.current.error?.code).toBe('internal')
    expect(result.current.error?.message).not.toMatch(/ASSERTION|b815/) // raw SDK text is not passed on
    expect(result.current.summary).toBeNull()
  })

  it('if only the second listener fails to start, the first is still stopped on unmount', () => {
    const recordListener = vi.mocked(onSnapshot).getMockImplementation()!
    vi.mocked(onSnapshot)
      .mockImplementationOnce(recordListener)
      .mockImplementationOnce(throwFailedQueue)

    const { result, unmount } = renderDashboard(ALICE)
    expect(result.current.status).toBe('error')

    unmount()
    expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('an unsubscribe that throws does not break unmount or retry', () => {
    const { result, unmount } = renderDashboard(ALICE)
    for (const listener of listeners) {
      listener.unsubscribe.mockImplementation(() => {
        throw failedQueue()
      })
    }

    expect(() => act(() => result.current.retry())).not.toThrow()
    expect(onSnapshot).toHaveBeenCalledTimes(4) // the retry still subscribed again
    expect(() => unmount()).not.toThrow()
  })

  it('never retries automatically; a manual retry subscribes again and can recover', () => {
    vi.mocked(onSnapshot).mockImplementationOnce(throwFailedQueue)
    const { result } = renderDashboard(ALICE)
    expect(result.current.status).toBe('error')

    act(() => vi.advanceTimersByTime(60_000))
    expect(onSnapshot).toHaveBeenCalledTimes(2) // no retry loop

    act(() => result.current.retry())
    expect(result.current.status).toBe('loading')
    confirmBoth(seededDocs(ALICE))
    expect(result.current.status).toBe('ready')
  })
})

describe('useIncidentDashboard — offline timer lifetime', () => {
  it('cancels the timer once both queries are server-confirmed, and stays ready', () => {
    const { result } = renderDashboard(ALICE)
    expect(vi.getTimerCount()).toBe(1)

    confirmBoth(seededDocs(ALICE))
    expect(vi.getTimerCount()).toBe(0)

    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS * 2))
    expect(result.current.status).toBe('ready')
  })

  it('keeps the timer while only one query, or only cached data, has arrived', () => {
    renderDashboard(ALICE)
    push('incidents', seededDocs(ALICE))
    push('actionLogs', [], { fromCache: true })
    expect(vi.getTimerCount()).toBe(1) // REVIEWED query not yet confirmed
  })

  it('a cached snapshot after confirmation is stale, without restarting the timer', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    push('incidents', seededDocs(ALICE), { fromCache: true })

    expect(result.current.status).toBe('stale')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retry() starts a fresh timer, which is cancelled again on confirmation', () => {
    const { result } = renderDashboard(ALICE)
    confirmBoth(seededDocs(ALICE))
    act(() => result.current.retry())
    expect(vi.getTimerCount()).toBe(1)

    confirmBoth(seededDocs(ALICE))
    expect(vi.getTimerCount()).toBe(0)
    expect(result.current.status).toBe('ready')
  })
})

describe('useIncidentDashboard — snapshot batched with a UID change', () => {
  it("a snapshot processed in the same batch as the switch never surfaces the old owner's data", () => {
    const seen: IncidentDashboardState[] = []
    const { result, rerender } = renderHook(
      ({ uid }: { uid: string | null }) => {
        const state = useIncidentDashboard(uid)
        seen.push(state)
        return state
      },
      { initialProps: { uid: ALICE as string | null } }
    )
    const [aliceIncidents, aliceReviewed] = listeners

    // Alice's snapshots are delivered and the account changes before React renders.
    act(() => {
      aliceIncidents!.next(snapshot(seededDocs(ALICE)))
      aliceReviewed!.next(snapshot([]))
      rerender({ uid: BOB })
    })

    expect(seen.some((s) => s.summary !== null)).toBe(false)
    expect(result.current).toMatchObject({ ownerUid: BOB, status: 'loading', summary: null })

    confirmBoth(seededDocs(BOB))
    expect(result.current.summary?.rows.every((r) => r.id.startsWith(`${BOB}_`))).toBe(true)
  })
})
