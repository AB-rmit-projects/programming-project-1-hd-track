import type { CauseCategory, Incident } from '@/types/firestore'
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

export const INCIDENT_STATUS_LABELS: Record<Incident['status'], string> = {
  OFFLINE: 'Offline',
  SILENT: 'Silent',
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

/** Shown in place of a value that was missing or unexpected (IncidentRow field is null). */
export const FALLBACK_LABELS = {
  text: '—',
  status: 'Unknown',
  causeCategory: 'Unrecognised category',
  lastSignalAt: 'Not recorded',
} as const
