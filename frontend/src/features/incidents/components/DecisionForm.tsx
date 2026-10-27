'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, Clock, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  ACTION_TYPES,
  NOTE_MAX_LENGTH,
  NOTE_MIN_LENGTH,
  trimNote,
} from '@/lib/validations/actionLog'
import type { ActionType } from '@/types/firestore'
import type { DecisionField } from '@/features/incidents/decisions'
import type { DecisionSubmissionState } from '@/features/incidents/hooks/useDecisionSubmission'
import { ACTION_TYPE_DESCRIPTIONS, ACTION_TYPE_LABELS } from '@/features/incidents/labels'
import type { ReviewStatus } from '@/features/incidents/types'

const IDS = {
  heading: 'decision-form-heading',
  actionLegend: 'decision-action-legend',
  actionError: 'decision-action-error',
  note: 'decision-rationale',
  noteHint: 'decision-rationale-hint',
  noteCount: 'decision-rationale-count',
  noteError: 'decision-rationale-error',
  unavailable: 'decision-unavailable',
}

const SAVE_BUTTON =
  'inline-flex w-full items-center justify-center gap-2 rounded-md bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:bg-zinc-400 sm:w-auto dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:focus-visible:outline-zinc-100 dark:disabled:bg-zinc-600'

/** Why a new decision can't be saved right now, when the incident isn't currently confirmed. */
export const DECISION_UNAVAILABLE_TEXT =
  "Saving is paused: the incident couldn't be confirmed with the server just now. Your draft stays here; you can save it once the incident is confirmed again (use Retry above)."

export const WAITING_TEXT =
  "Still waiting for the server to confirm this decision — it hasn't been saved yet. Keep this page open: this app doesn't store unsaved changes on your device, so closing or reloading the page may lose it. It will be saved automatically if the connection returns; don't submit it again."

/**
 * A decorative spinner that is valid inside a <p> or a <button> (a <span>)
 * and hidden from assistive technology: the text beside it says what is
 * happening, so it adds no second "Loading" announcement.
 */
function InlineSpinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-700 dark:border-zinc-700 dark:border-t-zinc-300"
    />
  )
}

/**
 * Feedback about the current (or a still-unresolved) submission. Used inside
 * the form and, when the form isn't shown, on its own — so an unresolved
 * write is never hidden.
 */
export function SubmissionFeedback({ submission }: { submission: DecisionSubmissionState }) {
  const { status } = submission
  return (
    <>
      {/* Always present, so changes are announced politely. */}
      <div role="status" aria-live="polite" className="empty:hidden">
        {status === 'saving' && (
          <p className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <InlineSpinner />
            Saving your decision…
          </p>
        )}
        {status === 'waiting' && (
          <p className="flex gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <Clock className="mt-0.5 size-4 shrink-0" />
            <span>{WAITING_TEXT}</span>
          </p>
        )}
        {status === 'saved' && submission.saved && (
          <p className="flex gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              Decision saved: {ACTION_TYPE_LABELS[submission.saved.actionType]}. It is added to the
              history once the history updates.
            </span>
          </p>
        )}
      </div>
      {status === 'failed' && submission.error && (
        <div
          role="alert"
          className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold">Your decision was not saved.</p>
            <p>{submission.error.message}</p>
            <p>Your decision and rationale are still here. Select Save decision to try again.</p>
          </div>
        </div>
      )}
    </>
  )
}

interface DecisionFormProps {
  submission: DecisionSubmissionState
  /** From useIncidentDetail: true only while the incident is server-confirmed. */
  canRecordDecision: boolean
  /** Null until the history is confirmed: then no claim is made either way. */
  reviewStatus: ReviewStatus | null
}

/**
 * The decision form: one of three decisions plus a rationale, submitted
 * through useDecisionSubmission (which validates with actionLogInputSchema and
 * writes). The values typed here stay until the server has accepted the
 * decision; a refused or slow save never clears them.
 */
