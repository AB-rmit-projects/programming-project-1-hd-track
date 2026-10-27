'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CloudOff, History, Info, SearchX, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { EmptyState } from '@/components/shared/EmptyState'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import type { IncidentDashboardState } from '@/features/incidents/hooks/useIncidentDashboard'
import { QUEUE_TAB_LABELS } from '@/features/incidents/labels'
import {
  applyQueueView,
  hasActiveFilters,
  reportedDateBounds,
  type QueueFilters,
  type QueueSort,
} from '@/features/incidents/queueView'
import { filterByTab } from '@/features/incidents/reviewSummary'
import type { QueueTab, ReviewSummary } from '@/features/incidents/types'
import { IncidentQueue } from './IncidentQueue'
import { QueueControls } from './QueueControls'
import { BUTTON, RetryButton, StatePanel } from './StatePanel'
import { QueueTabs, tabId } from './QueueTabs'
import { SimulatedDataNotice, SimulatedDataPill } from './SimulatedDataNotice'
import { SummaryStats } from './SummaryStats'

export type DashboardViewState = Pick<
  IncidentDashboardState,
  'status' | 'summary' | 'dataIssueCount' | 'integrityErrorCount' | 'error'
>

/** The queue's view settings: review tab, filters and sort. They never change the counts. */
export interface QueueViewProps {
  activeTab: QueueTab
  onTabChange: (tab: QueueTab) => void
  filters: QueueFilters
  onFiltersChange: (filters: QueueFilters) => void
  sort: QueueSort
  onSortChange: (sort: QueueSort) => void
  onClearFilters: () => void
}

interface IncidentDashboardViewProps extends QueueViewProps {
  state: DashboardViewState
  onRetry: () => void
}

const PANEL_ID = 'incident-queue-panel'

export function IncidentQueueHeader({ simulated }: { simulated: boolean }) {
  // The pill sits beneath the title on narrow screens and beside it from sm up
  // (PageHeader's own actions slot would squeeze the title on mobile).
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <PageHeader
        title="Incident queue"
        description="Historical pendant connectivity incidents assigned to your operator account, for review."
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
  filters,
  onFiltersChange,
  sort,
  onSortChange,
  onClearFilters,
}: { summary: ReviewSummary } & QueueViewProps) {
  if (summary.total === 0) {
    // Unseeded account (server-confirmed): explain, never offer to create incidents.
    return (
      <EmptyState
        title="No incidents are assigned to this account"
        description="Demo setup hasn't been completed for this operator. Ask the administrator to run the incident setup for your account. Incidents can't be created here."
      />
    )
  }

  const tabRows = filterByTab(summary.rows, activeTab)
  const rows = applyQueueView(tabRows, filters, sort)
  const filtered = hasActiveFilters(filters)
  const legacyCount = summary.rows.filter((row) => row.legacyTimeline).length
  const empty = EMPTY_TAB_TEXT[activeTab]
  // e.g. "awaiting review incidents"; plain "incidents" on the All tab.
  const noun = (count: number) =>
    `${activeTab === 'ALL' ? '' : `${QUEUE_TAB_LABELS[activeTab].toLowerCase()} `}${count === 1 ? 'incident' : 'incidents'}`

  return (
    <div className="space-y-4">
      {legacyCount > 0 && (
        <StatePanel
          role="note"
          tone="neutral"
          icon={History}
          title={`${plural(legacyCount, 'incident is', 'incidents are')} in the earlier data format.`}
        >
          <p>
            Their simulated report times aren&apos;t recorded yet, so a date filter leaves them out
            and report-time sorting lists them last. Nothing is estimated in the meantime.
          </p>
        </StatePanel>
      )}
      <QueueControls
        filters={filters}
        sort={sort}
        dateBounds={reportedDateBounds(summary.rows)}
        onFiltersChange={onFiltersChange}
        onSortChange={onSortChange}
        onClear={onClearFilters}
      />
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
      <div role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(activeTab)} className="space-y-3">
        <p role="status" aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {filtered
            ? `${rows.length} of ${tabRows.length} ${noun(tabRows.length)} match your filters.`
            : `Showing all ${tabRows.length} ${noun(tabRows.length)}.`}
        </p>
        {rows.length > 0 ? (
          <IncidentQueue rows={rows} label={`${QUEUE_TAB_LABELS[activeTab]} incidents`} />
        ) : filtered && tabRows.length > 0 ? (
          <EmptyState
            icon={SearchX}
            title="No incidents match your search and filters."
            description="Try a different search term or date range, or clear the filters."
            action={
              <button type="button" onClick={onClearFilters} className={BUTTON}>
                <X aria-hidden="true" className="size-4" />
                Clear filters
              </button>
            }
          />
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

function Body({ state, onRetry, ...view }: IncidentDashboardViewProps) {
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
            <Queue summary={state.summary} {...view} />
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
        className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500 dark:text-zinc-400"
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
