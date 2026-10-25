import { serverTimestamp, type FieldValue } from 'firebase/firestore'
import { actionLogInputSchema, incidentIdSchema } from '@/lib/validations/actionLog'
import type { ActionLog } from '@/types/firestore'

/**
 * The document a new decision is written as: exactly the six fields the
 * actionLogs create rule allows, with createdAt left to the server.
 */
export type NewActionLogData = Omit<ActionLog, 'createdAt'> & { createdAt: FieldValue }

/** `input` is used when the decision is not an object at all. */
export type DecisionField = 'ownerUid' | 'incidentId' | 'actionType' | 'note' | 'input'

export interface DecisionIssue {
  field: DecisionField
  message: string
}

export type DecisionPayloadResult =
  { ok: true; data: NewActionLogData } | { ok: false; issues: DecisionIssue[] }

/**
 * Validates a decision and builds the action-log document for it. Pure: it
 * only creates the serverTimestamp() sentinel (a placeholder the server
 * replaces with its own time on write); it never reads or writes Firestore.
 * Writing the document is a separate step.
 *
 * The note is trimmed and length-checked by actionLogInputSchema, the same
 * schema the form uses. These checks give early, readable feedback only — the
 * Firestore security rules check every field again and decide.
 */
export function buildActionLogData(
  ownerUid: string,
  incidentId: string,
  input: unknown
): DecisionPayloadResult {
  const issues: DecisionIssue[] = []

  if (ownerUid.trim() === '')
    issues.push({ field: 'ownerUid', message: 'You need to be signed in.' })

  const id = incidentIdSchema.safeParse(incidentId)
  if (!id.success) issues.push({ field: 'incidentId', message: 'Invalid incident ID.' })

  const decision = actionLogInputSchema.safeParse(input)
  if (!decision.success) {
    for (const issue of decision.error.issues) {
      const field = issue.path[0]
      issues.push({
        field: field === 'actionType' || field === 'note' ? field : 'input',
        message: issue.message,
      })
    }
  }

  if (!decision.success || issues.length > 0) return { ok: false, issues }

  // Listed field by field: nothing from `input` beyond the two parsed values is carried over.
  return {
    ok: true,
    data: {
      ownerUid,
      incidentId,
      actionType: decision.data.actionType,
      note: decision.data.note,
      createdAt: serverTimestamp(),
      _schemaVersion: 1,
    },
  }
}
