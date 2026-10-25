import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FirestoreError, collection, doc, onSnapshot, Timestamp } from 'firebase/firestore'
import { getClientDb } from '@/lib/firebase/client'
import { parseIncidentDetail } from '@/features/incidents/incidentDetail'
import {
  useIncidentDetail,
  type IncidentDetailState,
} from '@/features/incidents/hooks/useIncidentDetail'
import { SERVER_CONFIRMATION_TIMEOUT_MS } from '@/features/incidents/hooks/useIncidentDashboard'
import type { ActionType } from '@/types/firestore'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

// ── Mocked Firestore SDK ─────────────────────────────────────────────────────
// No Firebase connection: collection/doc/where/orderBy/query return plain
// descriptions, and onSnapshot records each listener so tests can push
// snapshots into it. The real incidentDoc / actionHistoryConstraints run on top
// of these, so the assertions check the references the app actually builds.
// Timestamp and FirestoreError stay real.

interface Target {
  path: string
  constraints?: unknown[]
}

interface Listener {
  target: Target
  options: unknown
  next: (snapshot: unknown) => void
  error: (error: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
}

const listeners = vi.hoisted(() => [] as Listener[])

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  doc: vi.fn((ref: { path: string }, id: string) => ({ path: `${ref.path}/${id}`, id })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: vi.fn((field: string, direction: string) => ({ orderBy: [field, direction] })),
  query: vi.fn((ref: { path: string }, ...constraints: unknown[]) => ({
    path: ref.path,
    constraints,
  })),
  onSnapshot: vi.fn(
    (target: Target, options: unknown, next: Listener['next'], error: Listener['error']) => {
      const unsubscribe = vi.fn()
      listeners.push({ target, options, next, error, unsubscribe })
      return unsubscribe
    }
  ),
}))

vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn(() => ({ fake: 'db' })) }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = 'alice-uid'
const BOB = 'bob-uid'
const NOW = new Date('2026-10-21T00:00:00.000Z')
const NOTE = 'Checked the simulated outage evidence.'
const SAFE_INCIDENT_MESSAGE = 'The incident could not be loaded.'
const SAFE_HISTORY_MESSAGE = 'The decision history could not be loaded.'

/** One Phase 3 seed incident, as the client SDK returns it. */
function storedIncident(owner: string, index = 0): { id: string; data: Record<string, unknown> } {
  const record = buildSeedIncidents(owner, NOW)[index]!
  return {
    id: record.id,
    data: {
      ...record.data,
      lastSignalAt: Timestamp.fromDate(record.data.lastSignalAt),
      createdAt: Timestamp.fromDate(record.data.createdAt),
    },
  }
}

const A1 = storedIncident(ALICE, 0) // alice-uid_INC-001
const A2 = storedIncident(ALICE, 1) // alice-uid_INC-002
const B1 = storedIncident(BOB, 0)

/** A document snapshot as the SDK delivers it; `data` undefined means it does not exist. */
function incidentSnapshot(
  id: string,
  data: Record<string, unknown> | undefined,
  fromCache = false
) {
  return {
    id,
    exists: () => data !== undefined,
    data: () => data,
    metadata: { fromCache, hasPendingWrites: false },
  }
}

interface DocMetadata {
  hasPendingWrites: boolean
  fromCache: boolean
}

interface FakeLog {
  id: string
  data: () => Record<string, unknown>
  metadata?: DocMetadata
}

let logSequence = 0

function log(
  actionType: ActionType | string,
  minute: number,
  overrides: Record<string, unknown> = {}
): FakeLog {
  const stored = {
    ownerUid: ALICE,
    incidentId: A1.id,
    actionType,
    note: NOTE,
    createdAt: Timestamp.fromDate(new Date(Date.UTC(2026, 9, 24, 1, minute))),
    _schemaVersion: 1,
    ...overrides,
  }
  return { id: `log-${++logSequence}`, data: vi.fn(() => stored) }
}

/** The same log as written locally and not yet accepted by the server (createdAt still unset). */
function pending(entry: FakeLog): FakeLog {
  const local = { ...entry.data(), createdAt: null }
  return {
    id: entry.id,
    data: vi.fn(() => local),
    metadata: { hasPendingWrites: true, fromCache: false },
  }
}

