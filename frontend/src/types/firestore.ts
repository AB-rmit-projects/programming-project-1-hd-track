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
 */
export interface Incident {
  ownerUid: string
  incidentCode: string
  deviceId: string
  status: 'OFFLINE' | 'SILENT'
  suburb: string
  state: 'VIC'
  postcode: string
  lastSignalAt: Timestamp
  causeCategory: CauseCategory
  likelyCause: string
  recommendedAction: string
  evidenceSummary: string
  isSimulated: true
  createdAt: Timestamp
  _schemaVersion: 1
}

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
