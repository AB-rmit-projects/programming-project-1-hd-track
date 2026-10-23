'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FirestoreError, onSnapshot, query, type Unsubscribe } from 'firebase/firestore'
import {
  getActionLogsCollection,
  getIncidentsCollection,
  ownIncidentsConstraints,
  reviewedActionsConstraints,
} from '@/lib/firebase/firestore'
import { parseIncident } from '@/features/incidents/incidentRow'
import { deriveReviewSummary, type ReviewEvidence } from '@/features/incidents/reviewSummary'
import type { ParsedIncident, ReviewSummary } from '@/features/incidents/types'

/** How long to wait for both queries to be confirmed by the server before reporting offline. */
export const SERVER_CONFIRMATION_TIMEOUT_MS = 15_000

export type DashboardStatus =
  | 'idle' // no signed-in user: nothing is subscribed
  | 'loading' // waiting for server-confirmed snapshots of both queries
  | 'ready' // both queries confirmed and current
  | 'offline' // the timeout passed without confirmation of both queries
  | 'stale' // both were confirmed, but a current snapshot is from the local cache
  | 'error' // a listener failed (Firestore ends it; retry() re-subscribes)
  | 'integrity-error' // an incident is not marked isSimulated: true

/** What the dashboard needs from a Firestore error (a FirestoreError satisfies it). */
export type DashboardError = Pick<FirestoreError, 'code' | 'message'>

export interface IncidentDashboardState {
  status: DashboardStatus
  /** The UID this result belongs to (null when idle). */
  ownerUid: string | null
  /** Rows and counts — only when status is 'ready' or 'stale', otherwise null. */
  summary: ReviewSummary | null
  /** Rows that had missing or unexpected fields (shown with fallbacks). */
  dataIssueCount: number
  /** Incidents rejected because they are not marked as simulated. */
  integrityErrorCount: number
  error: DashboardError | null
  retry: () => void
}

type ListenerState<T> =
  | { phase: 'pending' }
  // confirmed: at least one snapshot from the server has arrived (not only the cache)
  | { phase: 'snapshot'; docs: T[]; fromCache: boolean; confirmed: boolean }
  | { phase: 'error'; error: DashboardError }

/** Everything loaded by one subscription, tagged with the UID and generation that produced it. */
interface SubscriptionData {
  uid: string
  generation: number
  incidents: ListenerState<ParsedIncident>
  reviewed: ListenerState<ReviewEvidence>
  timedOut: boolean
}

function emptySubscription(uid: string, generation: number): SubscriptionData {
  return {
    uid,
    generation,
    incidents: { phase: 'pending' },
    reviewed: { phase: 'pending' },
    timedOut: false,
  }
}

function withSnapshot<T>(
  previous: ListenerState<T>,
  docs: T[],
  fromCache: boolean
): ListenerState<T> {
  const confirmedBefore = previous.phase === 'snapshot' && previous.confirmed
  return { phase: 'snapshot', docs, fromCache, confirmed: confirmedBefore || !fromCache }
}

/**
 * onSnapshot, and the unsubscribe function it returns, throw synchronously once
 * the SDK's internal queue has failed (after an "INTERNAL ASSERTION FAILED",
 * every later call fails with the same error). Report that through the
 * listener's error path instead of letting it escape the effect and crash the
 * page. The raw SDK message is not passed on.
 */
function safeListen(start: () => Unsubscribe, onError: (error: DashboardError) => void) {
  let stop: Unsubscribe
  try {
    stop = start()
  } catch (error) {
    onError(
      error instanceof FirestoreError
        ? error
        : { code: 'internal', message: 'The Firestore client could not start a listener.' }
    )
    return () => {}
  }
  return () => {
    try {
      stop()
    } catch {
      // A failed client has already dropped its listeners; nothing left to stop.
    }
  }
}

const NO_RESULT = { summary: null, dataIssueCount: 0, integrityErrorCount: 0, error: null }

/** Turns the raw listener states into what the dashboard may show. */
function toDashboardState(
  data: SubscriptionData
): Omit<IncidentDashboardState, 'ownerUid' | 'retry'> {
  const { incidents, reviewed } = data

  // A failed query means the counts are unknown — show none rather than wrong ones.
  if (incidents.phase === 'error') return { ...NO_RESULT, status: 'error', error: incidents.error }
  if (reviewed.phase === 'error') return { ...NO_RESULT, status: 'error', error: reviewed.error }

  // One non-simulated record withholds the whole dashboard (never filtered out silently).
  if (incidents.phase === 'snapshot') {
    const rejected = incidents.docs.filter((parsed) => !parsed.ok).length
    if (rejected > 0)
      return { ...NO_RESULT, status: 'integrity-error', integrityErrorCount: rejected }
  }

  if (
    incidents.phase === 'snapshot' &&
    reviewed.phase === 'snapshot' &&
    incidents.confirmed &&
    reviewed.confirmed
  ) {
    const rows = incidents.docs.flatMap((parsed) => (parsed.ok ? [parsed.row] : []))
    return {
      ...NO_RESULT,
      status: incidents.fromCache || reviewed.fromCache ? 'stale' : 'ready',
      summary: deriveReviewSummary(rows, reviewed.docs),
      dataIssueCount: rows.filter((row) => row.dataIssues.length > 0).length,
    }
  }

  return { ...NO_RESULT, status: data.timedOut ? 'offline' : 'loading' }
}