function accepted(entry: FakeLog): FakeLog {
  return { ...entry, metadata: { hasPendingWrites: false, fromCache: false } }
}

/** A query snapshot: each document has its own metadata; the query's hasPendingWrites reflects them. */
function historySnapshot(docs: FakeLog[], fromCache = false) {
  const withMetadata = docs.map((d) => ({
    ...d,
    metadata: d.metadata ?? { hasPendingWrites: false, fromCache },
  }))
  return {
    docs: withMetadata,
    empty: docs.length === 0,
    metadata: {
      fromCache,
      hasPendingWrites: withMetadata.some((d) => d.metadata.hasPendingWrites),
    },
  }
}

/** A delivered listener error with the SDK's runtime shape and a raw message. */
function firestoreError(code: string) {
  return Object.assign(new Error(`RAW SDK TEXT for ${code}`), { name: 'FirebaseError', code })
}

/** The newest listener of a kind (a re-subscription replaces the old one). */
function listenerFor(kind: 'incident' | 'history'): Listener {
  const found = listeners
    .filter((l) =>
      kind === 'incident' ? l.target.path.startsWith('incidents/') : l.target.path === 'actionLogs'
    )
    .at(-1)
  if (!found) throw new Error(`no ${kind} listener`)
  return found
}

function liveListeners() {
  return listeners.filter((l) => l.unsubscribe.mock.calls.length === 0)
}

function pushIncident(id: string, data: Record<string, unknown> | undefined, fromCache = false) {
  act(() => listenerFor('incident').next(incidentSnapshot(id, data, fromCache)))
}

function pushHistory(docs: FakeLog[], fromCache = false) {
  act(() => listenerFor('history').next(historySnapshot(docs, fromCache)))
}

/** Incident and history both confirmed by the server. */
function confirmBoth(incident = A1, docs: FakeLog[] = []) {
  pushIncident(incident.id, incident.data)
  pushHistory(docs)
}

function historyIds(state: IncidentDetailState) {
  return state.history.entries?.map((entry) => entry.id) ?? null
}

interface Props {
  uid: string | null
  incidentId: string
}

/** Renders the hook and records the state of every render. */
function renderDetail(uid: string | null, incidentId: string, options: { strict?: boolean } = {}) {
  const seen: Array<{ props: Props; state: IncidentDetailState }> = []
  const hook = renderHook(
    (props: Props) => {
      const state = useIncidentDetail(props.uid, props.incidentId)
      seen.push({ props, state })
      return state
    },
    // reactStrictMode renders the root in <StrictMode>: effects mount, clean up, mount again.
    { initialProps: { uid, incidentId }, reactStrictMode: options.strict }
  )
  return { ...hook, seen }
}

beforeEach(() => {
  listeners.length = 0
  logSequence = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useIncidentDetail — what it subscribes to', () => {
  it('listens to the incident document and its owner- and incident-scoped history, newest first', () => {
    renderDetail(ALICE, A1.id)

    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(listenerFor('incident').target).toEqual({ path: `incidents/${A1.id}`, id: A1.id })
    expect(listenerFor('history').target.constraints).toEqual([
      { where: ['ownerUid', '==', ALICE] },
      { where: ['incidentId', '==', A1.id] },
      { orderBy: ['createdAt', 'desc'] },
    ])
    for (const listener of listeners) {
      expect(listener.options).toEqual({ includeMetadataChanges: true })
    }
  })

  it.each([null, ''])('with no UID (%j) it is idle and never touches Firestore', (uid) => {
    const { result } = renderDetail(uid, A1.id)

    expect(result.current).toMatchObject({
      status: 'idle',
      ownerUid: null,
      incidentId: null,
      incident: null,
      canRecordDecision: false,
      reviewStatus: null,
      history: { status: 'idle', entries: null },
    })
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(getClientDb).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty ID', ''],
    ['a slash', `${A1.id}/actionLogs`],
    ['path traversal', '../incidents/bob-uid_INC-001'],
    ['129 characters', 'a'.repeat(129)],
    ['a dot', 'alice.INC-001'],
    ['a percent-encoded slash', 'alice%2FINC-001'],
    ['a space', 'alice INC-001'],
    ['a non-ASCII letter', 'alicé_INC-001'],
    ['a trailing newline', `${A1.id}\n`],
  ])('an ID with %s is rejected before any Firestore call', (_label, incidentId) => {
    const { result } = renderDetail(ALICE, incidentId)

    expect(result.current).toMatchObject({
      status: 'invalid-id',
      ownerUid: ALICE,
      incidentId: null,
      incident: null,
      canRecordDecision: false,
      history: { status: 'idle', entries: null },
    })
    expect(onSnapshot).not.toHaveBeenCalled()
    expect(doc).not.toHaveBeenCalled()
    expect(collection).not.toHaveBeenCalled()
    expect(getClientDb).not.toHaveBeenCalled()
  })

  it('accepts a 128-character ID, the longest the rules allow', () => {
    renderDetail(ALICE, 'a'.repeat(128))
    expect(onSnapshot).toHaveBeenCalledTimes(2)
  })
})

