import {
  collection,
  doc,
  orderBy,
  where,
  type CollectionReference,
  type DocumentData,
  type QueryConstraint,
} from 'firebase/firestore'
import { getClientDb } from './client'
import type { ActionLog, Incident, UserProfile } from '@/types/firestore'

/**
 * Creates a typed Firestore collection reference.
 * Use this factory to add new collections — see docs/FIRESTORE-SCHEMA.md
 */
function typedCollection<T extends DocumentData>(path: string): CollectionReference<T> {
  return collection(getClientDb(), path) as CollectionReference<T>
}

// ── Collections ──────────────────────────────────────────────────────────────
// Add one export per Firestore collection. Keep in sync with:
//   - src/types/firestore.ts
//   - firebase/firestore.rules
//   - docs/FIRESTORE-SCHEMA.md

export const INCIDENTS_COLLECTION = 'incidents'
export const ACTION_LOGS_COLLECTION = 'actionLogs'

export function getUsersCollection() {
  return typedCollection<UserProfile>('users')
}

export function userDoc(uid: string) {
  return doc(getUsersCollection(), uid)
}

export function getIncidentsCollection() {
  return typedCollection<Incident>(INCIDENTS_COLLECTION)
}

export function incidentDoc(incidentId: string) {
  return doc(getIncidentsCollection(), incidentId)
}

export function getActionLogsCollection() {
  return typedCollection<ActionLog>(ACTION_LOGS_COLLECTION)
}

// ── Query constraints ────────────────────────────────────────────────────────
// Security rules are not filters: a list query is rejected unless its own
// constraints guarantee every result belongs to the caller. Every list query
// on incidents/actionLogs must therefore start with an ownerUid filter.
// Use with query(collectionRef, ...constraints).

/** The signed-in operator's incidents (Screen A queue). */
export function ownIncidentsConstraints(uid: string): QueryConstraint[] {
  return [where('ownerUid', '==', uid)]
}

/**
 * One incident's action history, newest first (Screen B).
 * Needs the composite index actionLogs(ownerUid ASC, incidentId ASC, createdAt DESC)
 * in firebase/firestore.indexes.json.
 */
export function actionHistoryConstraints(uid: string, incidentId: string): QueryConstraint[] {
  return [
    where('ownerUid', '==', uid),
    where('incidentId', '==', incidentId),
    orderBy('createdAt', 'desc'),
  ]
}

/** The operator's REVIEWED decisions, used to derive review counts (equality filters only — no composite index). */
export function reviewedActionsConstraints(uid: string): QueryConstraint[] {
  return [where('ownerUid', '==', uid), where('actionType', '==', 'REVIEWED')]
}
