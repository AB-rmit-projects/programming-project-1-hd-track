import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Timestamp, type FirestoreError } from 'firebase/firestore'
import {
  IncidentDashboard,
  resetRememberedQueueViews,
} from '@/features/incidents/components/IncidentDashboard'
import {
  useIncidentDashboard,
  type IncidentDashboardState,
} from '@/features/incidents/hooks/useIncidentDashboard'
import { parseIncident } from '@/features/incidents/incidentRow'
import { CAUSE_CATEGORY_LABELS } from '@/features/incidents/labels'
import { DEFAULT_SORT, sortRows } from '@/features/incidents/queueView'
import { deriveReviewSummary } from '@/features/incidents/reviewSummary'
import type { IncidentRow, ReviewSummary } from '@/features/incidents/types'
import { useAuth } from '@/hooks/useAuth'
import { formatMelbourneDateTime } from '@/lib/melbourneTime'
import type { AuthContextValue } from '@/types/auth'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

// The dashboard hook and auth are mocked: these tests cover what the UI shows
// for each hook state. The hook itself is tested in useIncidentDashboard.test.ts.
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('@/features/incidents/hooks/useIncidentDashboard', () => ({
  useIncidentDashboard: vi.fn(),
}))

const ALICE = 'alice-uid'
const BOB = 'bob-uid'
const NOW = new Date('2026-10-21T00:00:00.000Z')

// ── Fixtures built with the real CP1 logic ──────────────────────────────────

function seededRows(owner: string): IncidentRow[] {
  return buildSeedIncidents(owner, NOW).map(({ id, data }) => {
    const parsed = parseIncident(id, {
      ...data,
      reportedAt: Timestamp.fromDate(data.reportedAt),
      lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
      createdAt: Timestamp.fromDate(data.createdAt),
    })
    if (!parsed.ok) throw new Error(`seed record ${id} was rejected`)
    return parsed.row
  })
}

function summaryFor(rows: IncidentRow[], owner: string, reviewedCodes: string[] = []) {
  return deriveReviewSummary(
    rows,
    reviewedCodes.map((code) => ({ actionType: 'REVIEWED', incidentId: `${owner}_${code}` }))
  )
}

const seededSummary = (owner: string, reviewedCodes: string[] = []) =>
  summaryFor(seededRows(owner), owner, reviewedCodes)

const retry = vi.fn()

function dashboardState(overrides: Partial<IncidentDashboardState> = {}): IncidentDashboardState {
  return {
    status: 'ready',
    ownerUid: ALICE,
    summary: null,
    dataIssueCount: 0,
    integrityErrorCount: 0,
    error: null,
    retry,
    ...overrides,
  }
}

function signedInAs(uid: string | null, { loading = false } = {}) {
  const user = uid ? ({ uid } as AuthContextValue['user']) : null
  vi.mocked(useAuth).mockReturnValue({
    user,
    profile: null,
    loading,
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
    confirmSession: vi.fn(),
  })
}

function hookReturns(state: IncidentDashboardState) {
  vi.mocked(useIncidentDashboard).mockReturnValue(state)
}

function showDashboard(summary: ReviewSummary, overrides: Partial<IncidentDashboardState> = {}) {
  signedInAs(ALICE)
  hookReturns(dashboardState({ summary, ...overrides }))
  return render(<IncidentDashboard />)
}

function firestoreError(code: string): FirestoreError {
  return Object.assign(new Error(code), { code, name: 'FirebaseError' }) as FirestoreError
}

// ── Query helpers ────────────────────────────────────────────────────────────

const table = () => screen.getByRole('table')
const cardList = () => screen.getByRole('list', { name: /incidents$/ })
const tableRows = () => within(table()).getAllByRole('row').slice(1) // minus the header row

/** The value shown under a summary card's label. */
function stat(label: string): string {
  const dt = screen.getAllByRole('term').find((el) => el.textContent === label)
  if (!dt) throw new Error(`no summary card "${label}"`)
  return dt.nextElementSibling?.textContent ?? ''
}

