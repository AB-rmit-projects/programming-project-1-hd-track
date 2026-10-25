import type { Metadata } from 'next'
import { incidentIdSchema } from '@/lib/validations/actionLog'
import { IncidentDetail } from '@/features/incidents/components/IncidentDetail'
import { InvalidIncidentLink } from '@/features/incidents/components/IncidentDetailView'

export const metadata: Metadata = {
  title: 'Incident details',
}

// The (dashboard) layout verifies the session server-side. The incident and its
// history are read in the browser through the client SDK, so the security
// rules (not the Admin SDK) decide what this operator can see. No Firebase
// access happens here: the ID is only checked, so an invalid one never reaches
// Firestore. A valid ID contains no characters that need URL encoding, so the
// check gives the same answer whether or not Next.js has decoded the segment.
export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ incidentId: string }>
}) {
  const { incidentId } = await params
  if (!incidentIdSchema.safeParse(incidentId).success) return <InvalidIncidentLink />
  return <IncidentDetail incidentId={incidentId} />
}
