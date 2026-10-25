'use client'

import { useCallback, useEffect, useState } from 'react'
import { INCIDENT_ID_PATTERN } from '@/lib/validations/actionLog'
import type { ActionType } from '@/types/firestore'
import type { DecisionIssue } from '@/features/incidents/decisions'
import { startDecisionWrite, type DecisionWriteOutcome } from '@/features/incidents/decisionWriter'
import type { SafeFirestoreError } from '@/features/incidents/firestoreErrors'

/** After this long without the server's answer, the save is reported as slow (never as failed). */
export const SLOW_SAVE_AFTER_MS = 10_000

export type DecisionSubmissionStatus =
  | 'idle' // nothing submitted in this context yet (or reset)
  | 'invalid' // the input failed validation; nothing was written
  | 'ineligible' // no user, an invalid ID, or the incident isn't currently confirmed; nothing was written
  | 'saving' // the write has been sent; the server hasn't answered yet
  | 'waiting' // still no answer after SLOW_SAVE_AFTER_MS — not confirmed, not failed
  | 'saved' // the server accepted the write
  | 'failed' // the server refused it, or it failed; nothing was saved

/** What submit() did, returned synchronously. */
export type SubmitResult = 'started' | 'busy' | 'invalid' | 'ineligible'

export interface SavedDecision {
  actionLogId: string
  actionType: ActionType
}

export interface DecisionSubmissionState {
  status: DecisionSubmissionStatus
  /** A write for this user and incident is unresolved: submit() refuses to start another. */
  isSubmitting: boolean
  /** The unresolved write has taken longer than SLOW_SAVE_AFTER_MS. */
  isWaiting: boolean
  /** Validation problems, when status is 'invalid'. */
  issues: DecisionIssue[]
  /** A safe code and a message written for this action, when status is 'failed'. */
  error: SafeFirestoreError | null
  /** The accepted decision, when status is 'saved'. */
  saved: SavedDecision | null
  /**
   * Validates and, if allowed, starts one write. Returns at once; the outcome
   * arrives through the state. Never resubmits by itself: after 'failed' the
   * caller submits again explicitly.
   */
  submit: (input: unknown) => SubmitResult
  /** Clears a finished result (saved / failed / invalid / ineligible); does nothing while a write is unresolved. */
  reset: () => void
}

interface InFlightWrite {
  confirmed: Promise<DecisionWriteOutcome>
  startedAt: number
}

/**
 * The synchronous duplicate-submission lock: one unresolved write per user and
 * incident. It lives at module level, not in a component, so it holds across
 * re-renders, double clicks and remounts (navigating away and back): a
 * remounted hook finds the unresolved write here and follows it instead of
 * allowing a second one. It is released only when the server accepts or
 * refuses the write. Like the SDK's in-memory write queue, it lasts only as
 * long as the page: a reload clears both.
 */
const inFlightWrites = new Map<string, InFlightWrite>()

function contextKey(uid: string, incidentId: string): string {
  return JSON.stringify([uid, incidentId])
}

interface SubmissionData {
  /** The user and incident this state belongs to (null without either). */
  key: string | null
  status: DecisionSubmissionStatus
  write: InFlightWrite | null
  issues: DecisionIssue[]
  error: SafeFirestoreError | null
  saved: SavedDecision | null
}

/** A fresh state for a context, following its unresolved write if one exists. */
function stateFor(key: string | null): SubmissionData {
  const write = key ? (inFlightWrites.get(key) ?? null) : null
  return {
    key,
    status: write ? 'saving' : 'idle',
    write,
    issues: [],
    error: null,
    saved: null,
  }
}

function settled(key: string, outcome: DecisionWriteOutcome): SubmissionData {
  const base = { key, write: null, issues: [] }
  return outcome.ok
    ? {
        ...base,
        status: 'saved',
        error: null,
        saved: { actionLogId: outcome.actionLogId, actionType: outcome.actionType },
      }
    : { ...base, status: 'failed', error: outcome.error, saved: null }
}

/**
 * Submits operator decisions for one incident (Screen B). Connects to the form
 * in CP5; holds no form values itself, so whatever the user typed stays in the
 * form until the caller clears it after 'saved'.
 *
 * - `canRecordDecision` comes from useIncidentDetail: true only while the
 *   incident is server-confirmed ('ready'). The security rules still decide.
 * - Success is reported only when the server accepts the write; slow writes
 *   become 'waiting' but stay locked, are never retried or cancelled, and can
 *   still end in 'saved' or 'failed'.
 * - State belongs to one user and incident: a change of either shows that
 *   context's own state at once, and results from another context are dropped.
 *   An unmounted hook never updates state; its write carries on regardless.
 */
export function useDecisionSubmission({
  uid,
  incidentId,
  canRecordDecision,
}: {
  uid: string | null
  incidentId: string
  canRecordDecision: boolean
}): DecisionSubmissionState {
  const key = uid && INCIDENT_ID_PATTERN.test(incidentId) ? contextKey(uid, incidentId) : null
  const [data, setData] = useState<SubmissionData>(() => stateFor(key))

  // A new user or incident starts from its own state, picking up its own
  // unresolved write. Adjusted during render (React's pattern for resetting
  // state when a prop changes), so another context's result never shows.
  let current = data
  if (data.key !== key) {
    current = stateFor(key)
    setData(current)
  }

  // Follow the unresolved write: report it as slow after a while, then its outcome.
  const write = current.write
  useEffect(() => {
    if (!key || !write) return
    let active = true
    const apply = (change: (previous: SubmissionData) => SubmissionData) => {
      if (!active) return
      setData((previous) =>
        previous.key === key && previous.write === write ? change(previous) : previous
      )
    }

    const remaining = Math.max(0, SLOW_SAVE_AFTER_MS - (Date.now() - write.startedAt))
    const timer = setTimeout(
      () =>
        apply((previous) =>
          previous.status === 'saving' ? { ...previous, status: 'waiting' } : previous
        ),
      remaining
    )
    void write.confirmed.then((outcome) => {
      clearTimeout(timer)
      apply(() => settled(key, outcome))
    })

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [key, write])

  const submit = useCallback(
    (input: unknown): SubmitResult => {
      if (!uid || !key) {
        setData({ ...stateFor(key), status: 'ineligible' })
        return 'ineligible'
      }
      // The lock: checked and taken synchronously, before any await or re-render.
      if (inFlightWrites.has(key)) return 'busy'
      if (!canRecordDecision) {
        setData({ ...stateFor(key), status: 'ineligible' })
        return 'ineligible'
      }

      const start = startDecisionWrite(uid, incidentId, input)
      if (!start.started) {
        setData({ ...stateFor(key), status: 'invalid', issues: start.issues })
        return 'invalid'
      }

      const entry: InFlightWrite = { confirmed: start.confirmed, startedAt: Date.now() }
      inFlightWrites.set(key, entry)
      // Released only once the server has answered (confirmed never rejects).
      void start.confirmed.then(() => {
        if (inFlightWrites.get(key) === entry) inFlightWrites.delete(key)
      })
      setData({ ...stateFor(key), status: 'saving', write: entry })
      return 'started'
    },
    [uid, incidentId, key, canRecordDecision]
  )

  const reset = useCallback(() => {
    setData((previous) =>
      previous.key === key && previous.write !== null ? previous : stateFor(key)
    )
  }, [key])

  return {
    status: current.status,
    isSubmitting: current.status === 'saving' || current.status === 'waiting',
    isWaiting: current.status === 'waiting',
    issues: current.issues,
    error: current.error,
    saved: current.saved,
    submit,
    reset,
  }
}