function statValues() {
  return {
    total: stat('Total incidents'),
    awaiting: stat('Awaiting review'),
    reviewed: stat('Reviewed'),
  }
}

function expectNoIncidentData() {
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(screen.queryByRole('list')).not.toBeInTheDocument()
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  expect(screen.queryByText(/INC-\d{3}/)).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRememberedQueueViews()
})

/** The queue's rows in the order shown by default (newest report first). */
const shownOrder = (summary: ReviewSummary) => sortRows(summary.rows, DEFAULT_SORT)

// ── Authentication ───────────────────────────────────────────────────────────

describe('IncidentDashboard — authentication', () => {
  it('while auth is loading: shows a session check and starts no Firestore listener', () => {
    signedInAs(null, { loading: true })
    render(<IncidentDashboard />)

    expect(screen.getByText('Checking your session…')).toBeInTheDocument()
    expect(useIncidentDashboard).not.toHaveBeenCalled()
  })

  it('signed out: explains the session ended, links to sign-in, starts no listener', () => {
    signedInAs(null)
    render(<IncidentDashboard />)

    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended.')
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/signin')
    expect(useIncidentDashboard).not.toHaveBeenCalled()
    expectNoIncidentData()
  })

  it('signed in: the hook is given the signed-in UID', () => {
    showDashboard(seededSummary(ALICE))
    expect(useIncidentDashboard).toHaveBeenCalledWith(ALICE)
  })

  it('shows the queue heading', () => {
    showDashboard(seededSummary(ALICE))
    expect(screen.getByRole('heading', { name: 'Incident queue' })).toBeInTheDocument()
  })
})

// ── Data states ──────────────────────────────────────────────────────────────

describe('IncidentDashboard — loading, offline, stale and error states', () => {
  it('loading: no counts (— with an accessible "not available"), busy, no queue', () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'loading' }))
    render(<IncidentDashboard />)

    expect(statValues()).toEqual({
      total: '—Not available yet',
      awaiting: '—Not available yet',
      reviewed: '—Not available yet',
    })
    expect(screen.getAllByRole('term')[0]?.closest('dl')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('Loading incidents…')).toBeInTheDocument()
    expectNoIncidentData()
    expect(screen.getByRole('note')).toHaveTextContent('Simulated data.')
  })

  it('offline: explains the data is unconfirmed, shows no counts, and Retry calls retry()', async () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'offline' }))
    render(<IncidentDashboard />)

    expect(screen.getByRole('status')).toHaveTextContent(
      "Incident data couldn't be confirmed with the server."
    )
    expect(stat('Total incidents')).toBe('—Not available yet')
    expectNoIncidentData()

    // Recovery comes before the unavailable statistics (Retry stays near the top on a phone).
    const retryButton = screen.getByRole('button', { name: 'Retry' })
    const stats = screen.getAllByRole('term')[0]!.closest('dl')!
    expect(
      retryButton.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    await userEvent.click(retryButton)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('stale: keeps the counts and queue, with a neutral cached-data warning and Retry', async () => {
    showDashboard(seededSummary(ALICE, ['INC-001']), { status: 'stale' })

    expect(
      screen
        .getByText('Showing cached data; information may be out of date.')
        .closest('[role=status]')
    ).toBeInTheDocument()
    expect(statValues()).toEqual({ total: '50', awaiting: '49', reviewed: '1' })
    expect(tableRows()).toHaveLength(50)

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('ready: no cached-data warning', () => {
    showDashboard(seededSummary(ALICE))
    expect(screen.queryByText(/cached data/)).not.toBeInTheDocument()
  })

  it.each([
    ['permission-denied', 'Access to your incident records was denied.'],
    ['unavailable', "Can't reach the incident database."],
    ['internal', 'Incident data could not be loaded.'],
  ])('error %s: an alert, no counts or queue, and Retry', async (code, message) => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'error', error: firestoreError(code) }))
    render(<IncidentDashboard />)

    expect(screen.getByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('term')).not.toBeInTheDocument()
    expectNoIncidentData()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('permission-denied links to sign-in and never shows the raw error text', () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'error', error: firestoreError('permission-denied') }))
    render(<IncidentDashboard />)

    expect(screen.getByRole('link', { name: 'sign in again' })).toHaveAttribute(
      'href',
      '/auth/signin'
    )
    expect(screen.queryByText('permission-denied')).not.toBeInTheDocument()
  })

  it('permission-denied does not claim the session has expired', () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'error', error: firestoreError('permission-denied') }))
    render(<IncidentDashboard />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('The incident database refused this request for your account.')
    expect(alert).not.toHaveTextContent(/expired/i)
  })

  it('an internal client failure suggests reloading and hides the SDK message', () => {
    signedInAs(ALICE)
    hookReturns(
      dashboardState({
        status: 'error',
        error: { code: 'internal', message: 'INTERNAL ASSERTION FAILED (ID: b815)' },
      })
    )
    render(<IncidentDashboard />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('reload the page')
    expect(alert).not.toHaveTextContent(/ASSERTION|b815/)
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

describe('IncidentDashboard — simulated-data integrity', () => {
  it('a non-simulated record blocks the whole dashboard: alert only, nothing labelled simulated', async () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'integrity-error', integrityErrorCount: 1 }))
    render(<IncidentDashboard />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      "1 incident record is not marked as simulated, so the queue can't be shown."
    )
    expectNoIncidentData()
    expect(screen.queryByRole('term')).not.toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText(/Simulated data/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('reports several rejected records in the plural', () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ status: 'integrity-error', integrityErrorCount: 3 }))
    render(<IncidentDashboard />)
    expect(screen.getByRole('alert')).toHaveTextContent('3 incident records are not marked')
  })

  it('every other state carries the simulated-data notice and header label', () => {
    showDashboard(seededSummary(ALICE))
    expect(screen.getByRole('note')).toHaveTextContent(
      'These incidents are fictional and for demonstration only. They are not real emergencies'
    )
    expect(screen.getByText('Simulated data')).toBeInTheDocument()
  })
})

