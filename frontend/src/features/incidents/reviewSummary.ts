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
