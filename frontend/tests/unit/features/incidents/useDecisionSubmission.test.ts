import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDoc, serverTimestamp, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'
import { getClientDb } from '@/lib/firebase/client'
import {
  SLOW_SAVE_AFTER_MS,
  useDecisionSubmission,
  type DecisionSubmissionState,
} from '@/features/incidents/hooks/useDecisionSubmission'

// ── Mocked Firestore writes ──────────────────────────────────────────────────
// Every addDoc call returns a promise the test settles by hand, standing in
// for the server's answer. The real write adapter, payload builder and
// serverTimestamp() run on top.

interface PendingWrite {
  data: Record<string, unknown>
  settled: boolean
  accept: (id: string) => Promise<void>
  refuse: (error: unknown) => Promise<void>
}

const writes = vi.hoisted(() => [] as PendingWrite[])

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  addDoc: vi.fn(
    (_ref: unknown, data: Record<string, unknown>) =>
      new Promise((resolve, reject) => {
        const write: PendingWrite = {
          data,
          settled: false,
          // act() flushes the promise chain and the resulting React updates.
          accept: (id) =>
            act(async () => {
              write.settled = true
              resolve({ id })
            }),
          refuse: (error) =>
            act(async () => {
              write.settled = true
              reject(error)
            }),
        }
        writes.push(write)
      })
  ),
}))
vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn(() => ({ fake: 'db' })) }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = 'alice-uid'
const BOB = 'bob-uid'
const A1 = `${ALICE}_INC-001`
const A2 = `${ALICE}_INC-002`
const B1 = `${BOB}_INC-001`
const NOTE = 'Checked the simulated outage evidence.'
const REVIEWED = { actionType: 'REVIEWED', note: NOTE }

/** A delivered error with the SDK's runtime shape and a raw message. */
function firestoreError(code: string) {
  return Object.assign(new Error(`RAW SDK TEXT ${code}`), { name: 'FirebaseError', code })
}

interface Props {
  uid: string | null
  incidentId: string
  canRecordDecision: boolean
}

function renderSubmission(props: Partial<Props> = {}, options: { strict?: boolean } = {}) {
  const seen: Array<{ props: Props; state: DecisionSubmissionState }> = []
  const initialProps: Props = { uid: ALICE, incidentId: A1, canRecordDecision: true, ...props }
  const hook = renderHook(
    (p: Props) => {
      const state = useDecisionSubmission(p)
      seen.push({ props: p, state })
      return state
    },
    { initialProps, reactStrictMode: options.strict }
  )
  return { ...hook, seen }
}

function submit(result: { current: DecisionSubmissionState }, input: unknown = REVIEWED) {
  let outcome: ReturnType<DecisionSubmissionState['submit']> | undefined
  act(() => {
    outcome = result.current.submit(input)
  })
  return outcome
}

function lastWrite(): PendingWrite {
  const write = writes.at(-1)
  if (!write) throw new Error('no write')
  return write
}

beforeEach(() => {
  writes.length = 0
  vi.clearAllMocks()
  vi.useFakeTimers()
})