// ── The 50-incident queue ────────────────────────────────────────────────────

describe('IncidentDashboard — 50 seeded incidents', () => {
  it('shows the summary counts from the hook: 50 / 50 / 0', () => {
    showDashboard(seededSummary(ALICE))
    expect(statValues()).toEqual({ total: '50', awaiting: '50', reviewed: '0' })
    expect(screen.getAllByRole('term')[0]?.closest('dl')).toHaveAttribute('aria-busy', 'false')
  })

  it('after one REVIEWED decision: 50 / 49 / 1', () => {
    showDashboard(seededSummary(ALICE, ['INC-007']))
    expect(statValues()).toEqual({ total: '50', awaiting: '49', reviewed: '1' })
  })

  it('renders all 50 incidents in the table and in the card list, newest report first', () => {
    const summary = seededSummary(ALICE, ['INC-007'])
    showDashboard(summary)

    expect(tableRows()).toHaveLength(50)
    expect(within(cardList()).getAllByRole('listitem')).toHaveLength(50)

    const shownCodes = tableRows().map((row) => within(row).getAllByRole('link')[0]?.textContent)
    expect(shownCodes).toEqual(shownOrder(summary).map((row) => row.incidentCode))
    expect(shownCodes[0]).toBe('INC-049') // reported 20 Oct, 8:12 pm
    expect(shownCodes.at(-1)).toBe('INC-007') // reported 1 Sep, 7:22 am (reviewed, still in time order)
    const cardCodes = within(cardList())
      .getAllByRole('link')
      .map((link) => link.textContent)
    expect(cardCodes).toEqual(shownCodes)
  })

  it('shows every field of a row with readable labels', () => {
    const summary = seededSummary(ALICE)
    showDashboard(summary)
    const incident = summary.rows.find((row) => row.incidentCode === 'INC-001')!

    const row = within(table()).getByRole('link', { name: 'Open incident INC-001' }).closest('tr')!
    const cells = within(row)
    expect(cells.getByText(incident.deviceId!)).toBeInTheDocument()
    expect(row).toHaveTextContent(`${incident.suburb} ${incident.postcode}`)
    expect(
      cells.getByText(incident.status === 'OFFLINE' ? 'Pendant offline' : 'Pendant silent')
    ).toBeInTheDocument()
    expect(cells.getByText(CAUSE_CATEGORY_LABELS[incident.causeCategory!])).toBeInTheDocument()
    expect(cells.getByText('Awaiting review')).toBeInTheDocument()

    // Reported, then last signal — both in Melbourne time with the zone.
    const [reported, lastSignal] = row.querySelectorAll('time')
    expect(reported).toHaveAttribute('dateTime', '2026-09-04T08:23:40.000Z')
    expect(reported).toHaveTextContent('Fri, 4 Sept 2026, 6:23 pm AEST')
    expect(reported).toHaveTextContent(formatMelbourneDateTime(incident.reportedAt!))
    expect(lastSignal).toHaveAttribute('dateTime', incident.lastSignalAt!.toISOString())
    expect(lastSignal).toHaveTextContent('Fri, 4 Sept 2026, 5:48 pm AEST')
    expect(row).toHaveTextContent('Review')
  })

  it('shows both review statuses, both connectivity statuses and all five cause labels', () => {
    showDashboard(seededSummary(ALICE, ['INC-002']))
    const t = within(table())

    expect(t.getAllByText('Awaiting review')).toHaveLength(49)
    expect(t.getAllByText('Reviewed')).toHaveLength(1)
    expect(t.getAllByText('Pendant offline')).toHaveLength(36)
    expect(t.getAllByText('Pendant silent')).toHaveLength(14)
    for (const label of Object.values(CAUSE_CATEGORY_LABELS)) {
      expect(t.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('gives each incident exactly one named link per layout, to its encoded detail URL', () => {
    const summary = seededSummary(ALICE)
    showDashboard(summary)

    for (const container of [table(), cardList()]) {
      const links = within(container).getAllByRole('link')
      expect(links).toHaveLength(50)
      links.forEach((link, i) => {
        const incident = shownOrder(summary)[i]!
        expect(link).toHaveAccessibleName(`Open incident ${incident.incidentCode}`)
        expect(link).toHaveAttribute(
          'href',
          `/dashboard/incidents/${encodeURIComponent(incident.id)}`
        )
      })
    }
  })

  it('encodes characters that are not safe in a URL path', () => {
    const [first] = seededRows(ALICE)
    showDashboard(summaryFor([{ ...first!, id: 'odd id/with?chars#' }], ALICE))

    expect(within(table()).getByRole('link')).toHaveAttribute(
      'href',
      '/dashboard/incidents/odd%20id%2Fwith%3Fchars%23'
    )
  })

  it('has no control for creating incidents', () => {
    showDashboard(seededSummary(ALICE))
    expect(screen.queryByRole('button', { name: /create|add|new/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /create|add|new/i })).not.toBeInTheDocument()
  })
})

// ── Tabs ─────────────────────────────────────────────────────────────────────

describe('IncidentDashboard — review-status tabs', () => {
  const REVIEWED = ['INC-003', 'INC-020']

  function tab(name: RegExp) {
    return screen.getByRole('tab', { name })
  }

  it('labels each tab with its count, with All selected first', () => {
    showDashboard(seededSummary(ALICE, REVIEWED))

    expect(screen.getByRole('tablist')).toHaveAccessibleName('Filter incidents by review status')
    expect(tab(/^All/)).toHaveTextContent('All50')
    expect(tab(/^Awaiting review/)).toHaveTextContent('Awaiting review48')
    expect(tab(/^Reviewed/)).toHaveTextContent('Reviewed2')
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/^All/)
  })

  it('clicking a tab filters the queue; the summary cards keep the overall counts', async () => {
    showDashboard(seededSummary(ALICE, REVIEWED))

    await userEvent.click(tab(/^Reviewed/))
    expect(tab(/^Reviewed/)).toHaveAttribute('aria-selected', 'true')
    expect(tab(/^All/)).toHaveAttribute('aria-selected', 'false')
    expect(tableRows()).toHaveLength(2)
    expect(within(table()).getAllByText('Reviewed')).toHaveLength(2)
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/^Reviewed/)

    await userEvent.click(tab(/^Awaiting review/))
    expect(tableRows()).toHaveLength(48)
    expect(within(table()).queryByText('Reviewed')).not.toBeInTheDocument()

    expect(statValues()).toEqual({ total: '50', awaiting: '48', reviewed: '2' })
  })

  it('keyboard: only the selected tab is tabbable; Arrow keys wrap, Home and End jump', async () => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE, REVIEWED))

    expect(tab(/^All/)).toHaveAttribute('tabindex', '0')
    expect(tab(/^Reviewed/)).toHaveAttribute('tabindex', '-1')

    tab(/^All/).focus()
    await user.keyboard('{ArrowRight}')
    expect(tab(/^Awaiting review/)).toHaveFocus()
    expect(tab(/^Awaiting review/)).toHaveAttribute('aria-selected', 'true')
    expect(tableRows()).toHaveLength(48)

    await user.keyboard('{End}')
    expect(tab(/^Reviewed/)).toHaveFocus()
    expect(tableRows()).toHaveLength(2)

    await user.keyboard('{ArrowRight}') // wraps to the first tab
    expect(tab(/^All/)).toHaveFocus()

    await user.keyboard('{ArrowLeft}') // wraps to the last tab
    expect(tab(/^Reviewed/)).toHaveFocus()

    await user.keyboard('{Home}')
    expect(tab(/^All/)).toHaveFocus()
    expect(tab(/^All/)).toHaveAttribute('tabindex', '0')
    expect(tableRows()).toHaveLength(50)
  })

  it('fits the three tabs across a narrow phone without sideways scrolling', () => {
    showDashboard(seededSummary(ALICE, REVIEWED))
    const tablist = screen.getByRole('tablist')
    expect(tablist).toHaveClass('grid', 'grid-cols-3', 'sm:flex')
    expect(tablist.parentElement).not.toHaveClass('overflow-x-auto')
  })

  it('an empty tab explains itself', async () => {
    showDashboard(seededSummary(ALICE))
    await userEvent.click(tab(/^Reviewed/))

    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('No reviewed incidents yet.')).toBeInTheDocument()
  })

  it('an empty Awaiting review tab explains itself', async () => {
    const rows = seededRows(ALICE)
    showDashboard(
      summaryFor(
        rows,
        ALICE,
        rows.map((row) => row.incidentCode!)
      )
    )
    await userEvent.click(tab(/^Awaiting review/))

    expect(screen.getByText('No incidents are awaiting review.')).toBeInTheDocument()
  })
})