describe('useIncidentDetail — incident readiness', () => {
  it('starts loading, with nothing shown and no decision allowed', () => {
    const { result } = renderDetail(ALICE, A1.id)
    expect(result.current).toMatchObject({
      status: 'loading',
      ownerUid: ALICE,
      incidentId: A1.id,
      incident: null,
      canRecordDecision: false,
      reviewStatus: null,
      history: { status: 'loading', entries: null },
    })
  })

  it('a server-confirmed incident is ready, parsed exactly as parseIncidentDetail does', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)

    const expected = parseIncidentDetail(A1.id, A1.data, { ownerUid: ALICE })
    if (!expected.ok) throw new Error('fixture rejected')
    expect(result.current.status).toBe('ready')
    expect(result.current.incident).toEqual(expected.detail)
    expect(result.current.incident?.dataIssues).toEqual([])
    expect(result.current.canRecordDecision).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('a cached snapshot is not enough: loading until the server confirms', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data, true)
    expect(result.current.status).toBe('loading')
    expect(result.current.incident).toBeNull()
    expect(result.current.canRecordDecision).toBe(false)

    pushIncident(A1.id, A1.data)
    expect(result.current.status).toBe('ready')
  })

  it('a cached absence is not taken as "does not exist"', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, undefined, true)
    expect(result.current.status).toBe('loading')

    pushIncident(A1.id, undefined) // confirmed by the server
    expect(result.current.status).toBe('unavailable')
    expect(result.current.incident).toBeNull()
    expect(result.current.canRecordDecision).toBe(false)
  })

  it('missing fields still give a ready incident, with fallbacks recorded', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, { ...A1.data, evidenceSummary: '', state: 'NSW', createdAt: 'yesterday' })

    expect(result.current.status).toBe('ready')
    expect(result.current.incident?.evidenceSummary).toBeNull()
    expect(result.current.incident?.dataIssues).toEqual(['state', 'evidenceSummary', 'createdAt'])
  })

  it('ready → stale (cached snapshot keeps the data, no new decision) → ready', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    expect(result.current.canRecordDecision).toBe(true)
    pushIncident(A1.id, A1.data, true)

    expect(result.current.status).toBe('stale')
    expect(result.current.incident?.id).toBe(A1.id)
    expect(result.current.canRecordDecision).toBe(false)

    pushIncident(A1.id, A1.data)
    expect(result.current.status).toBe('ready')
    expect(result.current.canRecordDecision).toBe(true)
  })
})

