// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { deleteApp, initializeApp } from 'firebase/app'
import { collection, FirestoreError, initializeFirestore } from 'firebase/firestore'
import {
  safeListen,
  toListenerError,
  withSnapshot,
  type ListenerError,
  type ListenerState,
} from '@/features/incidents/hooks/listenerState'

// The hook tests cover these through useIncidentDashboard; these pin down the
// paths that only show up here (how a start-up throw is classified, and the
// readiness rules of withSnapshot on their own).

const SAFE_MESSAGE = 'The Firestore client could not start a listener.'

/** Runs safeListen with a start function that throws `thrown`; returns what was reported. */
function reportedFor(thrown: unknown): ListenerError {
  const onError = vi.fn<(error: ListenerError) => void>()
  safeListen(() => {
    throw thrown
  }, onError)
  expect(onError).toHaveBeenCalledTimes(1)
  return onError.mock.calls[0]![0]
}

function caught(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

/**
 * The SDK's own FirestoreError class, as it builds the errors it delivers for
 * server responses (permission-denied, unavailable …), which cannot be
 * triggered synchronously without a server. The constructor is private in the
 * typings but is the one the SDK calls.
 */
const SdkFirestoreError = FirestoreError as unknown as new (code: string, message: string) => Error

/** An Error with a FirebaseError's runtime shape, but built here (not by the SDK). */
function lookalike(code: unknown, message = 'raw text'): Error {
  return Object.assign(new Error(message), { name: 'FirebaseError', code })
}

describe('withSnapshot', () => {
  const pending: ListenerState<string> = { phase: 'pending' }

  it('a cached first snapshot is not confirmed', () => {
    expect(withSnapshot(pending, ['a'], true)).toEqual({
      phase: 'snapshot',
      docs: ['a'],
      fromCache: true,
      confirmed: false,
    })
  })

  it('a server snapshot confirms the listener', () => {
    expect(withSnapshot(pending, ['a'], false)).toMatchObject({ fromCache: false, confirmed: true })
  })

  it('once confirmed, a later cached snapshot stays confirmed but is marked fromCache (stale)', () => {
    const confirmed = withSnapshot(pending, ['a'], false)
    expect(withSnapshot(confirmed, ['b'], true)).toEqual({
      phase: 'snapshot',
      docs: ['b'],
      fromCache: true,
      confirmed: true,
    })
  })

  it('after an error, only a server snapshot confirms again', () => {
    const failed: ListenerState<string> = {
      phase: 'error',
      error: { code: 'unavailable', message: 'x' },
    }
    expect(withSnapshot(failed, [], true)).toMatchObject({ confirmed: false })
    expect(withSnapshot(failed, [], false)).toMatchObject({ confirmed: true })
  })

  it('always returns a new state object, so React sees every snapshot', () => {
    const first = withSnapshot(pending, ['a'], false)
    expect(withSnapshot(first, ['a'], false)).not.toBe(first)
  })
})

describe('safeListen', () => {
  it('returns a stop function that stops the listener exactly once per call', () => {
    const stop = vi.fn()
    const onError = vi.fn()
    const unsubscribe = safeListen(() => stop, onError)

    unsubscribe()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  // In firebase 11.10 the FirebaseError base class resets the prototype, so
  // `instanceof FirestoreError` is false even for errors the SDK throws; the
  // code is recognised from the error's runtime shape instead.
  it('a genuine SDK invalid-argument error keeps its code, not its message', () => {
    const thrown = caught(() => collection({} as never, 'incidents'))
    expect(thrown).toMatchObject({ name: 'FirebaseError', code: 'invalid-argument' })
    expect(thrown instanceof FirestoreError).toBe(false) // the SDK behaviour behind the fix

    const onError = vi.fn<(error: ListenerError) => void>()
    const unsubscribe = safeListen(() => {
      throw thrown
    }, onError)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[0]).toEqual({ code: 'invalid-argument', message: SAFE_MESSAGE })
    expect(() => unsubscribe()).not.toThrow()
  })

  it('a genuine SDK failed-precondition error keeps its code', async () => {
    // No network: initialising the same Firestore instance twice with different options.
    const app = initializeApp(
      { projectId: 'demo-listener-state', apiKey: 'test' },
      'listener-state'
    )
    try {
      initializeFirestore(app, {})
      const thrown = caught(() => initializeFirestore(app, { ignoreUndefinedProperties: true }))
      expect(thrown).toMatchObject({ name: 'FirebaseError', code: 'failed-precondition' })

      expect(reportedFor(thrown)).toEqual({ code: 'failed-precondition', message: SAFE_MESSAGE })
    } finally {
      await deleteApp(app)
    }
  })

  it.each(['permission-denied', 'unavailable'])(
    'a %s error built by the SDK class keeps its code',
    (code) => {
      const thrown = new SdkFirestoreError(code, 'Raw SDK text that must not reach the UI.')
      expect(thrown).toMatchObject({ name: 'FirebaseError', code })

      expect(reportedFor(thrown)).toEqual({ code, message: SAFE_MESSAGE })
    }
  )

  it('never passes on the raw message of a recognised error', () => {
    const thrown = new SdkFirestoreError('permission-denied', '<script>alert(1)</script>')
    expect(reportedFor(thrown).message).toBe(SAFE_MESSAGE)
  })

  it('any other start-up throw becomes an internal error without the raw SDK text', () => {
    const onError = vi.fn<(error: ListenerError) => void>()
    safeListen(() => {
      throw new Error('FIRESTORE (11.10.0) INTERNAL ASSERTION FAILED: Unexpected state (ID: b815)')
    }, onError)

    expect(onError.mock.calls[0]?.[0]).toEqual({
      code: 'internal',
      message: 'The Firestore client could not start a listener.',
    })
  })

  it.each([
    [
      'a plain object shaped like a FirebaseError',
      { name: 'FirebaseError', code: 'permission-denied', message: 'x' },
    ],
    ['a FirebaseError-named Error with an invented code', lookalike('totally-made-up')],
    ['a FirebaseError-named Error with an inherited key as code', lookalike('toString')],
    ['a FirebaseError-named Error with a non-string code', lookalike(7)],
    ['another Firebase service error (prefixed code)', lookalike('auth/network-request-failed')],
    [
      'an ordinary Error carrying a Firestore code',
      Object.assign(new Error('x'), { code: 'permission-denied' }),
    ],
    ['a TypeError', new TypeError('x is not a function')],
    ['a string', 'permission-denied'],
    ['null', null],
    ['undefined', undefined],
  ])('%s is reported as internal, with the safe message only', (_label, thrown) => {
    expect(reportedFor(thrown)).toEqual({ code: 'internal', message: SAFE_MESSAGE })
  })

  it('a FirebaseError-shaped Error with a valid Firestore code is accepted, but its message is still replaced', () => {
    expect(reportedFor(lookalike('unavailable', 'raw text'))).toEqual({
      code: 'unavailable',
      message: SAFE_MESSAGE,
    })
  })

  it('reports nothing when the listener starts, and the stop function still works after an error', () => {
    const onError = vi.fn()
    const stop = vi.fn()
    safeListen(() => stop, onError)()
    expect(onError).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)

    const failed = safeListen(() => {
      throw new SdkFirestoreError('permission-denied', 'x')
    }, vi.fn())
    expect(() => failed()).not.toThrow()
  })

  it('an unsubscribe that throws is contained', () => {
    const unsubscribe = safeListen(
      () => () => {
        throw new Error('failed queue')
      },
      vi.fn()
    )
    expect(() => unsubscribe()).not.toThrow()
  })
})

describe('toListenerError', () => {
  it('keeps a recognised Firestore code and replaces the message with the caller’s text', () => {
    const delivered = Object.assign(new Error('RAW SDK TEXT'), {
      name: 'FirebaseError',
      code: 'failed-precondition',
    })
    expect(toListenerError(delivered, 'History unavailable.')).toEqual({
      code: 'failed-precondition',
      message: 'History unavailable.',
    })
  })

  it('reports anything unrecognised as internal, with the caller’s text', () => {
    expect(toListenerError({ code: 'permission-denied' }, 'Failed.')).toEqual({
      code: 'internal',
      message: 'Failed.',
    })
    expect(toListenerError(lookalike('auth/user-disabled'), 'Failed.')).toEqual({
      code: 'internal',
      message: 'Failed.',
    })
  })
})