// ── Empty dataset and malformed fields ───────────────────────────────────────

describe('IncidentDashboard — empty dataset', () => {
  it('a server-confirmed empty collection shows setup guidance, 0 / 0 / 0, and no buttons', () => {
    showDashboard(summaryFor([], ALICE))

    expect(screen.getByText('No incidents are assigned to this account')).toBeInTheDocument()
    expect(screen.getByText(/Ask the administrator to run the incident setup/)).toBeInTheDocument()
    expect(statValues()).toEqual({ total: '0', awaiting: '0', reviewed: '0' })
    expectNoIncidentData()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })
})

describe('IncidentDashboard — malformed fields', () => {
  it('shows fallback labels and a data-quality warning, and still links the row', () => {
    const parsed = parseIncident('alice-uid_INC-900', {
      isSimulated: true,
      incidentCode: 'INC-900',
      deviceId: 42,
      suburb: '',
      postcode: '3000',
      status: 'BROKEN',
      causeCategory: 'SOLAR_FLARE',
      lastSignalAt: 'yesterday',
    })
    if (!parsed.ok) throw new Error('expected the record to be accepted')
    const [good] = seededRows(ALICE)
    showDashboard(summaryFor([parsed.row, good!], ALICE), { dataIssueCount: 1 })

    expect(
      screen.getByText('1 incident record has missing or unexpected fields.')
    ).toBeInTheDocument()

    const row = within(table()).getByRole('link', { name: 'Open incident INC-900' }).closest('tr')!
    const cells = within(row)
    expect(cells.getByText('Unknown')).toBeInTheDocument()
    expect(cells.getByText('Unrecognised category')).toBeInTheDocument()
    // The row header holds the code and device; then location, pendant, cause,
    // reported with the last signal beneath, review and the open cue.
    expect(cells.getByRole('rowheader')).toHaveTextContent('INC-900—Not recorded') // device: "—" on screen, words for screen readers
    const [location, , , times] = cells.getAllByRole('cell')
    expect(location).toHaveTextContent('—Not recorded 3000')
    expect(times).toHaveTextContent(/^Not recordedLast signal Not recorded$/)
    expect(row.querySelector('time')).toBeNull()
  })

  it('no data-quality warning when every field is valid', () => {
    showDashboard(seededSummary(ALICE))
    expect(screen.queryByText(/missing or unexpected fields/)).not.toBeInTheDocument()
  })
})