describe('useIncidentDetail — the incident fails closed', () => {
  it('permission-denied (missing, or another operator’s) is "unavailable" with a safe message', () => {
    const { result } = renderDetail(ALICE, B1.id)
    pushHistory([])

    act(() => listenerFor('incident').error(firestoreError('permission-denied')))

    expect(result.current).toMatchObject({
      status: 'unavailable',
      incident: null,
      canRecordDecision: false,
      reviewStatus: null,
      history: { status: 'withheld', entries: null },
      error: { code: 'permission-denied', message: SAFE_INCIDENT_MESSAGE },
    })
  })

  it('another operator’s incident data, if delivered, is unavailable and never shown', () => {
    const { result, seen } = renderDetail(ALICE, B1.id)
    pushIncident(B1.id, B1.data, true) // e.g. left in the local cache
    expect(result.current.status).toBe('loading')

    pushIncident(B1.id, B1.data)
    expect(result.current.status).toBe('unavailable')
    expect(seen.every(({ state }) => state.incident === null)).toBe(true)
  })

  it('a record not marked isSimulated fails closed at once, even from the cache, and withholds history', () => {
    const { result, seen } = renderDetail(ALICE, A1.id)
    pushHistory([log('REVIEWED', 1)])
    pushIncident(A1.id, { ...A1.data, isSimulated: false }, true)

    expect(result.current).toMatchObject({
      status: 'integrity-error',
      incident: null,
      canRecordDecision: false,
      reviewStatus: null,
      history: { status: 'withheld', entries: null },
    })

    pushIncident(A1.id, { ...A1.data, isSimulated: false })
    expect(result.current.status).toBe('integrity-error')
    expect(seen.every(({ state }) => state.incident === null)).toBe(true)
  })

  it('recovers when the record is corrected (still listening)', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth({ ...A1, data: { ...A1.data, isSimulated: 'true' } })
    expect(result.current.status).toBe('integrity-error')

    pushIncident(A1.id, A1.data)
    expect(result.current.status).toBe('ready')
  })

  it('any other listener error is a general error, with no raw SDK text', () => {
    const { result } = renderDetail(ALICE, A1.id)
    act(() => listenerFor('incident').error(firestoreError('unavailable')))

    expect(result.current.status).toBe('error')
    expect(result.current.error).toEqual({ code: 'unavailable', message: SAFE_INCIDENT_MESSAGE })
    expect(result.current.history.status).toBe('withheld')
  })

  it('an error that is not a Firestore error is reported as internal', () => {
    const { result } = renderDetail(ALICE, A1.id)
    act(() => listenerFor('incident').error(new TypeError('boom')))
    expect(result.current.error).toEqual({ code: 'internal', message: SAFE_INCIDENT_MESSAGE })
  })

  it('a later error replaces data that was ready', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    act(() => listenerFor('incident').error(firestoreError('permission-denied')))
    expect(result.current.status).toBe('unavailable')
    expect(result.current.incident).toBeNull()
  })
})

