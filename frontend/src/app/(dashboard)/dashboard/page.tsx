import type { Metadata } from 'next'
import { IncidentDashboard } from '@/features/incidents/components/IncidentDashboard'

export const metadata: Metadata = {
  title: 'Incident queue',
}

// The (dashboard) layout verifies the session server-side. Incident data is
// read in the browser through the client SDK, so the security rules (not the
// Admin SDK) decide what this operator can see.
export default function DashboardPage() {
  return <IncidentDashboard />
}
