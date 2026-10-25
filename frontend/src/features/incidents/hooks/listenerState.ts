import type { Unsubscribe } from 'firebase/firestore'
import { toSafeFirestoreError, type SafeFirestoreError } from '@/features/incidents/firestoreErrors'

// Listener safeguards shared by the incident hooks, moved from
// useIncidentDashboard.ts so another hook can apply exactly the same rules.

/** What a hook needs from a Firestore error (a FirestoreError satisfies it). */
export type ListenerError = SafeFirestoreError

/** One listener's progress, as the hook state stores it. */
export type ListenerState<T> =
  | { phase: 'pending' }
  // confirmed: at least one snapshot from the server has arrived (not only the cache)
  | { phase: 'snapshot'; docs: T[]; fromCache: boolean; confirmed: boolean }
  | { phase: 'error'; error: ListenerError }

/**
 * The state after a new snapshot. Once a listener has been confirmed by the
 * server it stays confirmed: a later cached snapshot means stale, not unconfirmed.
 */
export function withSnapshot<T>(
  previous: ListenerState<T>,
  docs: T[],
  fromCache: boolean
): ListenerState<T> {
  const confirmedBefore = previous.phase === 'snapshot' && previous.confirmed
  return { phase: 'snapshot', docs, fromCache, confirmed: confirmedBefore || !fromCache }
}

const START_FAILED_MESSAGE = 'The Firestore client could not start a listener.'

/**
 * A safe description of any thrown or delivered listener error: a recognised
 * Firestore error code is kept, anything else becomes 'internal', and the
 * message is always the caller's own text (see firestoreErrors.ts).
 */
export function toListenerError(error: unknown, message: string): ListenerError {
  return toSafeFirestoreError(error, message)
}

/**
 * onSnapshot, and the unsubscribe function it returns, throw synchronously once
 * the SDK's internal queue has failed (after an "INTERNAL ASSERTION FAILED",
 * every later call fails with the same error). Report that through the
 * listener's error path instead of letting it escape the effect and crash the
 * page. A recognised Firestore error code is kept; anything else is reported
 * as 'internal'. The raw SDK message is never passed on.
 */
export function safeListen(start: () => Unsubscribe, onError: (error: ListenerError) => void) {
  let stop: Unsubscribe
  try {
    stop = start()
  } catch (error) {
    onError(toListenerError(error, START_FAILED_MESSAGE))
    return () => {}
  }
  return () => {
    try {
      stop()
    } catch {
      // A failed client has already dropped its listeners; nothing left to stop.
    }
  }
}
