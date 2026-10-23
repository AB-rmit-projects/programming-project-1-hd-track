'use client'

import { useState } from 'react'
import Link from 'next/link'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { useAuth } from '@/hooks/useAuth'
import { useIncidentDashboard } from '@/features/incidents/hooks/useIncidentDashboard'
import type { QueueTab } from '@/features/incidents/types'
import {
  IncidentDashboardView,
  IncidentQueueHeader,
  type DashboardViewState,
} from './IncidentDashboardView'

const LOADING: DashboardViewState = {
  status: 'loading',
  summary: null,
  dataIssueCount: 0,
  integrityErrorCount: 0,
  error: null,
}

/**
 * Screen A container. The (dashboard) layout has already rejected requests
 * without a verified session; this handles the client side of auth: no
 * Firestore listener exists until AuthProvider reports a confirmed user.
 */
export function IncidentDashboard() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="space-y-6">
        <IncidentQueueHeader simulated={false} />
        <div
          aria-busy="true"
          className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-500"
        >
          <LoadingSpinner size="md" />
          <p>Checking your session…</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <IncidentQueueHeader simulated={false} />
        <div
          role="status"
          className="rounded-lg border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="font-semibold">Your session has ended.</p>
          <p className="mt-1 text-zinc-500">Sign in again to view your incident queue.</p>
          <Link
            href="/auth/signin"
            className="mt-4 inline-flex items-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900"
          >
            Sign in
          </Link>
        </div>
      </div>
    )
  }

  // Keyed by UID: another account gets a fresh component (new hook state, tab reset).
  return <OperatorDashboard key={user.uid} uid={user.uid} />
}

function OperatorDashboard({ uid }: { uid: string }) {
  const dashboard = useIncidentDashboard(uid)
  const [activeTab, setActiveTab] = useState<QueueTab>('ALL')

  // Second check after the hook's own: only data the hook reports as this UID's is shown.
  const state = dashboard.ownerUid === uid ? dashboard : LOADING

  return (
    <IncidentDashboardView
      state={state}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onRetry={dashboard.retry}
    />
  )
}
