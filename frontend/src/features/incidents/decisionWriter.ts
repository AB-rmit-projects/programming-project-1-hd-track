import { addDoc, type FirestoreErrorCode } from 'firebase/firestore'
import { getActionLogsCollection } from '@/lib/firebase/firestore'
import type { ActionType } from '@/types/firestore'
import { buildActionLogData, type DecisionIssue } from './decisions'
import { toSafeFirestoreError, type SafeFirestoreError } from './firestoreErrors'

/** How a started write ended: accepted by the server, or refused/failed. */
export type DecisionWriteOutcome =
  | { ok: true; actionLogId: string; actionType: ActionType }
  | { ok: false; error: SafeFirestoreError }

/**
 * Result of starting a decision write. When `started` is false nothing was
 * written; when true, the write has been handed to Firestore and `confirmed`
 * settles once the server answers. `confirmed` never rejects.
 */
export type DecisionWriteStart =
  | { started: false; issues: DecisionIssue[] }
  | { started: true; confirmed: Promise<DecisionWriteOutcome> }

const WRITE_FAILED_MESSAGES: Partial<Record<FirestoreErrorCode, string>> = {
  'permission-denied':
    'The decision was refused. Your session may have ended, or this incident is not available to your account.',
  unauthenticated: 'You are not signed in. Sign in again, then retry.',
  unavailable: "The incident database couldn't be reached. Check your connection, then retry.",
  'deadline-exceeded':
    "The incident database didn't answer in time. Check your connection, then retry.",
  'failed-precondition': "The decision couldn't be saved right now. Reload the page, then retry.",
  'invalid-argument': "The decision wasn't in a form the database accepts. Check it, then retry.",
}

const WRITE_FAILED_DEFAULT =
  "The decision couldn't be saved. Retry; if it keeps happening, reload the page."

/** A write failure with a recognised code and a message written for this action. */
export function toDecisionWriteError(error: unknown): SafeFirestoreError {
  const { code } = toSafeFirestoreError(error, '')
  return { code, message: WRITE_FAILED_MESSAGES[code] ?? WRITE_FAILED_DEFAULT }
}

/**
 * Records one decision as a new action-log document — the only Firestore
 * write in the incident feature.
 *
 * - The payload comes from buildActionLogData (validated, trimmed, exactly the
 *   six fields the create rule allows, `createdAt: serverTimestamp()`). Invalid
 *   input is returned as issues and nothing is written.
 * - The write goes through the client SDK, so the security rules decide; it
 *   is a create only (addDoc, automatic ID) and never touches an incident.
 * - `confirmed` resolves with ok only when addDoc's promise resolves, i.e. the
 *   server has accepted the write. Offline, it simply stays pending (the SDK
 *   keeps the write queued in memory); it is never cancelled or retried here.
 * - ESCALATE, like the other decisions, is only recorded: nothing else is called.
 */
export function startDecisionWrite(
  ownerUid: string,
  incidentId: string,
  input: unknown
): DecisionWriteStart {
  const payload = buildActionLogData(ownerUid, incidentId, input)
  if (!payload.ok) return { started: false, issues: payload.issues }

  const { data } = payload
  // The async function runs synchronously up to its first await, so addDoc has
  // been called by the time startDecisionWrite returns.
  const confirmed = (async (): Promise<DecisionWriteOutcome> => {
    try {
      const ref = await addDoc(getActionLogsCollection(), data)
      return { ok: true, actionLogId: ref.id, actionType: data.actionType }
    } catch (error) {
      return { ok: false, error: toDecisionWriteError(error) }
    }
  })()

  return { started: true, confirmed }
}
