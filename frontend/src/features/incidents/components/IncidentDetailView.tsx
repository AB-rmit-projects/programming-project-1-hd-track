'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  ChevronRight,
  CloudOff,
  Info,
  SearchX,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { DecisionSubmissionState } from '@/features/incidents/hooks/useDecisionSubmission'
import type { IncidentDetailState } from '@/features/incidents/hooks/useIncidentDetail'
import { ActionHistory } from './ActionHistory'
import { DecisionForm, SubmissionFeedback } from './DecisionForm'
import { IncidentStatusBadge, ReviewStatusBadge } from './IncidentBadges'
import { IncidentFacts } from './IncidentFacts'
import { SimulatedDataNotice, SimulatedDataPill } from './SimulatedDataNotice'
import { BUTTON, RetryButton, StatePanel } from './StatePanel'

const LINK_FOCUS =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100'

export function BackToQueue() {
  return (
    <Link
      href="/dashboard"
      className={`inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 ${LINK_FOCUS}`}
    >
      <ArrowLeft className="size-4" />
      Back to incident queue
    </Link>
  )
}

/** Where this page sits: the queue, then this incident. */
function Breadcrumbs({ current }: { current: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-zinc-500 dark:text-zinc-400">
        <li>
          <Link
            href="/dashboard"
            className={`font-medium text-zinc-600 underline-offset-4 hover:text-zinc-900 hover:underline dark:text-zinc-400 dark:hover:text-zinc-100 ${LINK_FOCUS}`}
          >
            Incident queue
          </Link>
        </li>
        <li aria-hidden="true">
          <ChevronRight className="size-4" />
        </li>
        <li
          aria-current="page"
          className="min-w-0 [overflow-wrap:anywhere] text-zinc-900 dark:text-zinc-100"
        >
          {current}
        </li>
      </ol>
    </nav>
  )
}

