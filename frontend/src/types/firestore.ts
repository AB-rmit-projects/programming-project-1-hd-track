import type { Timestamp } from 'firebase/firestore'

/**
 * Firestore collection type definitions.
 *
 * Keep in sync with:
 *   - src/lib/firebase/firestore.ts  (typed collection exports)
 *   - firebase/firestore.rules       (security rules)
 *   - docs/FIRESTORE-SCHEMA.md       (schema documentation)
 *
 * When adding a new collection, use the /firebase-collection skill.
 */

export interface UserProfile {
  uid: string
  email: string
  displayName: string | null
  photoURL: string | null
  role: 'user'
  createdAt: Timestamp
  updatedAt: Timestamp
  _schemaVersion: 1
}

export type CreateUserProfileInput = Omit<UserProfile, 'createdAt' | 'updatedAt'>

// ── SafeCall Incident Evidence & Action Log ──────────────────────────────────

/** Simulated scenario label for an incident — an evidence association, not a confirmed root cause. */
export type CauseCategory =
  | 'UNPLANNED_OUTAGE'
  | 'DEVICE_SIDE'
  | 'PLANNED_MAINTENANCE'
  | 'EXTERNAL_HAZARD'
  | 'INSUFFICIENT_EVIDENCE'

/** The three decisions an operator may record. */
export type ActionType = 'ACKNOWLEDGE' | 'ESCALATE' | 'REVIEWED'

/**
 * incidents/{incidentId} — fictional, pre-seeded by an administrator (Admin SDK).
 * Operators can only read their own incidents; clients can never write them.
 *
 * Schema version 2 (Phase 6). The three times mean different things:
 *   - `reportedAt`   — simulated: when the fictional monitoring platform raised the incident.
 *   - `lastSignalAt` — simulated: the last pendant heartbeat received before `reportedAt`.
 *   - `createdAt`    — real: when this Firestore document was written (dataset metadata).
 */
export interface Incident {
  ownerUid: string
  incidentCode: string
  deviceId: string
  status: 'OFFLINE' | 'SILENT'
  suburb: string
  state: 'VIC'
  postcode: string
  reportedAt: Timestamp
  lastSignalAt: Timestamp
  causeCategory: CauseCategory
  likelyCause: string
  recommendedAction: string
  evidenceSummary: string
  isSimulated: true
  createdAt: Timestamp
  _schemaVersion: 2
}

/**
 * A version 1 incident (Phases 3–5): no `reportedAt`, and `lastSignalAt` was
 * an offset from the seed time. Still readable until the timeline migration
 * converts the live documents to version 2.
 */
export type IncidentV1 = Omit<Incident, 'reportedAt' | '_schemaVersion'> & { _schemaVersion: 1 }

/**
 * actionLogs/{actionLogId} — an operator's decision on one of their incidents.
 * Append-only for clients: rules allow create and read, never update or delete.
 */
export interface ActionLog {
  ownerUid: string
  incidentId: string
  actionType: ActionType
  note: string
  createdAt: Timestamp
  _schemaVersion: 1
}