describe('useIncidentDetail — synchronous SDK failures', () => {
  const SdkFirestoreError = FirestoreError as unknown as new (
    code: string,
    message: string
  ) => Error
  const throwing = (error: unknown) => () => {
    throw error
  }

  it('a Firestore error thrown when the incident listener starts keeps its code', () => {
    vi.mocked(onSnapshot).mockImplementationOnce(
      throwing(new SdkFirestoreError('permission-denied', 'raw'))
    )
    const { result } = renderDetail(ALICE, A1.id)

    expect(result.current.status).toBe('unavailable')
    expect(result.current.error).toEqual({
      code: 'permission-denied',
      message: 'The Firestore client could not start a listener.',
    })
  })

  it('a failed SDK queue (plain Error) is an internal error, never a crash', () => {
    const failedQueue = new Error('FIRESTORE (11.10.0) INTERNAL ASSERTION FAILED (ID: b815)')
    vi.mocked(onSnapshot)
      .mockImplementationOnce(throwing(failedQueue))
      .mockImplementationOnce(throwing(failedQueue))
    const { result } = renderDetail(ALICE, A1.id)

    expect(result.current.status).toBe('error')
    expect(result.current.error?.code).toBe('internal')
    expect(result.current.error?.message).not.toMatch(/ASSERTION|b815/)
  })

  it('if only the history listener fails to start, the incident still loads and is stopped on unmount', () => {
    const record = vi.mocked(onSnapshot).getMockImplementation()!
    vi.mocked(onSnapshot)
      .mockImplementationOnce(record)
      .mockImplementationOnce(throwing(new Error('x')))
    const { result, unmount } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)

    expect(result.current.status).toBe('ready')
    expect(result.current.history).toMatchObject({ status: 'error', error: { code: 'internal' } })

    unmount()
    expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('an unsubscribe that throws does not break unmount or retry', () => {
    const { result, unmount } = renderDetail(ALICE, A1.id)
    for (const listener of listeners) {
      listener.unsubscribe.mockImplementation(() => {
        throw new Error('failed queue')
      })
    }
    expect(() => act(() => result.current.retry())).not.toThrow()
    expect(onSnapshot).toHaveBeenCalledTimes(4)
    expect(() => unmount()).not.toThrow()
  })
})

describe('useIncidentDetail — history', () => {
  it('a server-confirmed empty history is ready and empty, so the incident is awaiting review', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [])

    expect(result.current.history).toEqual({
      status: 'ready',
      entries: [],
      rejectedCount: 0,
      dataIssueCount: 0,
      pendingCount: 0,
      error: null,
    })
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('a cached empty history is not a confirmed empty history', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)
    pushHistory([], true)

    expect(result.current.history.status).toBe('loading')
    expect(result.current.history.entries).toBeNull()
    expect(result.current.reviewStatus).toBeNull()
  })

  it('cached decisions before confirmation are not shown and give no review status', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)
    pushHistory([log('REVIEWED', 1)], true)

    expect(result.current.history.entries).toBeNull()
    expect(result.current.reviewStatus).toBeNull()
  })

  it('lists every decision newest first, whatever order the snapshot has', () => {
    const { result } = renderDetail(ALICE, A1.id)
    const early = log('ACKNOWLEDGE', 1)
    const late = log('REVIEWED', 30)
    const middle = log('ESCALATE', 10)
    confirmBoth(A1, [early, late, middle])

    expect(historyIds(result.current)).toEqual([late.id, middle.id, early.id])
    expect(result.current.history.entries?.map((e) => e.actionType)).toEqual([
      'REVIEWED',
      'ESCALATE',
      'ACKNOWLEDGE',
    ])
    expect(result.current.history.entries?.[0]).toMatchObject({ note: NOTE, dataIssues: [] })
  })

  it('ACKNOWLEDGE and ESCALATE are listed but leave the incident awaiting review', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [log('ACKNOWLEDGE', 1), log('ESCALATE', 2)])
    expect(result.current.history.entries).toHaveLength(2)
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('a REVIEWED decision marks it reviewed; duplicates are all listed but mean one reviewed incident', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [log('REVIEWED', 1), log('ACKNOWLEDGE', 2), log('REVIEWED', 3)])
    expect(result.current.history.entries).toHaveLength(3)
    expect(result.current.reviewStatus).toBe('REVIEWED')
  })

  it('malformed entries are listed with fallbacks; logs for another owner or incident are rejected and never count', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [
      log('ACKNOWLEDGE', 1, { note: 'short', createdAt: null }),
      log('CLOSE', 2),
      log('REVIEWED', 3, { ownerUid: BOB }),
      log('REVIEWED', 4, { incidentId: A2.id }),
      log('REVIEWED', 5, { incidentId: undefined }),
    ])

    expect(result.current.history).toMatchObject({
      status: 'ready',
      rejectedCount: 3,
      dataIssueCount: 2,
    })
    expect(result.current.history.entries?.map((e) => e.actionType)).toEqual([null, 'ACKNOWLEDGE'])
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('confirmed history goes stale from the cache and keeps its entries and review status', () => {
    const { result } = renderDetail(ALICE, A1.id)
    const reviewed = log('REVIEWED', 1)
    confirmBoth(A1, [reviewed])
    pushHistory([reviewed], true)

    expect(result.current.history.status).toBe('stale')
    expect(historyIds(result.current)).toEqual([reviewed.id])
    expect(result.current.reviewStatus).toBe('REVIEWED')
  })

  it('a missing composite index is reported as index-missing; the incident is still shown', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)
    act(() => listenerFor('history').error(firestoreError('failed-precondition')))

    expect(result.current.status).toBe('ready')
    expect(result.current.canRecordDecision).toBe(true)
    expect(result.current.reviewStatus).toBeNull()
    expect(result.current.history).toMatchObject({
      status: 'index-missing',
      entries: null,
      error: { code: 'failed-precondition', message: SAFE_HISTORY_MESSAGE },
    })
  })

  it('a refused history query is a history error; the incident is still shown', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    act(() => listenerFor('history').error(firestoreError('permission-denied')))

    expect(result.current.status).toBe('ready')
    expect(result.current.history).toMatchObject({
      status: 'error',
      entries: null,
      error: { code: 'permission-denied', message: SAFE_HISTORY_MESSAGE },
    })
    expect(result.current.reviewStatus).toBeNull()
  })
})

