'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CloudOff, Info, ShieldAlert, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { IncidentDashboardState } from '@/features/incidents/hooks/useIncidentDashboard'
import { QUEUE_TAB_LABELS } from '@/features/incidents/labels'
import { filterByTab } from '@/features/incidents/reviewSummary'
import type { QueueTab, ReviewSummary } from '@/features/incidents/types'
import { IncidentQueue } from './IncidentQueue'
import { RetryButton, StatePanel } from './StatePanel'
import { QueueTabs, tabId } from './QueueTabs'
import { SimulatedDataNotice, SimulatedDataPill } from './SimulatedDataNotice'
import { SummaryStats } from './SummaryStats'

export type DashboardViewState = Pick<
  IncidentDashboardState,
  'status' | 'summary' | 'dataIssueCount' | 'integrityErrorCount' | 'error'
>

interface IncidentDashboardViewProps {
  state: DashboardViewState
  activeTab: QueueTab
  onTabChange: (tab: QueueTab) => void
  onRetry: () => void
}

const PANEL_ID = 'incident-queue-panel'

export function IncidentQueueHeader({ simulated }: { simulated: boolean }) {
  // The pill sits beneath the title on narrow screens and beside it from sm up
  // (PageHeader's own actions slot would squeeze the title on mobile).
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <PageHeader
        title="SafeCall incident queue"
        description="Connectivity incidents assigned to your operator account."
      />
      {simulated && (
        <div className="shrink-0">
          <SimulatedDataPill />
        </div>
      )}
    </div>
  )
}

function errorText(code: string | undefined): { title: string; detail: ReactNode } {
  switch (code) {
    case 'permission-denied':
      // The rules refused the read. That can mean an ended session, but also rules
      // or account state that do not grant access, so don't assume either.
      return {
        title: 'Access to your incident records was denied.',
        detail: (
          <p>
            The incident database refused this request for your account. Retry; if it keeps
            happening,{' '}
            <Link href="/auth/signin" className="font-medium underline underline-offset-4">
              sign in again
            </Link>{' '}
            or contact the administrator.
          </p>
        ),
      }
    case 'unavailable':
      return {
        title: "Can't reach the incident database.",
        detail: <p>Check your connection, then retry.</p>,
      }
    default:
      return {
        title: 'Incident data could not be loaded.',
        // Retry may not help if the Firestore client itself has failed; a reload does.
        detail: (
          <p>Retry. If the problem continues, reload the page or contact the administrator.</p>
        ),
      }
  }
}

const EMPTY_TAB_TEXT: Record<QueueTab, { title: string; description?: string }> = {
  ALL: { title: 'No incidents to show.' },
  AWAITING_REVIEW: { title: 'No incidents are awaiting review.' },
  REVIEWED: {
    title: 'No reviewed incidents yet.',
    description: 'An incident counts as reviewed once a REVIEWED decision is recorded for it.',
  },
}

function Queue({
  summary,
  activeTab,
  onTabChange,
}: { summary: ReviewSummary } & Pick<IncidentDashboardViewProps, 'activeTab' | 'onTabChange'>) {
  if (summary.total === 0) {
    // Unseeded account (server-confirmed): explain, never offer to create incidents.
    return (
      <EmptyState
        title="No incidents are assigned to this account"
        description="Demo setup hasn't been completed for this operator. Ask the administrator to run the incident setup for your account. Incidents can't be created here."
      />
    )
  }

  const rows = filterByTab(summary.rows, activeTab)
  const empty = EMPTY_TAB_TEXT[activeTab]

  return (
    <div className="space-y-4">
      <QueueTabs
        activeTab={activeTab}
        counts={{
          ALL: summary.total,
          AWAITING_REVIEW: summary.awaiting,
          REVIEWED: summary.reviewed,
        }}
        panelId={PANEL_ID}
        onChange={onTabChange}
      />
      <div role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(activeTab)}>
        {rows.length > 0 ? (
          <IncidentQueue rows={rows} label={`${QUEUE_TAB_LABELS[activeTab]} incidents`} />
        ) : (
          <EmptyState title={empty.title} description={empty.description} />
        )}
      </div>
    </div>
  )
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function Body({ state, activeTab, onTabChange, onRetry }: IncidentDashboardViewProps) {
  switch (state.status) {
    case 'error': {
      const { title, detail } = errorText(state.error?.code)
      return (
        <StatePanel
          role="alert"
          tone="danger"
          icon={TriangleAlert}
          title={title}
          action={<RetryButton onRetry={onRetry} />}
        >
          {detail}
        </StatePanel>
      )
    }

    case 'integrity-error':
      // Fail closed: nothing from any record is shown, and nothing is labelled simulated.
      return (
        <StatePanel
          role="alert"
          tone="danger"
          icon={ShieldAlert}
          title={`${plural(state.integrityErrorCount, 'incident record is', 'incident records are')} not marked as simulated, so the queue can't be shown.`}
          action={<RetryButton onRetry={onRetry} />}
        >
          <p>
            These records may not be demonstration data. No incident details or counts are
            displayed. Contact the administrator to check the incident data.
          </p>
        </StatePanel>
      )

    case 'offline':
      // Recovery first, so Retry is not pushed below the unavailable statistics on a phone.
      return (
        <>
          <StatePanel
            role="status"
            tone="warning"
            icon={CloudOff}
            title="Incident data couldn't be confirmed with the server."
            action={<RetryButton onRetry={onRetry} />}
          >
            <p>
              Counts are not shown until the data is confirmed. Check your connection, then retry.
            </p>
          </StatePanel>
          <SummaryStats summary={null} />
        </>
      )

    case 'ready':
    case 'stale':
      if (state.summary) {
        return (
          <>
            {state.status === 'stale' && (
              <StatePanel
                role="status"
                tone="warning"
                icon={CloudOff}
                title="Showing cached data; information may be out of date."
                action={<RetryButton onRetry={onRetry} />}
              >
                <p>The latest incident data hasn&apos;t been confirmed by the server.</p>
              </StatePanel>
            )}
            {state.dataIssueCount > 0 && (
              <StatePanel
                role="note"
                tone="neutral"
                icon={Info}
                title={`${plural(state.dataIssueCount, 'incident record has', 'incident records have')} missing or unexpected fields.`}
              >
                <p>
                  Affected values are shown as “—”, “Unknown”, “Unrecognised category” or “Not
                  recorded”.
                </p>
              </StatePanel>
            )}
            <SummaryStats summary={state.summary} />
            <Queue summary={state.summary} activeTab={activeTab} onTabChange={onTabChange} />
          </>
        )
      }
      return <Loading />

    default:
      return <Loading />
  }
}

function Loading() {
  return (
    <>
      <SummaryStats summary={null} />
      <div
        aria-busy="true"
        className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500"
      >
        <LoadingSpinner size="md" />
        <p>Loading incidents…</p>
      </div>
    </>
  )
}

/** Presentational dashboard: renders a hook state, holds no data logic of its own. */
export function IncidentDashboardView(props: IncidentDashboardViewProps) {
  // Never present records rejected as possibly non-simulated under the simulated label.
  const simulated = props.state.status !== 'integrity-error'
  return (
    <div className="space-y-6">
      <IncidentQueueHeader simulated={simulated} />
      {simulated && <SimulatedDataNotice />}
      <Body {...props} />
    </div>
  )
}
