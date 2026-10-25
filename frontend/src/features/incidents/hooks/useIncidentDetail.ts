'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { onSnapshot, query } from 'firebase/firestore'
import {
  actionHistoryConstraints,
  getActionLogsCollection,
  incidentDoc,
} from '@/lib/firebase/firestore'
import { INCIDENT_ID_PATTERN } from '@/lib/validations/actionLog'
import { buildActionHistory, deriveIncidentReviewStatus } from '@/features/incidents/actionHistory'
import { parseIncidentDetail } from '@/features/incidents/incidentDetail'
import type {
  ActionHistoryEntry,
  IncidentDetail,
  ParsedIncidentDetail,
  ReviewStatus,
} from '@/features/incidents/types'
import { SERVER_CONFIRMATION_TIMEOUT_MS } from './useIncidentDashboard'
import {
  safeListen,
  toListenerError,
  withSnapshot,
  type ListenerError,
  type ListenerState,
} from './listenerState'

export type IncidentDetailStatus =
  | 'idle' // no signed-in user: nothing is subscribed
  | 'invalid-id' // the ID can't be an incident ID: nothing is subscribed
  | 'loading' // waiting for a server-confirmed snapshot of the incident
  | 'ready' // confirmed by the server and current
  | 'stale' // confirmed earlier, but the current snapshot is from the local cache
  | 'offline' // not confirmed within the timeout
  | 'unavailable' // doesn't exist, isn't this operator's, or access was refused (deliberately not told apart)
  | 'integrity-error' // the record is not marked isSimulated: true
  | 'error' // the listener failed for another reason (retry() re-subscribes)

export type HistoryStatus =
  | 'idle' // nothing is subscribed (no user, or an invalid ID)
  | 'withheld' // the incident failed closed, so its history is not shown either
  | 'loading' // waiting for a server-confirmed snapshot of the history
  | 'ready' // confirmed by the server and current (an empty list is a confirmed empty history)
  | 'stale' // confirmed earlier, but the current snapshot is from the local cache
  | 'offline' // not confirmed within the timeout
  | 'index-missing' // the query's composite index is not deployed (failed-precondition)
  | 'error' // the listener failed for another reason

export interface IncidentHistoryState {
  status: HistoryStatus
  /** Server-accepted decisions, newest first — only when status is 'ready' or 'stale'. */
  entries: ActionHistoryEntry[] | null
  /** Logs rejected because they don't belong to this operator and incident. */
  rejectedCount: number
  /** Accepted entries with a missing or unexpected field (shown with fallbacks). */
  dataIssueCount: number
  /** Decisions written on this device that the server has not yet accepted (never in `entries`). */
  pendingCount: number
  error: ListenerError | null
}

export interface IncidentDetailState {
  status: IncidentDetailStatus
  /** The UID and incident ID this result belongs to (null when idle / invalid). */
  ownerUid: string | null
  incidentId: string | null
  /** The incident — only when status is 'ready' or 'stale'. */
  incident: IncidentDetail | null
  /**
   * Whether a new decision may be started: only for a simulated incident owned
   * by this operator that the server confirms right now (status 'ready'). A
   * stale or offline incident can still be shown, but not decided on until it
   * is confirmed again. A history error does not affect this.
   */
  canRecordDecision: boolean
  history: IncidentHistoryState
  /**
   * The dashboard's meaning (AC-10), from server-accepted entries only — null
   * until the history has been confirmed, so "Awaiting review" is never shown
   * on unverified data.
   */
  reviewStatus: ReviewStatus | null
  /** Safe code and message only; never the raw SDK message. */
  error: ListenerError | null
  retry: () => void
}

/** What the history listener keeps per document: pending writes are kept apart, never parsed as history. */
interface HistoryDoc {
  id: string
  data: unknown
  pending: boolean
}

/** Everything loaded by one subscription, tagged with what produced it. */
interface SubscriptionData {
  uid: string
  incidentId: string
  generation: number
  /** [] = the document does not exist; [parsed] = it does. */
  incident: ListenerState<ParsedIncidentDetail>
  history: ListenerState<HistoryDoc>
  timedOut: boolean
}

const INCIDENT_LISTENER_FAILED = 'The incident could not be loaded.'
const HISTORY_LISTENER_FAILED = 'The decision history could not be loaded.'

function emptySubscription(uid: string, incidentId: string, generation: number): SubscriptionData {
  return {
    uid,
    incidentId,
    generation,
    incident: { phase: 'pending' },
    history: { phase: 'pending' },
    timedOut: false,
  }
}

