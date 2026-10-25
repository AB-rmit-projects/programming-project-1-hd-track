import { NOTE_MAX_LENGTH, NOTE_MIN_LENGTH, ACTION_TYPES } from '@/lib/validations/actionLog'
import type { ActionType } from '@/types/firestore'
import { isRecord, toStoredDate } from './incidentRow'
import type { ActionHistory, ActionHistoryEntry, ParsedActionLog, ReviewStatus } from './types'

/** Who and what the caller expects the logs to belong to. Omitted fields are not checked. */
export interface ActionLogContext {
  ownerUid?: string
  incidentId?: string
}

function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTION_TYPES as readonly string[]).includes(value)
}

/** A note as the create rule stores it: a string of 10–500 characters (UTF-16 code units). */
function isStoredNote(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length >= NOTE_MIN_LENGTH && value.length <= NOTE_MAX_LENGTH
  )
}

/**
 * Turns one action-log document into a display-safe history entry.
 *
 * - `ownerUid` and `incidentId` must be strings, and must equal the expected
 *   values when the caller gives them; otherwise the log is rejected, so it is
 *   never shown under, or counted for, the wrong incident.
 * - An unrecognised `actionType`, a note the create rule would not have
 *   accepted, or a missing `createdAt` becomes null and is listed in
 *   `dataIssues`. A null action type never counts as REVIEWED.
 */
export function parseActionLog(
  id: string,
  data: unknown,
  expected: ActionLogContext = {}
): ParsedActionLog {
  const record = isRecord(data) ? data : {}

  const { ownerUid, incidentId } = record
  if (
    typeof ownerUid !== 'string' ||
    (expected.ownerUid !== undefined && ownerUid !== expected.ownerUid)
  ) {
    return { ok: false, id, reason: 'OWNER_MISMATCH' }
  }
  if (
    typeof incidentId !== 'string' ||
    (expected.incidentId !== undefined && incidentId !== expected.incidentId)
  ) {
    return { ok: false, id, reason: 'INCIDENT_MISMATCH' }
  }

  const dataIssues: ActionHistoryEntry['dataIssues'] = []

  const actionType = isActionType(record.actionType) ? record.actionType : null
  if (actionType === null) dataIssues.push('actionType')

  const note = isStoredNote(record.note) ? record.note : null
  if (note === null) dataIssues.push('note')

  const createdAt = toStoredDate(record.createdAt)
  if (createdAt === null) dataIssues.push('createdAt')

  if (record._schemaVersion !== 1) dataIssues.push('_schemaVersion')

  return { ok: true, entry: { id, incidentId, actionType, note, createdAt, dataIssues } }
}

/**
 * Newest first; an entry without a time sorts after every timed one; ties are
 * broken by document ID so the order is fully deterministic. The history
 * query already orders by createdAt, but the page does not rely on it.
 * Returns a new array.
 */
export function sortNewestFirst(entries: readonly ActionHistoryEntry[]): ActionHistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.createdAt && b.createdAt) {
      const byTime = b.createdAt.getTime() - a.createdAt.getTime()
      if (byTime !== 0) return byTime
    } else if (a.createdAt) {
      return -1
    } else if (b.createdAt) {
      return 1
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * One incident's decision history, ready to display: rejected logs are
 * dropped (and counted), the rest are sorted newest first.
 */
export function buildActionHistory(
  docs: ReadonlyArray<{ id: string; data: unknown }>,
  expected: ActionLogContext
): ActionHistory {
  const entries: ActionHistoryEntry[] = []
  let rejectedCount = 0
  for (const { id, data } of docs) {
    const parsed = parseActionLog(id, data, expected)
    if (parsed.ok) entries.push(parsed.entry)
    else rejectedCount++
  }
  return { entries: sortNewestFirst(entries), rejectedCount }
}

/**
 * One incident's review status, with the dashboard's meaning (AC-10): reviewed
 * once at least one REVIEWED decision for this incident exists. ACKNOWLEDGE and
 * ESCALATE never count, several REVIEWED entries still mean one reviewed
 * incident, and entries for any other incident are ignored.
 */
export function deriveIncidentReviewStatus(
  incidentId: string,
  entries: ReadonlyArray<Pick<ActionHistoryEntry, 'incidentId' | 'actionType'>>
): ReviewStatus {
  return entries.some((entry) => entry.incidentId === incidentId && entry.actionType === 'REVIEWED')
    ? 'REVIEWED'
    : 'AWAITING_REVIEW'
}
