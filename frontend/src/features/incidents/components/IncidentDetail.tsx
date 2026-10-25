'use client'

import Link from 'next/link'
import { LoadingSpinner } from '@/components/shared/LoadingSpinner'
import { useAuth } from '@/hooks/useAuth'
import { useDecisionSubmission } from '@/features/incidents/hooks/useDecisionSubmission'
import { useIncidentDetail } from '@/features/incidents/hooks/useIncidentDetail'
import { BackToQueue, IncidentDetailView } from './IncidentDetailView'

/**
 * Screen B container. The (dashboard) layout has already rejected requests
 * without a verified session; this handles the client side of auth: no
 * Firestore listener or write exists until AuthProvider reports a confirmed
 * user.
 */
export function IncidentDetail({ incidentId }: { incidentId: string }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="space-y-6">
        <BackToQueue />
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
        <BackToQueue />
        <div
          role="status"
          className="rounded-lg border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <p className="font-semibold">Your session has ended.</p>
          <p className="mt-1 text-zinc-500">Sign in again to view this incident.</p>
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

  // Keyed by UID and incident: another account or incident gets fresh
  // components — new hook state and an empty form.
  return (
    <OperatorIncidentDetail
      key={JSON.stringify([user.uid, incidentId])}
      uid={user.uid}
      incidentId={incidentId}
    />
  )
}

function OperatorIncidentDetail({ uid, incidentId }: { uid: string; incidentId: string }) {
  const detail = useIncidentDetail(uid, incidentId)
  const submission = useDecisionSubmission({
    uid,
    incidentId,
    canRecordDecision: detail.canRecordDecision,
  })

  return <IncidentDetailView detail={detail} submission={submission} />
}