const NO_HISTORY = {
  entries: null,
  rejectedCount: 0,
  dataIssueCount: 0,
  pendingCount: 0,
  error: null,
}
const HISTORY_IDLE: IncidentHistoryState = { ...NO_HISTORY, status: 'idle' }
const HISTORY_WITHHELD: IncidentHistoryState = { ...NO_HISTORY, status: 'withheld' }

type IncidentPart = Pick<IncidentDetailState, 'status' | 'incident' | 'error'>

function toIncidentPart(data: SubscriptionData): IncidentPart {
  const { incident } = data
  const none = { incident: null, error: null }

  if (incident.phase === 'error') {
    // Missing and other-owner incidents are both refused by the rules; say neither.
    const status = incident.error.code === 'permission-denied' ? 'unavailable' : 'error'
    return { status, incident: null, error: incident.error }
  }

  if (incident.phase === 'snapshot') {
    const parsed = incident.docs[0]
    // A non-simulated record fails closed at once, even from the cache.
    if (parsed && !parsed.ok && parsed.reason === 'NOT_SIMULATED') {
      return { ...none, status: 'integrity-error' }
    }
    if (incident.confirmed) {
      // Absent or not this operator's, according to the server: unavailable.
      if (!parsed || !parsed.ok) return { ...none, status: 'unavailable' }
      return { ...none, status: incident.fromCache ? 'stale' : 'ready', incident: parsed.detail }
    }
    // Cache only: neither a cached absence nor cached data is treated as an answer.
  }

  return { ...none, status: data.timedOut ? 'offline' : 'loading' }
}

function toHistoryPart(data: SubscriptionData): IncidentHistoryState {
  const { history } = data

  if (history.phase === 'error') {
    const status = history.error.code === 'failed-precondition' ? 'index-missing' : 'error'
    return { ...NO_HISTORY, status, error: history.error }
  }

  if (history.phase === 'snapshot' && history.confirmed) {
    const accepted = history.docs.filter((doc) => !doc.pending)
    const { entries, rejectedCount } = buildActionHistory(accepted, {
      ownerUid: data.uid,
      incidentId: data.incidentId,
    })
    return {
      status: history.fromCache ? 'stale' : 'ready',
      entries,
      rejectedCount,
      dataIssueCount: entries.filter((entry) => entry.dataIssues.length > 0).length,
      pendingCount: history.docs.length - accepted.length,
      error: null,
    }
  }

  return { ...NO_HISTORY, status: data.timedOut ? 'offline' : 'loading' }
}

/** Turns the raw listener states into what the detail page may show. */
function toDetailState(
  data: SubscriptionData
): Omit<IncidentDetailState, 'ownerUid' | 'incidentId' | 'retry'> {
  const incident = toIncidentPart(data)
  const failedClosed =
    incident.status === 'unavailable' ||
    incident.status === 'integrity-error' ||
    incident.status === 'error'
  const history = failedClosed ? HISTORY_WITHHELD : toHistoryPart(data)

  return {
    ...incident,
    canRecordDecision: incident.status === 'ready',
    history,
    reviewStatus: history.entries
      ? deriveIncidentReviewStatus(data.incidentId, history.entries)
      : null,
  }
}

const NOT_SUBSCRIBED = {
  incident: null,
  canRecordDecision: false,
  history: HISTORY_IDLE,
  reviewStatus: null,
  error: null,
}

/**
 * One incident and its decision history for the detail page (Screen B).
 * Read-only: it never writes.
 *
 * Runs two listeners under the security rules, each started only with a
 * signed-in UID and an ID that matches the rules' incident-ID pattern:
 * the incident document, and this operator's action logs for this incident
 * (all action types, newest first — actionHistoryConstraints).
 *
 * - Nothing is shown until the server has confirmed it; a cached result,
 *   including a cached absence, is never taken as the answer.
 * - The incident fails closed: not simulated → 'integrity-error'; missing, not
 *   this operator's, or refused → 'unavailable'. Its history is then withheld.
 * - The history is independent: it can load, be stale or fail (including a
 *   missing index) while the incident itself is shown.
 * - Decisions the server has not accepted yet (hasPendingWrites) are counted in
 *   `pendingCount` but never listed as history and never affect the review
 *   status. Once accepted, a metadata-only snapshot moves them into `entries`.
 *
 * Isolation follows useIncidentDashboard: loaded data carries the UID, incident
 * ID and generation that produced it and is used only while all three still
 * match (checked during render), and callbacks from a cleaned-up subscription
 * are dropped.
 */