/**
 * Live incident queue and review counts for one operator (Screen A).
 *
 * Runs exactly two owner-scoped listeners under the security rules: the
 * operator's incidents, and their REVIEWED action logs. Counts are shown only
 * once the server has confirmed both; an empty cached result is never treated
 * as "no incidents". New REVIEWED logs arrive through the live listener, so the
 * counts update without a reload.
 *
 * Owner isolation: loaded data carries the UID and generation of the
 * subscription that produced it. Data for any other UID or generation is never
 * returned — the check runs during render, so a UID change shows "loading" in
 * the very same render — and callbacks from a cleaned-up subscription are
 * dropped.
 */
export function useIncidentDashboard(uid: string | null): IncidentDashboardState {
  const [data, setData] = useState<SubscriptionData | null>(null)
  // Bumped by retry(); doubles as the subscription generation for the current UID.
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!uid) return

    let active = true

    /** Applies a change only to this subscription's own data. */
    const update = (change: (current: SubscriptionData) => SubscriptionData) => {
      if (!active) return
      setData((previous) =>
        change(
          previous?.uid === uid && previous.generation === generation
            ? previous
            : emptySubscription(uid, generation)
        )
      )
    }

    const options = { includeMetadataChanges: true }

    // The offline timeout only matters until both queries are server-confirmed;
    // after that it is cancelled (a later cached snapshot means stale, not offline).
    const timer = setTimeout(
      () => update((current) => ({ ...current, timedOut: true })),
      SERVER_CONFIRMATION_TIMEOUT_MS
    )
    const serverConfirmed = { incidents: false, reviewed: false }
    const noteSnapshot = (which: keyof typeof serverConfirmed, fromCache: boolean) => {
      if (fromCache) return
      serverConfirmed[which] = true
      if (serverConfirmed.incidents && serverConfirmed.reviewed) clearTimeout(timer)
    }

    const incidentsFailed = (error: DashboardError) =>
      update((current) => ({ ...current, incidents: { phase: 'error', error } }))
    const reviewedFailed = (error: DashboardError) =>
      update((current) => ({ ...current, reviewed: { phase: 'error', error } }))

    const stopIncidents = safeListen(
      () =>
        onSnapshot(
          query(getIncidentsCollection(), ...ownIncidentsConstraints(uid)),
          options,
          (snapshot) => {
            const docs = snapshot.docs.map((doc) => parseIncident(doc.id, doc.data()))
            noteSnapshot('incidents', snapshot.metadata.fromCache)
            update((current) => ({
              ...current,
              incidents: withSnapshot(current.incidents, docs, snapshot.metadata.fromCache),
            }))
          },
          incidentsFailed
        ),
      incidentsFailed
    )

    const stopReviewed = safeListen(
      () =>
        onSnapshot(
          query(getActionLogsCollection(), ...reviewedActionsConstraints(uid)),
          options,
          (snapshot) => {
            const docs = snapshot.docs.map((doc) => {
              const { incidentId, actionType } = doc.data()
              return { incidentId, actionType }
            })
            noteSnapshot('reviewed', snapshot.metadata.fromCache)
            update((current) => ({
              ...current,
              reviewed: withSnapshot(current.reviewed, docs, snapshot.metadata.fromCache),
            }))
          },
          reviewedFailed
        ),
      reviewedFailed
    )

    return () => {
      active = false
      stopIncidents()
      stopReviewed()
      clearTimeout(timer)
      setData(null) // never let a later subscription start from this one's data
    }
  }, [uid, generation])

  const retry = useCallback(() => setGeneration((value) => value + 1), [])

  // Only data produced by the current UID's current subscription may be used.
  const current = uid && data?.uid === uid && data.generation === generation ? data : null
  const state = useMemo(() => (current ? toDashboardState(current) : null), [current])

  if (!uid) return { ...NO_RESULT, status: 'idle', ownerUid: null, retry }
  return { ...(state ?? { ...NO_RESULT, status: 'loading' }), ownerUid: uid, retry }
}