afterEach(async () => {
  // Settle anything left unresolved, so the module-level lock is released
  // before the next test (it outlives components by design).
  for (const write of writes.filter((w) => !w.settled))
    await write.refuse(new Error('test cleanup'))
  vi.useRealTimers()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useDecisionSubmission — starting a write', () => {
  it.each(['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'])(
    'a valid %s decision starts exactly one write with the six-field payload',
    (actionType) => {
      const { result } = renderSubmission()
      expect(submit(result, { actionType, note: NOTE })).toBe('started')

      expect(addDoc).toHaveBeenCalledTimes(1)
      expect(lastWrite().data).toEqual({
        ownerUid: ALICE,
        incidentId: A1,
        actionType,
        note: NOTE,
        createdAt: serverTimestamp(),
        _schemaVersion: 1,
      })
      expect(result.current).toMatchObject({
        status: 'saving',
        isSubmitting: true,
        isWaiting: false,
        saved: null,
        error: null,
      })
    }
  )

  it('sends the note trimmed as the rules require, keeping its inner lines', () => {
    const { result } = renderSubmission()
    submit(result, { actionType: 'ACKNOWLEDGE', note: '\u0001  Line one.\nLine two. \n　' })
    expect(lastWrite().data.note).toBe('Line one.\nLine two.')
  })

  it('counts length in UTF-16 code units, as the rules do', () => {
    const { result } = renderSubmission()
    expect(submit(result, { actionType: 'REVIEWED', note: '\u{1F600}'.repeat(251) })).toBe(
      'invalid'
    )
    expect(submit(result, { actionType: 'REVIEWED', note: '\u{1F600}'.repeat(5) })).toBe('started')
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['an empty rationale', { actionType: 'REVIEWED', note: '' }, 'note'],
    ['9 characters', { actionType: 'REVIEWED', note: 'a'.repeat(9) }, 'note'],
    ['501 characters', { actionType: 'REVIEWED', note: 'a'.repeat(501) }, 'note'],
    ['only whitespace', { actionType: 'REVIEWED', note: ' \n\t '.repeat(5) }, 'note'],
    ['only control characters', { actionType: 'REVIEWED', note: '\u0001'.repeat(12) }, 'note'],
    ['no decision', { note: NOTE }, 'actionType'],
    ['an unknown decision', { actionType: 'CLOSE', note: NOTE }, 'actionType'],
    ['input that is not an object', 'REVIEWED', 'input'],
  ])('%s is invalid: feedback, and no write', (_label, input, field) => {
    const { result } = renderSubmission()
    expect(submit(result, input)).toBe('invalid')

    expect(addDoc).not.toHaveBeenCalled()
    expect(result.current).toMatchObject({ status: 'invalid', isSubmitting: false })
    expect(result.current.issues.map((issue) => issue.field)).toContain(field)
  })

  it('an invalid attempt takes no lock: a corrected one can start at once', () => {
    const { result } = renderSubmission()
    submit(result, { actionType: 'REVIEWED', note: 'short' })
    expect(submit(result)).toBe('started')
  })

  it.each([
    ['the incident is not currently confirmed', { canRecordDecision: false }],
    ['there is no signed-in user', { uid: null }],
    ['the incident ID is invalid', { incidentId: '../escape' }],
  ])('nothing is written when %s', (_label, props) => {
    const { result } = renderSubmission(props)
    expect(submit(result)).toBe('ineligible')
    expect(result.current.status).toBe('ineligible')
    expect(addDoc).not.toHaveBeenCalled()
    expect(getClientDb).not.toHaveBeenCalled()
  })
})