export function useIncidentDetail(uid: string | null, incidentId: string): IncidentDetailState {
  const [data, setData] = useState<SubscriptionData | null>(null)
  // Bumped by retry(); doubles as the subscription generation.
  const [generation, setGeneration] = useState(0)

  const validId = INCIDENT_ID_PATTERN.test(incidentId)

  useEffect(() => {
    // An invalid ID never reaches incidentDoc() or the history query.
    if (!uid || !validId) return

    let active = true

    /** Applies a change only to this subscription's own data. */
    const update = (change: (current: SubscriptionData) => SubscriptionData) => {
      if (!active) return
      setData((previous) =>
        change(
          previous?.uid === uid &&
            previous.incidentId === incidentId &&
            previous.generation === generation
            ? previous
            : emptySubscription(uid, incidentId, generation)
        )
      )
    }

    const options = { includeMetadataChanges: true }

    // Only matters until both listeners are server-confirmed; then cancelled.
    const timer = setTimeout(
      () => update((current) => ({ ...current, timedOut: true })),
      SERVER_CONFIRMATION_TIMEOUT_MS
    )
    const serverConfirmed = { incident: false, history: false }
    const noteSnapshot = (which: keyof typeof serverConfirmed, fromCache: boolean) => {
      if (fromCache) return
      serverConfirmed[which] = true
      if (serverConfirmed.incident && serverConfirmed.history) clearTimeout(timer)
    }

    const incidentFailed = (error: ListenerError) =>
      update((current) => ({ ...current, incident: { phase: 'error', error } }))
    const historyFailed = (error: ListenerError) =>
      update((current) => ({ ...current, history: { phase: 'error', error } }))

    const stopIncident = safeListen(
      () =>
        onSnapshot(
          incidentDoc(incidentId),
          options,
          (snapshot) => {
            const docs = snapshot.exists()
              ? [parseIncidentDetail(snapshot.id, snapshot.data(), { ownerUid: uid })]
              : []
            noteSnapshot('incident', snapshot.metadata.fromCache)
            update((current) => ({
              ...current,
              incident: withSnapshot(current.incident, docs, snapshot.metadata.fromCache),
            }))
          },
          (error) => incidentFailed(toListenerError(error, INCIDENT_LISTENER_FAILED))
        ),
      incidentFailed
    )

    const stopHistory = safeListen(
      () =>
        onSnapshot(
          query(getActionLogsCollection(), ...actionHistoryConstraints(uid, incidentId)),
          options,
          (snapshot) => {
            // Per document: a pending write never hides accepted ones (see confirmedReviewEvidence).
            const docs = snapshot.docs.map((doc): HistoryDoc => {
              const pending = doc.metadata.hasPendingWrites
              return { id: doc.id, data: pending ? null : doc.data(), pending }
            })
            noteSnapshot('history', snapshot.metadata.fromCache)
            update((current) => ({
              ...current,
              history: withSnapshot(current.history, docs, snapshot.metadata.fromCache),
            }))
          },
          (error) => historyFailed(toListenerError(error, HISTORY_LISTENER_FAILED))
        ),
      historyFailed
    )

    return () => {
      active = false
      stopIncident()
      stopHistory()
      clearTimeout(timer)
      setData(null) // never let a later subscription start from this one's data
    }
  }, [uid, incidentId, validId, generation])

  const retry = useCallback(() => setGeneration((value) => value + 1), [])

  // Only data produced by the current UID, incident and subscription may be used.
  const current =
    uid &&
    validId &&
    data?.uid === uid &&
    data.incidentId === incidentId &&
    data.generation === generation
      ? data
      : null
  const state = useMemo(() => (current ? toDetailState(current) : null), [current])

  if (!uid) return { ...NOT_SUBSCRIBED, status: 'idle', ownerUid: null, incidentId: null, retry }
  if (!validId) {
    return { ...NOT_SUBSCRIBED, status: 'invalid-id', ownerUid: uid, incidentId: null, retry }
  }
  return {
    ...(state ?? {
      ...NOT_SUBSCRIBED,
      status: 'loading',
      history: { ...HISTORY_IDLE, status: 'loading' },
    }),
    ownerUid: uid,
    incidentId,
    retry,
  }
}
