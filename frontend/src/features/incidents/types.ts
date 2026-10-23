import type { Incident } from '@/types/firestore'

/** Derived from action logs: REVIEWED once at least one REVIEWED log exists. */
export type ReviewStatus = 'AWAITING_REVIEW' | 'REVIEWED'

/** The dashboard queue tabs. */
export type QueueTab = 'ALL' | ReviewStatus

/**
 * A display-safe incident. Every field has been type-checked; a value that was
 * missing or unexpected is null and its field name is listed in `dataIssues`.
 */
export interface IncidentRow {
  /** Firestore document ID — always present, used for the detail link. */
  id: string
  incidentCode: string | null
  deviceId: string | null
  suburb: string | null
  postcode: string | null
  status: Incident['status'] | null
  causeCategory: Incident['causeCategory'] | null
  lastSignalAt: Date | null
  dataIssues: Array<keyof Incident>
}

/**
 * Result of parsing one incident document. A record not explicitly marked
 * `isSimulated: true` is rejected outright: it is never shown as a fictional
 * incident, and none of its fields are carried over.
 */
export type ParsedIncident =
  { ok: true; row: IncidentRow } | { ok: false; id: string; reason: 'NOT_SIMULATED' }

export type ReviewedIncidentRow = IncidentRow & { reviewStatus: ReviewStatus }

export interface ReviewSummary {
  /** Every incident with its review status, in queue order. */
  rows: ReviewedIncidentRow[]
  total: number
  awaiting: number
  reviewed: number
}
