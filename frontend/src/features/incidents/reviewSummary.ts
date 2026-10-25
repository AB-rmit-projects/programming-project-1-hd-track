import type { ActionLog } from '@/types/firestore'
import type {
  IncidentRow,
  QueueTab,
  ReviewStatus,
  ReviewSummary,
  ReviewedIncidentRow,
} from './types'

/** The only action-log fields the review status depends on. */
export type ReviewEvidence = Pick<ActionLog, 'incidentId' | 'actionType'>

/** The parts of a query-snapshot document used here (a QueryDocumentSnapshot<ActionLog> satisfies it). */
export interface ActionLogSnapshotDoc {
  metadata: { hasPendingWrites: boolean }
  data(): ReviewEvidence & { createdAt?: unknown }
}

/**
 * The review evidence in one action-log snapshot, keeping only documents the
 * server has accepted.
 *
 * Firestore shows a locally created document in query results straight away,
 * before the server has accepted (or rejected) the write, and marks it
 * `metadata.hasPendingWrites`. That flag is checked per document, not on the
 * whole query snapshot, so a pending log never hides confirmed ones in the
 * same snapshot. Once the server accepts the write, a listener with
 * `includeMetadataChanges` receives the same document again with the flag
 * cleared, and it counts from then on. A rejected write is removed from the
 * results by the SDK, so it never counts.
 *
 * A log with no `createdAt` field is also left out. The detail page's history
 * query orders by createdAt, and Firestore leaves out any document missing
 * that field, so such a log could never appear in the incident's history;
 * counting it here would make the two screens disagree. Any present value
 * (even null or a malformed one) is kept: Firestore includes those in the
 * ordered query, and the detail page lists them. Only privileged writes can
 * create such a log — the rules require createdAt == request.time.
 */
export function confirmedReviewEvidence(docs: readonly ActionLogSnapshotDoc[]): ReviewEvidence[] {
  return docs.flatMap((doc) => {
    if (doc.metadata.hasPendingWrites) return []
    const data = doc.data()
    if (!Object.hasOwn(data, 'createdAt')) return []
    const { incidentId, actionType } = data
    return [{ incidentId, actionType }]
  })
}

/**
 * Counts and review status for the dashboard (AC-10).
 *
 * An incident is reviewed when at least one REVIEWED log refers to it.
 * ACKNOWLEDGE and ESCALATE never count; several REVIEWED logs for one incident
 * count once (a Set of incident IDs); logs for incidents that are not in
 * `rows` are ignored, so `reviewed` can never exceed `total`.
 *
 * The REVIEWED check is repeated here even though the Firestore query already
 * filters on it, so the counts stay correct if the query ever changes.
 * Inputs are not modified.
 */
export function deriveReviewSummary(
  rows: readonly IncidentRow[],
  actionLogs: readonly ReviewEvidence[]
): ReviewSummary {
  const incidentIds = new Set(rows.map((row) => row.id))
  const reviewedIds = new Set(
    actionLogs
      .filter((log) => log.actionType === 'REVIEWED' && incidentIds.has(log.incidentId))
      .map((log) => log.incidentId)
  )

  const withStatus = rows.map((row): ReviewedIncidentRow => ({
    ...row,
    reviewStatus: reviewedIds.has(row.id) ? 'REVIEWED' : 'AWAITING_REVIEW',
  }))

  return {
    rows: withStatus.sort(compareQueueOrder), // sorts the new array, never the caller's
    total: rows.length,
    awaiting: rows.length - reviewedIds.size,
    reviewed: reviewedIds.size,
  }
}

const REVIEW_STATUS_ORDER: Record<ReviewStatus, number> = { AWAITING_REVIEW: 0, REVIEWED: 1 }

/** Oldest signal first; a missing signal time sorts after every known one. */
function compareSignal(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime()
  if (a) return -1
  if (b) return 1
  return 0
}

/** Plain code-unit order (deterministic, locale-independent); null sorts last. */
function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/**
 * Queue order: awaiting review before reviewed; then the incident silent the
 * longest (oldest lastSignalAt) first; then incident code; then document ID,
 * which is unique, so the order is fully deterministic.
 */
export function compareQueueOrder(a: ReviewedIncidentRow, b: ReviewedIncidentRow): number {
  return (
    REVIEW_STATUS_ORDER[a.reviewStatus] - REVIEW_STATUS_ORDER[b.reviewStatus] ||
    compareSignal(a.lastSignalAt, b.lastSignalAt) ||
    compareText(a.incidentCode, b.incidentCode) ||
    compareText(a.id, b.id)
  )
}

/** Rows shown under a queue tab, keeping their order. Always returns a new array. */
export function filterByTab(
  rows: readonly ReviewedIncidentRow[],
  tab: QueueTab
): ReviewedIncidentRow[] {
  return tab === 'ALL' ? [...rows] : rows.filter((row) => row.reviewStatus === tab)
}