function Header({ title, badges }: { title: string; badges?: ReactNode }) {
  return (
    <div className="space-y-3">
      <Breadcrumbs current={title} />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <h1 className="text-2xl font-bold tracking-tight [overflow-wrap:anywhere]">{title}</h1>
        {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
      </div>
    </div>
  )
}

/** Shown for an ID that can't be an incident ID; nothing was requested. */
export function InvalidIncidentLink() {
  return (
    <div className="space-y-6">
      <Header title="Incident details" />
      <StatePanel role="alert" tone="neutral" icon={SearchX} title="Invalid incident link">
        <p>
          This link doesn&apos;t point to an incident. Go back to the queue and open the incident
          from there.
        </p>
      </StatePanel>
      <BackToQueue />
    </div>
  )
}

/** A write that is still unresolved (or just finished) stays visible even when the form isn't shown. */
function OrphanFeedback({ submission }: { submission: DecisionSubmissionState }) {
  if (!['saving', 'waiting', 'saved', 'failed'].includes(submission.status)) return null
  // Without the form around it (e.g. after leaving and returning while a save
  // was unresolved), say what this is and why no new decision can start.
  return (
    <section
      aria-labelledby="orphan-decision-heading"
      className="space-y-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <h2 id="orphan-decision-heading" className="font-semibold">
        Your decision
      </h2>
      {submission.isSubmitting && (
        <p className="text-zinc-600 dark:text-zinc-400">
          A decision you submitted for this incident is still being saved. You can&apos;t record
          another one until the server confirms it.
        </p>
      )}
      <SubmissionFeedback submission={submission} />
    </section>
  )
}

function Loading() {
  return (
    <div
      aria-busy="true"
      className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500 dark:text-zinc-400"
    >
      <LoadingSpinner size="md" />
      <p>Loading incident…</p>
    </div>
  )
}

function errorDetail(code: string | undefined) {
  return code === 'unavailable'
    ? "Can't reach the incident database. Check your connection, then retry."
    : 'Retry. If the problem continues, reload the page or contact the administrator.'
}

interface IncidentDetailViewProps {
  detail: IncidentDetailState
  submission: DecisionSubmissionState
}

/** Presentational detail page: renders the two hook states, holds no data logic of its own. */
export function IncidentDetailView({ detail, submission }: IncidentDetailViewProps) {
  const { status, incident, history, reviewStatus, retry } = detail

  if (status === 'invalid-id') return <InvalidIncidentLink />

  if ((status === 'ready' || status === 'stale') && incident) {
    return (
      <div className="space-y-6">
        <Header
          title={incident.incidentCode ?? 'Incident (code not recorded)'}
          badges={
            <>
              <IncidentStatusBadge status={incident.status} />
              {/* Only once the history is confirmed: an unverified status is never shown. */}
              {reviewStatus && <ReviewStatusBadge status={reviewStatus} />}
              <SimulatedDataPill />
            </>
          }
        />
        <SimulatedDataNotice />
        {status === 'stale' && (
          <StatePanel
            role="status"
            tone="warning"
            icon={CloudOff}
            title="Showing cached incident data; it may be out of date."
            action={<RetryButton onRetry={retry} />}
          >
            <p>
              The incident couldn&apos;t be confirmed with the server just now. New decisions
              can&apos;t be saved until it is.
            </p>
          </StatePanel>
        )}
        {incident.dataIssues.length > 0 && (
          <StatePanel
            role="note"
            tone="neutral"
            icon={Info}
            title="This incident record has missing or unexpected fields."
          >
            <p>
              Affected values are shown as “—”, “Unknown”, “Unrecognised category” or “Not
              recorded”. Nothing has been filled in.
            </p>
          </StatePanel>
        )}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
          <IncidentFacts incident={incident} />
          <DecisionForm
            submission={submission}
            canRecordDecision={detail.canRecordDecision}
            reviewStatus={reviewStatus}
          />
        </div>
        <ActionHistory history={history} onRetry={retry} />
        <BackToQueue />
      </div>
    )
  }

  let body: ReactNode
  switch (status) {
    case 'offline':
      body = (
        <StatePanel
          role="status"
          tone="warning"
          icon={CloudOff}
          title="The incident couldn't be confirmed with the server."
          action={<RetryButton onRetry={retry} />}
        >
          <p>
            Its details aren&apos;t shown until they are confirmed. Check your connection, then
            retry.
          </p>
        </StatePanel>
      )
      break
    case 'unavailable':
      // One message for missing, another operator's, or refused — deliberately not told apart.
      body = (
        <StatePanel
          role="alert"
          tone="neutral"
          icon={SearchX}
          title="Incident not available"
          action={
            <div className="flex flex-wrap gap-2">
              <Link href="/dashboard" className={BUTTON}>
                Back to incident queue
              </Link>
              <RetryButton onRetry={retry} />
            </div>
          }
        >
          <p>This incident doesn&apos;t exist or isn&apos;t available to your account.</p>
        </StatePanel>
      )
      break
    case 'integrity-error':
      body = (
        <StatePanel
          role="alert"
          tone="danger"
          icon={ShieldAlert}
          title="This incident record is not marked as simulated, so it can't be shown."
          action={<RetryButton onRetry={retry} />}
        >
          <p>
            It may not be demonstration data. No details or decisions are displayed. Contact the
            administrator to check the incident data.
          </p>
        </StatePanel>
      )
      break
    case 'error':
      body = (
        <StatePanel
          role="alert"
          tone="danger"
          icon={TriangleAlert}
          title="The incident couldn't be loaded."
          action={<RetryButton onRetry={retry} />}
        >
          <p>{errorDetail(detail.error?.code)}</p>
        </StatePanel>
      )
      break
    default:
      body = <Loading />
  }

  return (
    <div className="space-y-6">
      <Header title="Incident details" />
      {/* Never labelled simulated when the record failed the simulated-data check. */}
      {status !== 'integrity-error' && status !== 'unavailable' && <SimulatedDataNotice />}
      {body}
      <OrphanFeedback submission={submission} />
      {/* The unavailable panel already offers its own way back. */}
      {status !== 'unavailable' && <BackToQueue />}
    </div>
  )
}