describe('useIncidentDetail — only server-accepted decisions are history', () => {
  it('a pending decision is counted as pending, not listed, and does not change the review status', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    const decision = log('REVIEWED', 5)
    const local = pending(decision)
    pushHistory([local])

    expect(result.current.history).toMatchObject({ status: 'ready', entries: [], pendingCount: 1 })
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
    expect(local.data).not.toHaveBeenCalled() // pending data is never read
  })

  it('pending → accepted (a metadata-only change) moves it into the history, without re-subscribing', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    const decision = log('REVIEWED', 5)
    pushHistory([pending(decision)])
    pushHistory([accepted(decision)])

    expect(historyIds(result.current)).toEqual([decision.id])
    expect(result.current.history.pendingCount).toBe(0)
    expect(result.current.reviewStatus).toBe('REVIEWED')
    expect(onSnapshot).toHaveBeenCalledTimes(2)
  })

  it('a pending decision never hides accepted ones in the same snapshot', () => {
    const { result } = renderDetail(ALICE, A1.id)
    confirmBoth()
    const ack = log('ACKNOWLEDGE', 1)
    const esc = log('ESCALATE', 2)
    pushHistory([ack, pending(log('REVIEWED', 3)), esc])

    expect(historyIds(result.current)).toEqual([esc.id, ack.id])
    expect(result.current.history.pendingCount).toBe(1)
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('a pending decision the server rejects is never listed or counted, in any render', () => {
    const { result, seen } = renderDetail(ALICE, A1.id)
    confirmBoth()
    pushHistory([pending(log('REVIEWED', 5))])
    pushHistory([]) // the SDK drops a rejected write

    expect(result.current.history).toMatchObject({ entries: [], pendingCount: 0 })
    expect(seen.every(({ state }) => (state.history.entries ?? []).length === 0)).toBe(true)
    expect(seen.every(({ state }) => state.reviewStatus !== 'REVIEWED')).toBe(true)
  })
})

