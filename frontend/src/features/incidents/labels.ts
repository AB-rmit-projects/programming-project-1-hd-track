import type { ActionType, CauseCategory, Incident } from '@/types/firestore'
import type { QueueTab, ReviewStatus } from './types'

// Typed as complete Records, so adding a code to a union without a label
// fails `pnpm run typecheck`. These maps are also the lists of valid codes
// that incidentRow.ts checks against.

/** Readable cause categories, in the spec's wording. A category is an evidence association, not a confirmed cause. */
export const CAUSE_CATEGORY_LABELS: Record<CauseCategory, string> = {
  UNPLANNED_OUTAGE: 'Unplanned network outage',
  DEVICE_SIDE: 'Device-side issue',
  PLANNED_MAINTENANCE: 'Planned network maintenance',
  EXTERNAL_HAZARD: 'External hazard association',
  INSUFFICIENT_EVIDENCE: 'Insufficient / conflicting evidence',
}

/**
 * The pendant's (simulated) connectivity. Always worded as the pendant's state,
 * so it is never confused with the operator's own network connection.
 */
export const INCIDENT_STATUS_LABELS: Record<Incident['status'], string> = {
  OFFLINE: 'Pendant offline',
  SILENT: 'Pendant silent',
}

/** What each pendant state means — the queue's connectivity legend. */
export const INCIDENT_STATUS_DESCRIPTIONS: Record<Incident['status'], string> = {
  OFFLINE: 'No heartbeat received from the pendant since its last signal.',
  SILENT: 'Heartbeat still received, but an expected check-in or self-test was missed.',
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  AWAITING_REVIEW: 'Awaiting review',
  REVIEWED: 'Reviewed',
}

export const QUEUE_TAB_LABELS: Record<QueueTab, string> = {
  ALL: 'All',
  AWAITING_REVIEW: 'Awaiting review',
  REVIEWED: 'Reviewed',
}

/** How a saved decision is named in the history. */
export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  ACKNOWLEDGE: 'Acknowledged',
  ESCALATE: 'Escalation recorded',
  REVIEWED: 'Reviewed',
}

/** What each decision means, shown beside the choice. Only REVIEWED changes the review status. */
export const ACTION_TYPE_DESCRIPTIONS: Record<ActionType, string> = {
  ACKNOWLEDGE: 'Records that you have seen this incident. It stays awaiting review.',
  ESCALATE:
    'Records that you would escalate this incident. Nothing else happens: no alert, notification or welfare check is sent, and it stays awaiting review.',
  REVIEWED: 'Marks this incident as reviewed. It then counts towards the Reviewed total.',
}

/**
 * Shown in place of a value that was missing or unexpected (an IncidentRow,
 * IncidentDetail or ActionHistoryEntry field is null).
 */
export const FALLBACK_LABELS = {
  text: '—',
  status: 'Unknown',
  causeCategory: 'Unrecognised category',
  lastSignalAt: 'Not recorded',
  reportedAt: 'Not recorded',
  actionType: 'Unrecognised decision',
  note: 'Rationale not available',
  createdAt: 'Time not recorded',
} as const

/**
 * Information the incident schema does not contain at all (not a missing
 * value): shown as unavailable, never estimated.
 */
export const NOT_IN_DATASET_LABELS = {
  confidence: 'Not available — the simulated incident data has no confidence score',
  /** A version 1 record predates the report time; it is shown as absent, never estimated. */
  legacyReportedAt: 'Not recorded in this earlier-format record',
} as const