export function DecisionForm({ submission, canRecordDecision, reviewStatus }: DecisionFormProps) {
  const [actionType, setActionType] = useState<ActionType | null>(null)
  const [note, setNote] = useState('')
  // Fields changed since the last attempt; their old validation message is hidden.
  const [edited, setEdited] = useState<ReadonlySet<DecisionField>>(new Set())
  const [handledSaveId, setHandledSaveId] = useState<string | null>(null)

  const firstRadio = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const focusFirstIssue = useRef(false)

  // Clear the form only once the server has accepted this decision (React's
  // pattern for updating state in response to a changed value during render).
  const savedId = submission.status === 'saved' ? (submission.saved?.actionLogId ?? null) : null
  if (savedId && savedId !== handledSaveId) {
    setHandledSaveId(savedId)
    setActionType(null)
    setNote('')
  }

  useEffect(() => {
    if (savedId && submission.saved) {
      // Deduplicated by ID, so a re-render can never show it twice.
      toast.success(`Decision saved: ${ACTION_TYPE_LABELS[submission.saved.actionType]}`, {
        id: savedId,
      })
    }
  }, [savedId, submission.saved])

  const issueFor = (field: DecisionField) =>
    submission.status === 'invalid' && !edited.has(field)
      ? submission.issues.find((issue) => issue.field === field)
      : undefined
  const actionIssue = issueFor('actionType')
  const noteIssue = issueFor('note')

  // Move focus to the first invalid field after a refused attempt (a DOM effect).
  useEffect(() => {
    if (submission.status !== 'invalid' || !focusFirstIssue.current) return
    focusFirstIssue.current = false
    const fields = submission.issues.map((issue) => issue.field)
    if (fields.includes('actionType')) firstRadio.current?.focus()
    else if (fields.includes('note')) noteRef.current?.focus()
  }, [submission.status, submission.issues])

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setEdited(new Set())
    const result = submission.submit({ actionType: actionType ?? undefined, note })
    if (result === 'invalid') focusFirstIssue.current = true
  }

  const markEdited = (field: DecisionField) =>
    setEdited((previous) => (previous.has(field) ? previous : new Set([...previous, field])))

  const length = trimNote(note).length
  const tooLong = length > NOTE_MAX_LENGTH
  const saveDisabled = submission.isSubmitting || !canRecordDecision
  const reviewedAgain = reviewStatus === 'REVIEWED' && actionType === 'REVIEWED'

  return (
    <section
      aria-labelledby={IDS.heading}
      className="min-w-0 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 id={IDS.heading} className="text-base font-semibold">
        Record a decision
      </h2>
      <form
        noValidate
        onSubmit={onSubmit}
        aria-busy={submission.isSubmitting}
        aria-labelledby={IDS.heading}
        className="mt-3 space-y-4"
      >
        {/* A radiogroup (ARIA 1.2) can carry aria-invalid; the native radios keep their keyboard behaviour. */}
        <fieldset
          role="radiogroup"
          aria-labelledby={IDS.actionLegend}
          aria-invalid={actionIssue ? true : undefined}
          aria-describedby={actionIssue ? IDS.actionError : undefined}
        >
          <legend id={IDS.actionLegend} className="text-sm font-medium">
            Decision
          </legend>
          <div className="mt-2 space-y-2">
            {ACTION_TYPES.map((type, index) => (
              <label
                key={type}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-md border p-3 text-sm has-[:checked]:border-zinc-900 has-[:checked]:bg-zinc-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-zinc-900 dark:has-[:checked]:border-zinc-100 dark:has-[:checked]:bg-zinc-800 dark:has-[:focus-visible]:ring-zinc-100',
                  actionIssue ? 'border-red-400' : 'border-zinc-200 dark:border-zinc-700'
                )}
              >
                <input
                  ref={index === 0 ? firstRadio : undefined}
                  type="radio"
                  name="actionType"
                  value={type}
                  checked={actionType === type}
                  onChange={() => {
                    setActionType(type)
                    markEdited('actionType')
                  }}
                  className="mt-0.5 size-4 shrink-0 accent-zinc-900 dark:accent-zinc-100"
                />
                <span className="min-w-0">
                  <span className="block font-semibold tracking-wide">{type}</span>
                  <span className="block text-zinc-600 dark:text-zinc-400">
                    {ACTION_TYPE_DESCRIPTIONS[type]}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {actionIssue && (
            <p id={IDS.actionError} className="mt-2 text-xs text-red-600 dark:text-red-400">
              {actionIssue.message}
            </p>
          )}
        </fieldset>

        {reviewedAgain && (
          <p
            role="note"
            className="rounded-md bg-zinc-100 p-3 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
          >
            This incident is already reviewed. Saving another REVIEWED decision adds a new history
            entry; the dashboard&apos;s Reviewed count stays the same.
          </p>
        )}

        <div className="space-y-1.5">
          <label htmlFor={IDS.note} className="block text-sm font-medium">
            Rationale{' '}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">(required)</span>
          </label>
          <p id={IDS.noteHint} className="text-xs text-zinc-500 dark:text-zinc-400">
            Explain your decision in {NOTE_MIN_LENGTH}–{NOTE_MAX_LENGTH} characters. Spaces at the
            start and end don&apos;t count.
          </p>
          <textarea
            id={IDS.note}
            ref={noteRef}
            rows={5}
            value={note}
            onChange={(event) => {
              setNote(event.target.value)
              markEdited('note')
            }}
            aria-invalid={noteIssue ? true : undefined}
            aria-describedby={[IDS.noteHint, IDS.noteCount, noteIssue ? IDS.noteError : null]
              .filter(Boolean)
              .join(' ')}
            className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm [overflow-wrap:anywhere] shadow-sm focus:ring-2 focus:ring-zinc-500 focus:outline-none aria-invalid:border-red-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <p
            id={IDS.noteCount}
            className={cn(
              'text-xs tabular-nums',
              tooLong ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'
            )}
          >
            {length} / {NOTE_MAX_LENGTH} characters{tooLong ? ' — over the limit' : ''}
          </p>
          {noteIssue && (
            <p id={IDS.noteError} className="text-xs text-red-600 dark:text-red-400">
              {noteIssue.message}
            </p>
          )}
        </div>

        {!canRecordDecision && !submission.isSubmitting && (
          <p
            id={IDS.unavailable}
            className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          >
            {DECISION_UNAVAILABLE_TEXT}
          </p>
        )}

        <SubmissionFeedback submission={submission} />

        <button
          type="submit"
          disabled={saveDisabled}
          aria-describedby={
            !canRecordDecision && !submission.isSubmitting ? IDS.unavailable : undefined
          }
          className={SAVE_BUTTON}
        >
          {submission.isSubmitting && <InlineSpinner />}
          {submission.status === 'waiting'
            ? 'Waiting for confirmation…'
            : submission.isSubmitting
              ? 'Saving…'
              : 'Save decision'}
        </button>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Decisions are recorded in this demo only. ESCALATE sends no alert, notification or welfare
          check.
        </p>
      </form>
    </section>
  )
}