describe('useIncidentDetail — offline timeout and retry', () => {
  it(`reports both as offline after ${SERVER_CONFIRMATION_TIMEOUT_MS} ms without confirmation`, () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data, true)

    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS - 1))
    expect(result.current.status).toBe('loading')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.status).toBe('offline')
    expect(result.current.history.status).toBe('offline')
    expect(result.current.incident).toBeNull()
  })

  it('incident and history readiness are independent', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushIncident(A1.id, A1.data)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))

    expect(result.current.status).toBe('ready')
    expect(result.current.history.status).toBe('offline')
    expect(result.current.reviewStatus).toBeNull()

    pushHistory([])
    expect(result.current.history.status).toBe('ready')
  })

  it('history can be ready while the incident is still loading', () => {
    const { result } = renderDetail(ALICE, A1.id)
    pushHistory([])
    expect(result.current.status).toBe('loading')
    expect(result.current.history.status).toBe('ready')
  })

  it('recovers from offline by itself once the server confirms', () => {
    const { result } = renderDetail(ALICE, A1.id)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    confirmBoth()
    expect(result.current.status).toBe('ready')
    expect(result.current.history.status).toBe('ready')
  })

  it('cancels the timer once both are confirmed, and does not restart it when data goes stale', () => {
    renderDetail(ALICE, A1.id)
    expect(vi.getTimerCount()).toBe(1)
    confirmBoth()
    expect(vi.getTimerCount()).toBe(0)
    pushIncident(A1.id, A1.data, true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retry() replaces both listeners and starts from loading; old callbacks are ignored', () => {
    const { result } = renderDetail(ALICE, A1.id)
    act(() => listenerFor('incident').error(firestoreError('unavailable')))
    const [oldIncident, oldHistory] = listeners

    act(() => result.current.retry())
    expect(oldIncident!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(oldHistory!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(result.current).toMatchObject({ status: 'loading', error: null, incident: null })

    act(() => {
      oldIncident!.next(incidentSnapshot(A1.id, A1.data))
      oldHistory!.next(historySnapshot([log('REVIEWED', 1)]))
    })
    expect(result.current.status).toBe('loading')

    confirmBoth()
    expect(result.current.status).toBe('ready')
  })

  it('retry() after "unavailable" can recover, e.g. once access is granted', () => {
    const { result } = renderDetail(ALICE, A1.id)
    act(() => listenerFor('incident').error(firestoreError('permission-denied')))
    act(() => result.current.retry())
    confirmBoth()
    expect(result.current.status).toBe('ready')
  })
})

describe('useIncidentDetail — owner and incident isolation', () => {
  it("switching UID never shows the previous owner's incident or history, not even for one render", () => {
    const { result, rerender, seen } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [log('REVIEWED', 1)])
    const aliceListeners = [...listeners]

    rerender({ uid: BOB, incidentId: A1.id })

    const bobRenders = seen.filter(({ props }) => props.uid === BOB)
    expect(bobRenders.length).toBeGreaterThan(0)
    for (const { state } of bobRenders) {
      expect(state).toMatchObject({
        ownerUid: BOB,
        status: 'loading',
        incident: null,
        reviewStatus: null,
      })
      expect(state.history.entries).toBeNull()
    }
    for (const listener of aliceListeners) expect(listener.unsubscribe).toHaveBeenCalledTimes(1)
    expect(listenerFor('history').target.constraints?.[0]).toEqual({
      where: ['ownerUid', '==', BOB],
    })
    expect(result.current.ownerUid).toBe(BOB)
  })

  it("the previous owner's late callbacks are ignored", () => {
    const { result, rerender } = renderDetail(ALICE, A1.id)
    const [aliceIncident, aliceHistory] = listeners
    rerender({ uid: BOB, incidentId: A1.id })

    act(() => {
      aliceIncident!.next(incidentSnapshot(A1.id, A1.data))
      aliceHistory!.next(historySnapshot([log('REVIEWED', 1)]))
      aliceIncident!.error(firestoreError('permission-denied'))
    })

    expect(result.current).toMatchObject({
      ownerUid: BOB,
      status: 'loading',
      error: null,
      incident: null,
    })
  })

  it('A → B → A starts from loading, and a late callback from the first A subscription is ignored', () => {
    const { result, rerender } = renderDetail(ALICE, A1.id)
    confirmBoth()
    const [firstIncident, firstHistory] = listeners
    rerender({ uid: BOB, incidentId: A1.id })
    rerender({ uid: ALICE, incidentId: A1.id })

    expect(result.current).toMatchObject({ ownerUid: ALICE, status: 'loading', incident: null })

    // Same UID, incident and generation as the current subscription: only its
    // `active` flag can tell the two apart.
    act(() => {
      firstIncident!.next(incidentSnapshot(A1.id, A1.data))
      firstHistory!.next(historySnapshot([log('REVIEWED', 1)]))
    })
    expect(result.current.status).toBe('loading')
    expect(liveListeners()).toHaveLength(2)
  })

  it("switching incident never shows the previous incident's data under the new ID", () => {
    const { result, rerender, seen } = renderDetail(ALICE, A1.id)
    confirmBoth(A1, [log('REVIEWED', 1)])

    rerender({ uid: ALICE, incidentId: A2.id })

    for (const { state } of seen.filter(({ props }) => props.incidentId === A2.id)) {
      expect(state).toMatchObject({
        incidentId: A2.id,
        status: 'loading',
        incident: null,
        reviewStatus: null,
      })
    }
    expect(listenerFor('incident').target.path).toBe(`incidents/${A2.id}`)
    expect(listenerFor('history').target.constraints?.[1]).toEqual({
      where: ['incidentId', '==', A2.id],
    })

    pushIncident(A2.id, A2.data)
    pushHistory([log('ACKNOWLEDGE', 1, { incidentId: A2.id })])
    expect(result.current.incident?.id).toBe(A2.id)
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('X → Y → X starts from loading, and late callbacks from earlier subscriptions are ignored', () => {
    const { result, rerender } = renderDetail(ALICE, A1.id)
    confirmBoth()
    const [firstIncident, firstHistory] = listeners
    rerender({ uid: ALICE, incidentId: A2.id })
    const [, , yIncident, yHistory] = listeners
    rerender({ uid: ALICE, incidentId: A1.id })

    act(() => {
      firstIncident!.next(incidentSnapshot(A1.id, A1.data))
      firstHistory!.next(historySnapshot([log('REVIEWED', 1)]))
      yIncident!.next(incidentSnapshot(A2.id, A2.data))
      yHistory!.next(historySnapshot([]))
    })

    expect(result.current).toMatchObject({ incidentId: A1.id, status: 'loading', incident: null })
    expect(liveListeners()).toHaveLength(2)
  })

  it("a snapshot processed in the same batch as an incident switch never surfaces the old incident's data", () => {
    const { result, rerender, seen } = renderDetail(ALICE, A1.id)
    const [incidentListener, historyListener] = listeners

    act(() => {
      incidentListener!.next(incidentSnapshot(A1.id, A1.data))
      historyListener!.next(historySnapshot([]))
      rerender({ uid: ALICE, incidentId: A2.id })
    })

    expect(
      seen.some(({ props, state }) => props.incidentId === A2.id && state.incident !== null)
    ).toBe(false)
    expect(result.current).toMatchObject({ incidentId: A2.id, status: 'loading' })
  })

  it('signing out (UID → null) unsubscribes and returns idle with no data or timer', () => {
    const { result, rerender } = renderDetail(ALICE, A1.id)
    confirmBoth()
    rerender({ uid: null, incidentId: A1.id })

    expect(result.current).toMatchObject({
      status: 'idle',
      incident: null,
      history: { status: 'idle' },
    })
    for (const listener of listeners) expect(listener.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('changing to an invalid ID unsubscribes and starts nothing new', () => {
    const { result, rerender } = renderDetail(ALICE, A1.id)
    confirmBoth()
    rerender({ uid: ALICE, incidentId: '../escape' })

    expect(result.current).toMatchObject({ status: 'invalid-id', incident: null })
    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(liveListeners()).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useIncidentDetail — cleanup and Strict Mode', () => {
  it('unmount stops both listeners and the timer; later callbacks do nothing', () => {
    const { unmount } = renderDetail(ALICE, A1.id)
    const [incidentListener, historyListener] = listeners
    unmount()

    expect(incidentListener!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(historyListener!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(() =>
      act(() => {
        incidentListener!.next(incidentSnapshot(A1.id, A1.data))
        historyListener!.error(firestoreError('unavailable'))
        vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS)
      })
    ).not.toThrow()
  })

  it('under Strict Mode, the first mount’s listeners are stopped and its callbacks ignored', () => {
    const { result } = renderDetail(ALICE, A1.id, { strict: true })

    // Mount → cleanup → mount: four listeners started, the first two stopped.
    expect(onSnapshot).toHaveBeenCalledTimes(4)
    const [firstIncident, firstHistory] = listeners
    expect(firstIncident!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(firstHistory!.unsubscribe).toHaveBeenCalledTimes(1)
    expect(liveListeners()).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(1)

    act(() => {
      firstIncident!.next(incidentSnapshot(A1.id, A1.data))
      firstHistory!.next(historySnapshot([log('REVIEWED', 1)]))
    })
    expect(result.current.status).toBe('loading')

    confirmBoth(A1, [log('ACKNOWLEDGE', 1)])
    expect(result.current.status).toBe('ready')
    expect(result.current.reviewStatus).toBe('AWAITING_REVIEW')
  })

  it('a UID change leaves exactly one timer and two live listeners', () => {
    const { rerender } = renderDetail(ALICE, A1.id)
    rerender({ uid: BOB, incidentId: B1.id })
    expect(vi.getTimerCount()).toBe(1)
    const live = liveListeners()
    expect(live).toHaveLength(2)
    expect(live.every((l) => JSON.stringify(l.target).includes(BOB))).toBe(true)
  })
})