describe('useDecisionSubmission — success only after the server accepts', () => {
  it('stays saving while the write is unanswered, then becomes waiting at the slow threshold', () => {
    const { result, seen } = renderSubmission()
    submit(result)

    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS - 1))
    expect(result.current.status).toBe('saving')
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toMatchObject({ status: 'waiting', isWaiting: true, isSubmitting: true })

    // A slow write is never treated as failed or saved, however long it takes.
    act(() => vi.advanceTimersByTime(10 * 60_000))
    expect(result.current.status).toBe('waiting')
    expect(seen.every(({ state }) => state.status !== 'saved' && state.saved === null)).toBe(true)
    expect(addDoc).toHaveBeenCalledTimes(1) // no automatic retry
  })

  it('is saved only once the write resolves, with the accepted decision', async () => {
    const { result } = renderSubmission()
    submit(result, { actionType: 'ESCALATE', note: NOTE })
    expect(result.current.status).toBe('saving')

    await lastWrite().accept('log-7')

    expect(result.current).toMatchObject({
      status: 'saved',
      isSubmitting: false,
      isWaiting: false,
      saved: { actionLogId: 'log-7', actionType: 'ESCALATE' },
      error: null,
    })
  })

  it('a confirmation that arrives after the waiting state still ends in saved', async () => {
    const { result } = renderSubmission()
    submit(result)
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS * 3))
    expect(result.current.status).toBe('waiting')

    await lastWrite().accept('log-late')
    expect(result.current).toMatchObject({ status: 'saved', saved: { actionLogId: 'log-late' } })
  })

  it('no slow-save timer is left once the write is answered', async () => {
    const { result } = renderSubmission()
    submit(result)
    await lastWrite().accept('log-1')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('useDecisionSubmission — refused writes', () => {
  it.each([
    ['permission-denied', /refused/],
    ['unavailable', /couldn't be reached/],
    ['unauthenticated', /not signed in/],
    ['failed-precondition', /Reload the page/],
  ])(
    '%s: failed with its code and a write-specific message, never the raw text',
    async (code, message) => {
      const { result } = renderSubmission()
      submit(result)
      await lastWrite().refuse(firestoreError(code))

      expect(result.current.status).toBe('failed')
      expect(result.current.isSubmitting).toBe(false)
      expect(result.current.error?.code).toBe(code)
      expect(result.current.error?.message).toMatch(message)
      expect(result.current.error?.message).not.toMatch(/RAW SDK TEXT/)
    }
  )

  it.each([
    ['an invented code', firestoreError('totally-made-up')],
    ['a plain object with a valid code', { name: 'FirebaseError', code: 'permission-denied' }],
    ['an ordinary Error', new Error('boom')],
  ])('%s is reported as internal', async (_label, error) => {
    const { result } = renderSubmission()
    submit(result)
    await lastWrite().refuse(error)
    expect(result.current.error).toEqual({
      code: 'internal',
      message: "The decision couldn't be saved. Retry; if it keeps happening, reload the page.",
    })
  })

  it('never retries by itself; an explicit retry starts one new write', async () => {
    const { result } = renderSubmission()
    submit(result)
    await lastWrite().refuse(firestoreError('unavailable'))

    act(() => vi.advanceTimersByTime(60_000))
    expect(addDoc).toHaveBeenCalledTimes(1)

    expect(submit(result)).toBe('started')
    expect(addDoc).toHaveBeenCalledTimes(2)
    await lastWrite().accept('log-retry')
    expect(result.current).toMatchObject({ status: 'saved', saved: { actionLogId: 'log-retry' } })
  })

  it('holds no form values, so whatever the user typed is untouched (the form keeps it)', async () => {
    const { result } = renderSubmission()
    const input = { actionType: 'REVIEWED', note: NOTE }
    submit(result, input)
    await lastWrite().refuse(firestoreError('permission-denied'))
    expect(input).toEqual({ actionType: 'REVIEWED', note: NOTE })
    expect(Object.keys(result.current).sort()).toEqual(
      ['error', 'isSubmitting', 'isWaiting', 'issues', 'reset', 'saved', 'status', 'submit'].sort()
    )
  })

  it('reset() clears a finished result but does nothing while a write is unresolved', async () => {
    const { result } = renderSubmission()
    submit(result)
    act(() => result.current.reset())
    expect(result.current.status).toBe('saving')

    await lastWrite().refuse(firestoreError('unavailable'))
    act(() => result.current.reset())
    expect(result.current).toMatchObject({ status: 'idle', error: null })
  })
})

describe('useDecisionSubmission — duplicate protection', () => {
  it('two submits before React re-renders start only one write', () => {
    const { result } = renderSubmission()
    const outcomes: string[] = []
    act(() => {
      outcomes.push(result.current.submit(REVIEWED))
      outcomes.push(result.current.submit(REVIEWED)) // same render: a double click / double Enter
      outcomes.push(result.current.submit({ actionType: 'ESCALATE', note: NOTE }))
    })
    expect(outcomes).toEqual(['started', 'busy', 'busy'])
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('stays locked for as long as the write is unanswered', () => {
    const { result } = renderSubmission()
    submit(result)
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS + 5_000))
    expect(submit(result)).toBe('busy')
    expect(result.current.status).toBe('waiting')
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('after a confirmed decision, another one (even a second REVIEWED) can be recorded', async () => {
    const { result } = renderSubmission()
    submit(result)
    await lastWrite().accept('log-1')
    expect(submit(result)).toBe('started')
    await lastWrite().accept('log-2')

    expect(addDoc).toHaveBeenCalledTimes(2)
    expect(result.current.saved).toEqual({ actionLogId: 'log-2', actionType: 'REVIEWED' })
  })

  it('the incident going stale during a write keeps the write and its lock; it can still be saved', async () => {
    const { result, rerender } = renderSubmission()
    submit(result)
    rerender({ uid: ALICE, incidentId: A1, canRecordDecision: false })
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS))

    expect(result.current).toMatchObject({ status: 'waiting', isSubmitting: true })
    expect(submit(result)).toBe('busy')

    await lastWrite().accept('log-1')
    expect(result.current.status).toBe('saved')
    expect(submit(result)).toBe('ineligible') // a new decision waits for re-confirmation
    expect(addDoc).toHaveBeenCalledTimes(1)
  })
})

describe('useDecisionSubmission — remounts and unmounts', () => {
  it('unmounting during a write updates nothing; a remount follows the same write and stays locked', async () => {
    const first = renderSubmission()
    submit(first.result)
    first.unmount()

    const second = renderSubmission()
    expect(second.result.current).toMatchObject({ status: 'saving', isSubmitting: true })
    expect(submit(second.result)).toBe('busy')
    expect(addDoc).toHaveBeenCalledTimes(1)

    await lastWrite().accept('log-1')
    expect(second.result.current).toMatchObject({
      status: 'saved',
      saved: { actionLogId: 'log-1' },
    })
  })

  it('a remount after the slow threshold shows waiting straight away', () => {
    const first = renderSubmission()
    submit(first.result)
    first.unmount()
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS + 1))

    const second = renderSubmission()
    act(() => vi.advanceTimersByTime(0))
    expect(second.result.current.status).toBe('waiting')
  })

  it('a write answered while unmounted releases the lock; a remount starts idle', async () => {
    const first = renderSubmission()
    submit(first.result)
    first.unmount()
    await lastWrite().accept('log-1')

    const second = renderSubmission()
    expect(second.result.current.status).toBe('idle')
    expect(submit(second.result)).toBe('started')
  })

  it('under Strict Mode, mounting writes nothing and one submit writes once', async () => {
    const { result } = renderSubmission({}, { strict: true })
    expect(addDoc).not.toHaveBeenCalled()

    expect(submit(result)).toBe('started')
    expect(addDoc).toHaveBeenCalledTimes(1)
    await lastWrite().accept('log-1')
    expect(result.current.status).toBe('saved')
    expect(addDoc).toHaveBeenCalledTimes(1)
  })
})

describe('useDecisionSubmission — user and incident isolation', () => {
  it("a new user never sees the previous user's pending state or result, not even for one render", async () => {
    const { result, rerender, seen } = renderSubmission()
    submit(result)
    rerender({ uid: BOB, incidentId: B1, canRecordDecision: true })

    for (const { state } of seen.filter(({ props }) => props.uid === BOB)) {
      expect(state).toMatchObject({ status: 'idle', isSubmitting: false, saved: null, error: null })
    }

    await writes[0]!.accept('alice-log') // Alice's write answers while Bob is shown
    expect(result.current).toMatchObject({ status: 'idle', saved: null })
  })

  it("a saved decision's feedback does not follow the user to another account", async () => {
    const { result, rerender } = renderSubmission()
    submit(result)
    await lastWrite().accept('alice-log')
    expect(result.current.status).toBe('saved')

    rerender({ uid: BOB, incidentId: B1, canRecordDecision: true })
    expect(result.current).toMatchObject({ status: 'idle', saved: null })
  })

  it('another incident has its own lock and state; returning finds the first write still locked', async () => {
    const { result, rerender } = renderSubmission()
    submit(result) // on A1
    rerender({ uid: ALICE, incidentId: A2, canRecordDecision: true })
    expect(result.current.status).toBe('idle')
    expect(submit(result)).toBe('started') // A2 is a different incident
    const a2Write = lastWrite()

    rerender({ uid: ALICE, incidentId: A1, canRecordDecision: true })
    expect(result.current).toMatchObject({ status: 'saving', isSubmitting: true })
    expect(submit(result)).toBe('busy')

    await a2Write.accept('a2-log') // A2's answer must not show under A1
    expect(result.current.status).toBe('saving')
    await writes[0]!.accept('a1-log')
    expect(result.current).toMatchObject({ status: 'saved', saved: { actionLogId: 'a1-log' } })
  })

  it('a result arriving after switching incidents does not overwrite the new incident', async () => {
    const { result, rerender } = renderSubmission()
    submit(result)
    rerender({ uid: ALICE, incidentId: A2, canRecordDecision: true })
    await writes[0]!.refuse(firestoreError('permission-denied'))
    expect(result.current).toMatchObject({ status: 'idle', error: null })
  })

  it('signing out shows no submission state and allows no write', () => {
    const { result, rerender } = renderSubmission()
    submit(result)
    rerender({ uid: null, incidentId: A1, canRecordDecision: false })
    expect(result.current).toMatchObject({ status: 'idle', isSubmitting: false })
    expect(submit(result)).toBe('ineligible')
    expect(addDoc).toHaveBeenCalledTimes(1)
  })
})

describe('useDecisionSubmission — ESCALATE only records', () => {
  it('writes one action log and calls nothing else', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { result } = renderSubmission()
    submit(result, { actionType: 'ESCALATE', note: NOTE })
    await lastWrite().accept('log-esc')

    expect(addDoc).toHaveBeenCalledTimes(1)
    expect(lastWrite().data.actionType).toBe('ESCALATE')
    for (const other of [setDoc, updateDoc, deleteDoc])
      expect(vi.mocked(other)).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