// ── Account switching ────────────────────────────────────────────────────────

describe('IncidentDashboard — account switching', () => {
  it("never shows the previous owner's incidents or counts after switching account", () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ ownerUid: ALICE, summary: seededSummary(ALICE, ['INC-001']) }))
    const { rerender } = render(<IncidentDashboard />)
    expect(stat('Reviewed')).toBe('1')

    // Simulate a hook that still holds Alice's data when Bob becomes the user.
    signedInAs(BOB)
    hookReturns(dashboardState({ ownerUid: ALICE, summary: seededSummary(ALICE, ['INC-001']) }))
    rerender(<IncidentDashboard />)

    expect(useIncidentDashboard).toHaveBeenLastCalledWith(BOB)
    expect(screen.getByText('Loading incidents…')).toBeInTheDocument()
    expect(stat('Total incidents')).toBe('—Not available yet')
    expectNoIncidentData()
  })

  it("shows the new owner's own data once the hook provides it, with the tab reset", async () => {
    signedInAs(ALICE)
    hookReturns(dashboardState({ ownerUid: ALICE, summary: seededSummary(ALICE, ['INC-001']) }))
    const { rerender } = render(<IncidentDashboard />)
    await userEvent.click(screen.getByRole('tab', { name: /^Reviewed/ }))

    signedInAs(BOB)
    hookReturns(dashboardState({ ownerUid: BOB, summary: seededSummary(BOB) }))
    rerender(<IncidentDashboard />)

    expect(screen.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true')
    for (const link of within(table()).getAllByRole('link')) {
      expect(link.getAttribute('href')).toContain(encodeURIComponent(`${BOB}_`))
      expect(link.getAttribute('href')).not.toContain(ALICE)
    }
  })
})

