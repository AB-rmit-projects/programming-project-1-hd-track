// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addDoc, deleteDoc, doc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { getClientDb } from '@/lib/firebase/client'
import { startDecisionWrite, toDecisionWriteError } from '@/features/incidents/decisionWriter'

// addDoc is a controllable spy; serverTimestamp stays real, so the payload
// carries the genuine sentinel.
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  addDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn(),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
}))
vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn(() => ({ fake: 'db' })) }))

const OWNER = 'demoOperatorUid01'
const INCIDENT = `${OWNER}_INC-001`
const NOTE = 'Checked the simulated outage evidence.'

/** A delivered error with the SDK's runtime shape and a raw message. */
function firestoreError(code: string) {
  return Object.assign(new Error(`RAW SDK TEXT ${code}`), { name: 'FirebaseError', code })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('startDecisionWrite', () => {
  it('invalid input is returned as issues and nothing is written', () => {
    const start = startDecisionWrite(OWNER, INCIDENT, { actionType: 'CLOSE', note: 'short' })
    expect(start).toEqual({
      started: false,
      issues: [
        { field: 'actionType', message: 'Choose ACKNOWLEDGE, ESCALATE or REVIEWED.' },
        { field: 'note', message: 'Enter between 10 and 500 characters.' },
      ],
    })
    expect(addDoc).not.toHaveBeenCalled()
    expect(getClientDb).not.toHaveBeenCalled()
  })

  it('creates one action log with exactly the six fields, calling addDoc before it returns', () => {
    vi.mocked(addDoc).mockReturnValue(new Promise(() => {}))
    const start = startDecisionWrite(OWNER, INCIDENT, {
      actionType: 'REVIEWED',
      note: ` ${NOTE}\n`,
    })

    expect(start.started).toBe(true)
    expect(addDoc).toHaveBeenCalledTimes(1)
    const [ref, data] = vi.mocked(addDoc).mock.calls[0]!
    expect(ref).toEqual({ path: 'actionLogs' })
    expect(data).toEqual({
      ownerUid: OWNER,
      incidentId: INCIDENT,
      actionType: 'REVIEWED',
      note: NOTE,
      createdAt: serverTimestamp(),
      _schemaVersion: 1,
    })
  })

  it('is confirmed only when the write promise resolves', async () => {
    let resolveWrite!: (value: { id: string }) => void
    vi.mocked(addDoc).mockReturnValue(
      // A stand-in for the DocumentReference addDoc resolves with: only its id is used.
      new Promise<{ id: string }>((resolve) => {
        resolveWrite = resolve
      }) as unknown as ReturnType<typeof addDoc>
    )
    const start = startDecisionWrite(OWNER, INCIDENT, { actionType: 'ESCALATE', note: NOTE })
    if (!start.started) throw new Error('expected a write')

    const settled = vi.fn()
    void start.confirmed.then(settled)
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    resolveWrite({ id: 'log-42' })
    await expect(start.confirmed).resolves.toEqual({
      ok: true,
      actionLogId: 'log-42',
      actionType: 'ESCALATE',
    })
  })

  it('a rejected write resolves (never rejects) with a safe, action-specific error', async () => {
    vi.mocked(addDoc).mockRejectedValue(firestoreError('permission-denied'))
    const start = startDecisionWrite(OWNER, INCIDENT, { actionType: 'ACKNOWLEDGE', note: NOTE })
    if (!start.started) throw new Error('expected a write')

    const outcome = await start.confirmed
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'permission-denied',
        message:
          'The decision was refused. Your session may have ended, or this incident is not available to your account.',
      },
    })
    expect(JSON.stringify(outcome)).not.toContain('RAW SDK TEXT')
  })

  it('a synchronous failure (e.g. Firebase not configured) is also a safe failed outcome', async () => {
    vi.mocked(getClientDb).mockImplementationOnce(() => {
      throw new Error('Firebase web config is incomplete')
    })
    const start = startDecisionWrite(OWNER, INCIDENT, { actionType: 'REVIEWED', note: NOTE })
    if (!start.started) throw new Error('expected a write attempt')
    await expect(start.confirmed).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('touches nothing but addDoc on the actionLogs collection — ESCALATE included', () => {
    vi.mocked(addDoc).mockReturnValue(new Promise(() => {}))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const actionType of ['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED']) {
      startDecisionWrite(OWNER, INCIDENT, { actionType, note: NOTE })
    }
    expect(addDoc).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(addDoc).mock.calls) expect(call[0]).toEqual({ path: 'actionLogs' })
    for (const other of [setDoc, updateDoc, deleteDoc, doc])
      expect(vi.mocked(other)).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('toDecisionWriteError', () => {
  it.each([
    ['permission-denied', /refused/],
    ['unauthenticated', /not signed in/],
    ['unavailable', /couldn't be reached/],
    ['deadline-exceeded', /didn't answer in time/],
    ['failed-precondition', /Reload the page/],
    ['invalid-argument', /form the database accepts/],
    ['aborted', /couldn't be saved\. Retry/],
  ])('%s keeps its code with a write-specific message', (code, message) => {
    const error = toDecisionWriteError(firestoreError(code))
    expect(error.code).toBe(code)
    expect(error.message).toMatch(message)
    expect(error.message).not.toMatch(/RAW SDK TEXT|listener/)
  })

  it.each([
    ['an invented code', firestoreError('made-up-code')],
    ['a prefixed code from another service', firestoreError('auth/network-request-failed')],
    ['a plain object', { name: 'FirebaseError', code: 'permission-denied' }],
    ['an ordinary Error', new Error('boom')],
    ['a string', 'permission-denied'],
  ])('%s becomes internal with the default message', (_label, error) => {
    expect(toDecisionWriteError(error)).toEqual({
      code: 'internal',
      message: "The decision couldn't be saved. Retry; if it keeps happening, reload the page.",
    })
  })
})
