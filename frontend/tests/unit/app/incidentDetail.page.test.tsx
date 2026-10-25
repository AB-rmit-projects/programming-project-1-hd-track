import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import IncidentDetailPage from '@/app/(dashboard)/dashboard/incidents/[incidentId]/page'
import { IncidentDetail } from '@/features/incidents/components/IncidentDetail'
import { incidentHref } from '@/features/incidents/components/IncidentQueue'

// Exception to "don't test src/app pages": this page is where an incident ID
// from the URL is checked before anything can reach Firestore.

vi.mock('@/features/incidents/components/IncidentDetail', () => ({
  IncidentDetail: vi.fn(({ incidentId }: { incidentId: string }) => (
    <p data-testid="incident-detail">{incidentId}</p>
  )),
}))

async function visit(incidentId: string) {
  render(await IncidentDetailPage({ params: Promise.resolve({ incidentId }) }))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('incident detail route', () => {
  it('a queue link opens this route with the incident ID as its only segment', () => {
    const id = 'alice-uid_INC-001'
    const href = incidentHref(id)
    expect(href).toBe(`/dashboard/incidents/${id}`)
    const segment = href.split('/').at(-1)!
    expect(decodeURIComponent(segment)).toBe(id)
  })

  it('a valid ID renders the client container with that ID', async () => {
    await visit('alice-uid_INC-001')
    expect(screen.getByTestId('incident-detail')).toHaveTextContent('alice-uid_INC-001')
    expect(vi.mocked(IncidentDetail).mock.calls[0]?.[0]).toEqual({
      incidentId: 'alice-uid_INC-001',
    })
  })

  it.each([
    ['an empty ID', ''],
    ['a slash', 'alice-uid_INC-001/actionLogs'],
    ['an encoded slash', 'alice%2FINC-001'],
    ['path traversal', '..'],
    ['a dot', 'alice.INC-001'],
    ['a space', 'alice INC-001'],
    ['a non-ASCII letter', 'alicé_INC-001'],
    ['129 characters', 'a'.repeat(129)],
  ])('%s shows "Invalid incident link" and never renders the container', async (_label, id) => {
    await visit(id)
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid incident link')
    expect(screen.getByRole('link', { name: 'Back to incident queue' })).toHaveAttribute(
      'href',
      '/dashboard'
    )
    expect(IncidentDetail).not.toHaveBeenCalled()
  })
})