// ── Phase 6: search, filters and sorting ─────────────────────────────────────

describe('IncidentDashboard — search, filters and sorting (Phase 6)', () => {
  const searchBox = () => screen.getByRole('searchbox', { name: 'Search' })
  const connectivity = () => screen.getByRole('combobox', { name: 'Pendant connectivity' })
  const sortBy = () => screen.getByRole('combobox', { name: 'Sort by' })
  const from = () => screen.getByLabelText('Reported from')
  const to = () => screen.getByLabelText('Reported to')
  const shownCodes = () =>
    tableRows().map((row) => within(row).getAllByRole('link')[0]?.textContent ?? '')
  const resultLine = () =>
    screen
      .getAllByRole('status')
      .find((el) => /incidents? (match|\.)|Showing all/.test(el.textContent ?? ''))
  const setDates = (fromValue: string, toValue: string) => {
    fireEvent.change(from(), { target: { value: fromValue } })
    fireEvent.change(to(), { target: { value: toValue } })
  }

  it('starts unfiltered: all 50 rows, the full count, Clear filters disabled', () => {
    showDashboard(seededSummary(ALICE))
    expect(tableRows()).toHaveLength(50)
    expect(resultLine()).toHaveTextContent('Showing all 50 incidents.')
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeDisabled()
    expect(sortBy()).toHaveValue('REPORTED_DESC')
  })

  it.each([
    ['suburb, any case', 'BALLARAT', ['INC-001']],
    ['postcode', '3550', ['INC-002']],
    ['incident code without the hyphen, padded with spaces', '   inc005  ', ['INC-005']],
    ['several words must all match', 'lakes   3909', ['INC-018']],
  ])('searches by %s', async (_label, query, expected) => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE))
    await user.type(searchBox(), query)
    expect(shownCodes()).toEqual(expected)
    expect(resultLine()).toHaveTextContent(`${expected.length} of 50 incidents match your filters.`)
  })

  it('searches by device ID', async () => {
    const user = userEvent.setup()
    const summary = seededSummary(ALICE)
    showDashboard(summary)
    const device = summary.rows.find((row) => row.incidentCode === 'INC-010')!.deviceId!
    await user.type(searchBox(), device.toLowerCase())
    expect(shownCodes()).toEqual(['INC-010'])
  })

  it('filters by pendant connectivity without changing the global counts', async () => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE, ['INC-006']))
    await user.selectOptions(connectivity(), 'SILENT')

    expect(tableRows()).toHaveLength(14)
    expect(within(table()).getAllByText('Pendant silent')).toHaveLength(14)
    expect(within(table()).queryByText('Pendant offline')).toBeNull()
    expect(statValues()).toEqual({ total: '50', awaiting: '49', reviewed: '1' })
    expect(screen.getByRole('tab', { name: /^All/ })).toHaveTextContent('50')
  })

  it('date range distinguishes September from October (25 each), inclusive Melbourne dates', () => {
    showDashboard(seededSummary(ALICE))
    setDates('2026-09-01', '2026-09-30')
    expect(tableRows()).toHaveLength(25)
    setDates('2026-10-01', '2026-10-20')
    expect(tableRows()).toHaveLength(25)
  })

  it('date range isolates the fictional flood advisory period (21–25 Sep)', () => {
    showDashboard(seededSummary(ALICE))
    setDates('2026-09-21', '2026-09-25')
    expect(shownCodes()).toEqual(['INC-044', 'INC-029', 'INC-025', 'INC-004', 'INC-012'])
    expect(resultLine()).toHaveTextContent('5 of 50 incidents match your filters.')
  })

  it('a one-day range includes incidents on that Melbourne date only, at either end of the day', () => {
    showDashboard(seededSummary(ALICE))
    // 4 Oct: INC-036, reported 3:09 am AEDT — 3 Oct in UTC.
    setDates('2026-10-04', '2026-10-04')
    expect(shownCodes()).toEqual(['INC-036'])
    // 20 Oct: INC-006 (9:30 am) and INC-049 (8:12 pm AEDT, 09:12 UTC).
    setDates('2026-10-20', '2026-10-20')
    expect(shownCodes()).toEqual(['INC-049', 'INC-006'])
  })

  it('combines filters with the review tabs: silent pendants in October, then only reviewed ones', async () => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE, ['INC-008', 'INC-001']))
    await user.selectOptions(connectivity(), 'SILENT')
    setDates('2026-10-01', '2026-10-31')
    expect(shownCodes()).toEqual([
      'INC-006',
      'INC-048',
      'INC-045',
      'INC-008',
      'INC-041',
      'INC-034',
      'INC-039',
    ])

    await user.click(screen.getByRole('tab', { name: /^Reviewed/ }))
    expect(shownCodes()).toEqual(['INC-008'])
    expect(resultLine()).toHaveTextContent('1 of 2 reviewed incidents match your filters.')
  })

  it('an inverted date range explains itself and shows no incidents', () => {
    showDashboard(seededSummary(ALICE))
    setDates('2026-10-10', '2026-09-10')
    expect(screen.getByRole('alert')).toHaveTextContent('“Reported from” is after “Reported to”')
    expect(from()).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText('No incidents match your search and filters.')).toBeInTheDocument()
  })

  it('a search with no matches offers to clear the filters, which restores everything', async () => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE))
    await user.type(searchBox(), 'nowhere')
    await user.selectOptions(connectivity(), 'OFFLINE')

    expect(screen.getByText('No incidents match your search and filters.')).toBeInTheDocument()
    expect(resultLine()).toHaveTextContent('0 of 50 incidents match your filters.')
    const clearButtons = screen.getAllByRole('button', { name: 'Clear filters' })
    expect(clearButtons).toHaveLength(2)
    await user.click(clearButtons[1]!)

    expect(tableRows()).toHaveLength(50)
    expect(searchBox()).toHaveValue('')
    expect(connectivity()).toHaveValue('ALL')
  })

  it.each([
    ['REPORTED_ASC', 'INC-007', 'INC-049'],
    ['SIGNAL_DESC', 'INC-049', 'INC-007'],
    ['SIGNAL_ASC', 'INC-007', 'INC-049'],
    ['CODE_ASC', 'INC-001', 'INC-050'],
    ['LOCATION_ASC', 'INC-024', 'INC-032'], // Ararat … Wonthaggi
  ])('sorts by %s', async (sort, first, last) => {
    const user = userEvent.setup()
    showDashboard(seededSummary(ALICE))
    await user.selectOptions(sortBy(), sort)
    expect(shownCodes()[0]).toBe(first)
    expect(shownCodes().at(-1)).toBe(last)
    expect(new Set(shownCodes()).size).toBe(50)
  })

  it('remembers the tab, filters and sort for the same operator when the queue is reopened', async () => {
    const user = userEvent.setup()
    signedInAs(ALICE)
    hookReturns(dashboardState({ summary: seededSummary(ALICE, ['INC-001']) }))
    const first = render(<IncidentDashboard />)
    await user.type(searchBox(), 'ballarat')
    await user.selectOptions(sortBy(), 'CODE_ASC')
    await user.click(screen.getByRole('tab', { name: /^Reviewed/ }))
    first.unmount()

    render(<IncidentDashboard />)
    expect(searchBox()).toHaveValue('ballarat')
    expect(sortBy()).toHaveValue('CODE_ASC')
    expect(screen.getByRole('tab', { name: /^Reviewed/ })).toHaveAttribute('aria-selected', 'true')
    expect(shownCodes()).toEqual(['INC-001'])
  })

  it('every control has a visible label and the result count is announced politely', () => {
    showDashboard(seededSummary(ALICE))
    for (const control of [searchBox(), connectivity(), from(), to(), sortBy()]) {
      expect(control).toHaveAccessibleName()
    }
    expect(resultLine()).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('region', { name: 'Search and filter incidents' })).toBeInTheDocument()
  })
})

