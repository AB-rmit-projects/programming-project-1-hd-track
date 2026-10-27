import type { ActionLog, ActionType, Incident } from '@/types/firestore'

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
  /** Simulated report time. Always null for a legacy (version 1) record, which has none. */
  reportedAt: Date | null
  lastSignalAt: Date | null
  /**
   * A version 1 record from before the Phase 6 timeline: it has no report time,
   * and its last-signal time was an offset from the seed time.
   */
  legacyTimeline: boolean
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

// ── Screen B: incident detail and decision history ───────────────────────────

/**
 * Everything the detail page shows about one incident: the queue row plus the
 * evidence fields. Same rules as IncidentRow — a missing or unexpected value
 * is null and its field name is listed in `dataIssues`. Nothing is filled in.
 */
export interface IncidentDetail extends IncidentRow {
  state: Incident['state'] | null
  likelyCause: string | null
  evidenceSummary: string | null
  recommendedAction: string | null
  createdAt: Date | null
}

/**
 * Result of parsing an incident for the detail page. As for the queue, a record
 * not marked `isSimulated: true` is rejected outright; so is a record that does
 * not belong to the operator who asked for it.
 */
export type ParsedIncidentDetail =
  | { ok: true; detail: IncidentDetail }
  | { ok: false; id: string; reason: 'NOT_SIMULATED' | 'OWNER_MISMATCH' }

/** One saved decision, display-safe. Unexpected values are null and listed in `dataIssues`. */
export interface ActionHistoryEntry {
  /** Firestore document ID — always present. */
  id: string
  incidentId: string
  actionType: ActionType | null
  note: string | null
  createdAt: Date | null
  dataIssues: Array<keyof ActionLog>
}

/**
 * Result of parsing one action log. A log that does not demonstrably belong to
 * the expected operator and incident is rejected, so it can never be shown in
 * (or count towards) the wrong incident's history.
 */
export type ParsedActionLog =
  | { ok: true; entry: ActionHistoryEntry }
  | { ok: false; id: string; reason: 'OWNER_MISMATCH' | 'INCIDENT_MISMATCH' }

/** An incident's decisions, newest first, plus how many logs were rejected. */
export interface ActionHistory {
  entries: ActionHistoryEntry[]
  rejectedCount: number
}
