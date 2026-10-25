import { FirestoreError, type FirestoreErrorCode } from 'firebase/firestore'

/** A Firestore error as the incident features may keep it: a recognised code and our own message. */
export type SafeFirestoreError = Pick<FirestoreError, 'code' | 'message'>

/**
 * Every code a FirestoreError can carry. Typed as a complete Record, so a
 * change to the SDK's FirestoreErrorCode list fails `pnpm run typecheck`.
 */
const FIRESTORE_ERROR_CODES: Record<FirestoreErrorCode, true> = {
  cancelled: true,
  unknown: true,
  'invalid-argument': true,
  'deadline-exceeded': true,
  'not-found': true,
  'already-exists': true,
  'permission-denied': true,
  'resource-exhausted': true,
  'failed-precondition': true,
  aborted: true,
  'out-of-range': true,
  unimplemented: true,
  internal: true,
  unavailable: true,
  'data-loss': true,
  unauthenticated: true,
}

// Object.hasOwn, not `in`: inherited keys such as 'toString' are not codes.
function isFirestoreErrorCode(value: unknown): value is FirestoreErrorCode {
  return typeof value === 'string' && Object.hasOwn(FIRESTORE_ERROR_CODES, value)
}

/**
 * Whether a thrown or rejected value is a Firestore error. `instanceof
 * FirestoreError` alone cannot tell: in the installed SDK the FirebaseError
 * base constructor resets the prototype to FirebaseError.prototype, so it is
 * false even for errors Firestore itself throws. A Firestore error is an Error
 * named 'FirebaseError' whose code is one of Firestore's own codes (other
 * Firebase services use prefixed codes such as 'auth/…', which are not accepted).
 */
export function isFirestoreError(error: unknown): error is Error & { code: FirestoreErrorCode } {
  const shaped =
    error instanceof FirestoreError || (error instanceof Error && error.name === 'FirebaseError')
  return shaped && isFirestoreErrorCode((error as { code?: unknown }).code)
}

/**
 * A safe description of any error: a recognised Firestore error code is kept,
 * anything else becomes 'internal', and the message is always the caller's
 * own text — the raw SDK message is never passed on.
 */
export function toSafeFirestoreError(error: unknown, message: string): SafeFirestoreError {
  return { code: isFirestoreError(error) ? error.code : 'internal', message }
}