describe('IncidentDashboard — version 1 (legacy) incidents before migration', () => {
  function legacyRows(owner: string): IncidentRow[] {
    return buildSeedIncidents(owner, NOW).map(({ id, data }) => {
      const { reportedAt: _reported, ...v1 } = data
      const parsed = parseIncident(id, {
        ...v1,
        _schemaVersion: 1,
        lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
        createdAt: Timestamp.fromDate(data.createdAt),
      })
      if (!parsed.ok) throw new Error(`legacy record ${id} was rejected`)
      return parsed.row
    })
  }

  it('lists every legacy record without a data-quality warning, saying the report time is not recorded', () => {
    showDashboard(summaryFor(legacyRows(ALICE), ALICE))
    expect(tableRows()).toHaveLength(50)
    expect(statValues()).toEqual({ total: '50', awaiting: '50', reviewed: '0' })
    expect(screen.queryByText(/missing or unexpected fields/)).toBeNull()
    expect(screen.getByText('50 incidents are in the earlier data format.')).toBeInTheDocument()
    expect(within(table()).getAllByText('Not recorded in this earlier-format record')).toHaveLength(
      50
    )
  })

  it('a date filter leaves legacy records out instead of guessing a date', () => {
    const rows = [...legacyRows(ALICE).slice(0, 2), ...seededRows(ALICE).slice(2)]
    showDashboard(summaryFor(rows, ALICE))
    fireEvent.change(screen.getByLabelText('Reported from'), { target: { value: '2026-09-01' } })
    expect(tableRows()).toHaveLength(48)
    expect(screen.queryByRole('link', { name: 'Open incident INC-001' })).toBeNull()
  })
})
