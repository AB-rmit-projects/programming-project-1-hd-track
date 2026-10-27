import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDoc, onSnapshot, serverTimestamp, Timestamp } from 'firebase/firestore'
import { toast } from 'sonner'
import { IncidentDetail } from '@/features/incidents/components/IncidentDetail'
import {
  DECISION_UNAVAILABLE_TEXT,
  WAITING_TEXT,
} from '@/features/incidents/components/DecisionForm'
import { SERVER_CONFIRMATION_TIMEOUT_MS } from '@/features/incidents/hooks/useIncidentDashboard'
import { SLOW_SAVE_AFTER_MS } from '@/features/incidents/hooks/useDecisionSubmission'
import {
  CAUSE_CATEGORY_LABELS,
  INCIDENT_STATUS_LABELS,
  NOT_IN_DATASET_LABELS,
} from '@/features/incidents/labels'
import type { Incident } from '@/types/firestore'
import { useAuth } from '@/hooks/useAuth'
import { formatMelbourneDateTime } from '@/lib/melbourneTime'
import type { AuthContextValue } from '@/types/auth'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

// The detail page end to end in the browser environment, with the real CP3
// and CP4 hooks, write adapter and validation. Only the Firestore SDK
// (listeners and addDoc), auth and the toast are mocked: tests push snapshots
// into the listeners and settle each write by hand, as the server would.

interface Target {
  path: string
  constraints?: unknown[]
}
interface Listener {
  target: Target
  next: (snapshot: unknown) => void
  error: (error: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
interface PendingWrite {
  data: Record<string, unknown>
  settled: boolean
  accept: (id: string) => Promise<void>
  refuse: (error: unknown) => Promise<void>
}

const fake = vi.hoisted(() => ({ listeners: [] as Listener[], writes: [] as PendingWrite[] }))

vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  collection: vi.fn((_db: unknown, path: string) => ({ path })),
  doc: vi.fn((ref: { path: string }, id: string) => ({ path: `${ref.path}/${id}`, id })),
  where: vi.fn((field: string, op: string, value: unknown) => ({ where: [field, op, value] })),
  orderBy: vi.fn((field: string, direction: string) => ({ orderBy: [field, direction] })),
  query: vi.fn((ref: { path: string }, ...constraints: unknown[]) => ({
    path: ref.path,
    constraints,
  })),
  onSnapshot: vi.fn(
    (target: Target, _options: unknown, next: Listener['next'], error: Listener['error']) => {
      const unsubscribe = vi.fn()
      fake.listeners.push({ target, next, error, unsubscribe })
      return unsubscribe
    }
  ),
  addDoc: vi.fn(
    (_ref: unknown, data: Record<string, unknown>) =>
      new Promise((resolve, reject) => {
        const write: PendingWrite = {
          data,
          settled: false,
          accept: (id) =>
            act(async () => {
              write.settled = true
              resolve({ id })
            }),
          refuse: (error) =>
            act(async () => {
              write.settled = true
              reject(error)
            }),
        }
        fake.writes.push(write)
      })
  ),
}))
vi.mock('@/lib/firebase/client', () => ({ getClientDb: vi.fn(() => ({ fake: 'db' })) }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ALICE = 'alice-uid'
const BOB = 'bob-uid'
const NOW = new Date('2026-10-21T00:00:00.000Z')
const NOTE = 'Checked the simulated outage evidence.'
const RAW = 'RAW SDK TEXT'

function storedIncident(owner: string, index = 0) {
  const record = buildSeedIncidents(owner, NOW)[index]!
  return {
    id: record.id,
    seed: record.data,
    data: {
      ...record.data,
      reportedAt: Timestamp.fromDate(record.data.reportedAt),
      lastSignalAt: Timestamp.fromDate(record.data.lastSignalAt),
      createdAt: Timestamp.fromDate(record.data.createdAt),
    } as Record<string, unknown>,
  }
}

const A1 = storedIncident(ALICE, 0)
const A2 = storedIncident(ALICE, 1)
const B1 = storedIncident(BOB, 0)

let logSequence = 0
function log(actionType: string, minute: number, overrides: Record<string, unknown> = {}) {
  const stored = {
    ownerUid: ALICE,
    incidentId: A1.id,
    actionType,
    note: NOTE,
    createdAt: Timestamp.fromDate(new Date(Date.UTC(2026, 9, 24, 1, minute))),
    _schemaVersion: 1,
    ...overrides,
  }
  return {
    id: `log-${++logSequence}`,
    data: () => stored,
    metadata: { hasPendingWrites: false, fromCache: false },
  }
}
type FakeLog = ReturnType<typeof log>

function pending(entry: FakeLog): FakeLog {
  return { ...entry, metadata: { hasPendingWrites: true, fromCache: false } }
}

function firestoreError(code: string) {
  return Object.assign(new Error(`${RAW} ${code}`), { name: 'FirebaseError', code })
}

function listenerFor(kind: 'incident' | 'history'): Listener {
  const found = fake.listeners
    .filter((l) =>
      kind === 'incident' ? l.target.path.startsWith('incidents/') : l.target.path === 'actionLogs'
    )
    .at(-1)
  if (!found) throw new Error(`no ${kind} listener`)
  return found
}

function pushIncident(
  incident: { id: string; data: Record<string, unknown> | undefined },
  fromCache = false
) {
  act(() =>
    listenerFor('incident').next({
      id: incident.id,
      exists: () => incident.data !== undefined,
      data: () => incident.data,
      metadata: { fromCache, hasPendingWrites: false },
    })
  )
}

function pushHistory(docs: FakeLog[], fromCache = false) {
  act(() =>
    listenerFor('history').next({
      docs,
      empty: docs.length === 0,
      metadata: { fromCache, hasPendingWrites: docs.some((d) => d.metadata.hasPendingWrites) },
    })
  )
}

function confirmBoth(incident = A1, docs: FakeLog[] = []) {
  pushIncident(incident)
  pushHistory(docs)
}

function signedInAs(uid: string | null, { loading = false } = {}) {
  vi.mocked(useAuth).mockReturnValue({
    user: uid ? ({ uid } as AuthContextValue['user']) : null,
    profile: null,
    loading,
    signInWithEmail: vi.fn(),
    signUpWithEmail: vi.fn(),
    signInWithGoogle: vi.fn(),
    signOut: vi.fn(),
    confirmSession: vi.fn(),
  })
}

function showDetail(
  incidentId = A1.id,
  uid: string | null = ALICE,
  options: { strict?: boolean } = {}
) {
  signedInAs(uid)
  return render(<IncidentDetail incidentId={incidentId} />, { reactStrictMode: options.strict })
}

/** The value shown next to a fact's label. */
function fact(label: string) {
  const term = screen.getByText(label, { selector: 'dt' })
  return term.nextElementSibling as HTMLElement
}

/** The badges beside the page heading. */
const headerBadges = () => within(screen.getByRole('heading', { level: 1 }).parentElement!)
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) })
const rationale = () => screen.getByRole('textbox', { name: /Rationale/ })
const saveButton = () =>
  screen.getByRole('button', { name: /Save decision|Saving…|Waiting for confirmation…/ })
const statusRegion = () =>
  screen.getAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite')!

let user: ReturnType<typeof userEvent.setup>

/** Picks a decision and enters a rationale (paste keeps long text fast). */
async function fill(actionType: string | null, note: string) {
  if (actionType) await user.click(radio(actionType))
  await user.clear(rationale())
  if (note) {
    await user.click(rationale())
    await user.paste(note)
  }
}

beforeEach(() => {
  fake.listeners.length = 0
  fake.writes.length = 0
  logSequence = 0
  vi.clearAllMocks()
  // shouldAdvanceTime: Testing Library's async wrapper (used by user-event)
  // waits on a real setTimeout(0), which plain Vitest fake timers never fire.
  // Tests still jump to the 10 s / 15 s thresholds with advanceTimersByTime.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
})

afterEach(async () => {
  // Release the module-level write lock before the next test.
  for (const write of fake.writes.filter((w) => !w.settled))
    await write.refuse(new Error('test cleanup'))
  vi.useRealTimers()
})

// ── Session ──────────────────────────────────────────────────────────────────

describe('IncidentDetail — session', () => {
  it('while the session is being checked, nothing is subscribed', () => {
    signedInAs(null, { loading: true })
    render(<IncidentDetail incidentId={A1.id} />)
    expect(screen.getByText('Checking your session…')).toBeInTheDocument()
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('signed out: a sign-in prompt, no listener, no form', () => {
    showDetail(A1.id, null)
    expect(screen.getByText('Your session has ended.')).toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(onSnapshot).not.toHaveBeenCalled()
  })

  it('signed in: the incident and its owner-scoped history are subscribed', () => {
    showDetail()
    expect(onSnapshot).toHaveBeenCalledTimes(2)
    expect(listenerFor('incident').target.path).toBe(`incidents/${A1.id}`)
    expect(listenerFor('history').target.constraints?.[0]).toEqual({
      where: ['ownerUid', '==', ALICE],
    })
  })

  it('an invalid ID reaching the container shows "Invalid incident link" and subscribes to nothing', () => {
    showDetail('../escape')
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid incident link')
    expect(onSnapshot).not.toHaveBeenCalled()
  })
})

// ── Incident details ─────────────────────────────────────────────────────────

describe('IncidentDetail — incident details', () => {
  it('loading: no details, no form, no "no decisions" claim', () => {
    showDetail()
    expect(screen.getByText('Loading incident…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument()
    expect(screen.queryByText('No decisions recorded yet.')).not.toBeInTheDocument()
  })

  it('a cached snapshot alone shows nothing of the incident', () => {
    showDetail()
    pushIncident(A1, true)
    expect(screen.queryByText(A1.seed.deviceId)).not.toBeInTheDocument()
    expect(screen.getByText('Loading incident…')).toBeInTheDocument()
  })

  it('shows every available field once the server confirms the incident', () => {
    showDetail()
    confirmBoth()
    const seed = A1.seed

    expect(screen.getByRole('heading', { level: 1, name: seed.incidentCode })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to incident queue' })).toHaveAttribute(
      'href',
      '/dashboard'
    )
    expect(fact('Incident code')).toHaveTextContent(seed.incidentCode)
    expect(fact('Device ID')).toHaveTextContent(seed.deviceId)
    expect(fact('Pendant connectivity')).toHaveTextContent(
      INCIDENT_STATUS_LABELS[seed.status as Incident['status']]
    )
    expect(fact('Location')).toHaveTextContent(`${seed.suburb}, VIC ${seed.postcode}`)
    const reported = within(fact('Reported (simulated)')).getByText(
      formatMelbourneDateTime(seed.reportedAt)
    )
    expect(reported.tagName).toBe('TIME')
    expect(reported).toHaveAttribute('dateTime', seed.reportedAt.toISOString())
    const lastSignal = within(fact('Last signal (simulated)')).getByText(
      formatMelbourneDateTime(seed.lastSignalAt)
    )
    expect(lastSignal.tagName).toBe('TIME')
    expect(lastSignal).toHaveAttribute('dateTime', seed.lastSignalAt.toISOString())
    // The real record-creation time is secondary dataset metadata, not an incident fact.
    const record = screen.getByRole('region', { name: 'Dataset record' })
    expect(within(record).getByText(formatMelbourneDateTime(seed.createdAt))).toBeInTheDocument()
    expect(within(record).getByText('Version 2')).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'Incident facts' })).queryByText(
        formatMelbourneDateTime(seed.createdAt)
      )
    ).toBeNull()
    expect(screen.queryByText('Incident created')).toBeNull()
    expect(fact('Cause category')).toHaveTextContent(CAUSE_CATEGORY_LABELS[seed.causeCategory])
    expect(fact('Cause category')).toHaveTextContent('not a confirmed cause')
    expect(fact('Likely cause (interpretation)')).toHaveTextContent(seed.likelyCause)
    expect(fact('Evidence (simulated)')).toHaveTextContent(seed.evidenceSummary)
    expect(fact('Recommended action (advisory)')).toHaveTextContent(seed.recommendedAction)
    expect(fact('Confidence')).toHaveTextContent(NOT_IN_DATASET_LABELS.confidence)
    expect(screen.getByText('Simulated data')).toBeInTheDocument() // header pill
    expect(screen.getByRole('note')).toHaveTextContent('These incidents are fictional')
  })

  it('missing fields get placeholders and a data notice; nothing is filled in', () => {
    showDetail()
    const data = {
      ...A1.data,
      suburb: '',
      evidenceSummary: undefined,
      lastSignalAt: 'yesterday',
      causeCategory: 'X',
    }
    confirmBoth({ ...A1, data })

    expect(
      screen.getByText('This incident record has missing or unexpected fields.')
    ).toBeInTheDocument()
    expect(fact('Location')).toHaveTextContent(`—Not recorded, VIC ${A1.seed.postcode}`)
    expect(fact('Evidence (simulated)')).toHaveTextContent('Not recorded')
    expect(fact('Last signal (simulated)')).toHaveTextContent('Not recorded')
    expect(fact('Cause category')).toHaveTextContent('Unrecognised category')
    expect(screen.queryByText(A1.seed.suburb)).not.toBeInTheDocument()
  })

  it('a record not marked as simulated fails closed: no details, no form, no simulated label', () => {
    showDetail()
    confirmBoth({ ...A1, data: { ...A1.data, isSimulated: false } })

    expect(screen.getByRole('alert')).toHaveTextContent('not marked as simulated')
    expect(screen.queryByText(A1.seed.deviceId)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Simulated data/)).not.toBeInTheDocument()
  })

  it.each([
    [
      'refused by the rules',
      () => act(() => listenerFor('incident').error(firestoreError('permission-denied'))),
    ],
    ['confirmed missing', () => pushIncident({ id: A1.id, data: undefined })],
    ["another operator's data", () => pushIncident({ id: A1.id, data: B1.data })],
  ])('%s: the same neutral "Incident not available", with nothing leaked', (_label, deliver) => {
    showDetail()
    deliver()

    expect(screen.getByRole('alert')).toHaveTextContent('Incident not available')
    expect(
      screen.getByText("This incident doesn't exist or isn't available to your account.")
    ).toBeInTheDocument()
    expect(screen.queryByText(B1.seed.deviceId)).not.toBeInTheDocument()
    expect(screen.queryByText(A1.seed.deviceId)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save decision' })).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(RAW)
  })

  it('stale: facts stay visible with a warning, and saving is paused', () => {
    showDetail()
    confirmBoth()
    pushIncident(A1, true)

    expect(
      screen.getByText('Showing cached incident data; it may be out of date.')
    ).toBeInTheDocument()
    expect(fact('Device ID')).toHaveTextContent(A1.seed.deviceId)
    expect(saveButton()).toBeDisabled()
    expect(screen.getByText(DECISION_UNAVAILABLE_TEXT)).toBeInTheDocument()

    pushIncident(A1) // confirmed again
    expect(saveButton()).toBeEnabled()
  })

  it(`offline: after ${SERVER_CONFIRMATION_TIMEOUT_MS} ms without confirmation, no details and a retry`, async () => {
    showDetail()
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(
      screen.getByText("The incident couldn't be confirmed with the server.")
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onSnapshot).toHaveBeenCalledTimes(4)
    confirmBoth()
    expect(fact('Device ID')).toHaveTextContent(A1.seed.deviceId)
  })

  it('a listener error shows a safe message and a retry, never the SDK text', () => {
    showDetail()
    act(() => listenerFor('incident').error(firestoreError('unavailable')))
    expect(screen.getByRole('alert')).toHaveTextContent("The incident couldn't be loaded.")
    expect(screen.getByRole('alert')).toHaveTextContent("Can't reach the incident database.")
    expect(document.body).not.toHaveTextContent(RAW)
  })
})

// ── Decision form ────────────────────────────────────────────────────────────

describe('IncidentDetail — decision form validation', () => {
  it('offers exactly three decisions, in a labelled group, each selectable', async () => {
    showDetail()
    confirmBoth()
    const group = screen.getByRole('group', { name: 'Decision' })
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
    for (const name of ['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED']) {
      await user.click(radio(name))
      expect(radio(name)).toBeChecked()
    }
    expect(radio('ESCALATE')).toHaveAccessibleName(
      /no alert, notification or welfare check is sent/
    )
  })

  it('without a decision: an inline error, focus on the choices, and no write', async () => {
    showDetail()
    confirmBoth()
    await fill(null, NOTE)
    await user.click(saveButton())

    expect(screen.getByText('Choose ACKNOWLEDGE, ESCALATE or REVIEWED.')).toBeInTheDocument()
    expect(radio('ACKNOWLEDGE')).toHaveFocus()
    expect(addDoc).not.toHaveBeenCalled()
  })

  it.each([
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['only whitespace', ' \n \t '],
    ['9 characters padded with spaces', `  ${'a'.repeat(9)}  `],
    ['only no-break spaces and control characters', ' \u0001 \u0001 \u0001 \u0001 \u0001 '],
  ])(
    'a rationale of %s is refused inline, with focus on it, and no write',
    async (_label, note) => {
      showDetail()
      confirmBoth()
      await fill('REVIEWED', note)
      await user.click(saveButton())

      const error = screen.getByText('Enter between 10 and 500 characters.')
      expect(rationale()).toHaveFocus()
      expect(rationale()).toHaveAttribute('aria-invalid', 'true')
      expect(rationale().getAttribute('aria-describedby')).toContain(error.id)
      expect(addDoc).not.toHaveBeenCalled()
    }
  )

  it('without anything entered, both fields are reported and focus goes to the choices', async () => {
    showDetail()
    confirmBoth()
    await user.click(saveButton())
    expect(screen.getByText('Choose ACKNOWLEDGE, ESCALATE or REVIEWED.')).toBeInTheDocument()
    expect(screen.getByText('Enter between 10 and 500 characters.')).toBeInTheDocument()
    expect(radio('ACKNOWLEDGE')).toHaveFocus()
  })

  it.each([
    ['exactly 10 characters', 'a'.repeat(10)],
    ['exactly 500 characters', 'a'.repeat(500)],
    ['5 emoji (10 UTF-16 code units)', '\u{1F600}'.repeat(5)],
  ])('a rationale of %s is accepted and written', async (_label, note) => {
    showDetail()
    confirmBoth()
    await fill('ACKNOWLEDGE', note)
    await user.click(saveButton())
    expect(addDoc).toHaveBeenCalledTimes(1)
    expect(fake.writes[0]!.data.note).toBe(note)
  })

  it('the counter counts what will be saved: surrounding spaces are not counted', async () => {
    showDetail()
    confirmBoth()
    await fill(null, '   Checked   ')
    expect(screen.getByText('7 / 500 characters')).toBeInTheDocument()
    await fill(null, 'a'.repeat(501))
    expect(screen.getByText('501 / 500 characters — over the limit')).toBeInTheDocument()
  })

  it('editing a field hides its old error until the next attempt', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', 'short')
    await user.click(saveButton())
    expect(screen.getByText('Enter between 10 and 500 characters.')).toBeInTheDocument()

    await user.type(rationale(), ' more')
    expect(screen.queryByText('Enter between 10 and 500 characters.')).not.toBeInTheDocument()
  })
})

describe('IncidentDetail — saving a decision', () => {
  it('a valid decision is written once, with the six-field payload and the trimmed multi-line note', async () => {
    showDetail()
    confirmBoth()
    await fill('ESCALATE', '  Line one of the reason.\nLine two.  ')
    await user.click(saveButton())

    expect(addDoc).toHaveBeenCalledTimes(1)
    expect(fake.writes[0]!.data).toEqual({
      ownerUid: ALICE,
      incidentId: A1.id,
      actionType: 'ESCALATE',
      note: 'Line one of the reason.\nLine two.',
      createdAt: serverTimestamp(),
      _schemaVersion: 1,
    })
  })

  it('can be submitted from the keyboard (Enter on a choice)', async () => {
    showDetail()
    confirmBoth()
    await fill(null, NOTE)
    radio('REVIEWED').focus()
    await user.keyboard(' ')
    expect(radio('REVIEWED')).toBeChecked()
    await user.keyboard('{Enter}')
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('while saving: disabled, announced, values kept, and no success shown', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    expect(saveButton()).toBeDisabled()
    expect(saveButton()).toHaveTextContent('Saving…')
    expect(statusRegion()).toHaveTextContent('Saving your decision…')
    expect(radio('REVIEWED')).toBeChecked()
    expect(rationale()).toHaveValue(NOTE)
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('the saving state is valid HTML with a single status announcement (CP7 regression)', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    const region = statusRegion()
    expect(region).toHaveTextContent('Saving your decision…')
    // No block element inside the <p> or the <button> (React warned: "<div> cannot be a descendant of <p>").
    expect(region.querySelector('p div')).toBeNull()
    expect(saveButton().querySelector('div')).toBeNull()
    // The spinner is decorative: no second role="status" inside the live region or the button.
    expect(region.querySelector('[role="status"]')).toBeNull()
    expect(saveButton().querySelector('[role="status"]')).toBeNull()
  })

  it('double clicks and repeated Enter presses never start a second write', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.dblClick(saveButton())
    radio('REVIEWED').focus()
    await user.keyboard('{Enter}{Enter}')
    fireEvent.submit(saveButton().closest('form')!)
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it(`after ${SLOW_SAVE_AFTER_MS} ms unanswered: the waiting message, still locked, never retried`, async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS))
    expect(statusRegion()).toHaveTextContent(WAITING_TEXT)
    expect(WAITING_TEXT).toMatch(/closing or reloading the page may lose it/)
    expect(saveButton()).toHaveTextContent('Waiting for confirmation…')
    expect(saveButton()).toBeDisabled()

    act(() => vi.advanceTimersByTime(5 * 60_000))
    expect(addDoc).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument()
  })

  it('once the server accepts: confirmation, one toast, an empty form — and no invented history entry', async () => {
    showDetail()
    confirmBoth(A1, [])
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS))
    await fake.writes[0]!.accept('log-new')

    expect(statusRegion()).toHaveTextContent('Decision saved: Reviewed.')
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledWith('Decision saved: Reviewed', { id: 'log-new' })
    expect(radio('REVIEWED')).not.toBeChecked()
    expect(rationale()).toHaveValue('')
    expect(saveButton()).toBeEnabled()
    // The history still shows only what the listener has confirmed.
    expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument()

    const saved = log('REVIEWED', 30)
    pushHistory([pending(saved)])
    expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument()
    pushHistory([saved])
    expect(
      within(screen.getByRole('list', { name: 'Saved decisions, newest first' })).getAllByRole(
        'listitem'
      )
    ).toHaveLength(1)
  })

  it('a pending history snapshot never clears the form or counts as saved', async () => {
    showDetail()
    confirmBoth()
    await fill('ACKNOWLEDGE', NOTE)
    await user.click(saveButton())
    pushHistory([pending(log('ACKNOWLEDGE', 1))])

    expect(rationale()).toHaveValue(NOTE)
    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('a refused save keeps the exact decision and rationale, explains safely, and allows an explicit retry', async () => {
    showDetail()
    confirmBoth()
    const typed = '  First line of my reason.\nSecond line.  '
    await fill('ESCALATE', typed)
    await user.click(saveButton())
    await fake.writes[0]!.refuse(firestoreError('permission-denied'))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Your decision was not saved.')
    expect(alert).toHaveTextContent('The decision was refused.')
    expect(document.body).not.toHaveTextContent(RAW)
    expect(radio('ESCALATE')).toBeChecked()
    expect(rationale()).toHaveValue(typed)
    expect(addDoc).toHaveBeenCalledTimes(1)

    act(() => vi.advanceTimersByTime(60_000))
    expect(addDoc).toHaveBeenCalledTimes(1) // no automatic retry

    await user.click(saveButton())
    expect(addDoc).toHaveBeenCalledTimes(2)
    await fake.writes[1]!.accept('log-retry')
    expect(statusRegion()).toHaveTextContent('Decision saved: Escalation recorded.')
    expect(rationale()).toHaveValue('')
  })

  it('a later decision can be recorded after one is confirmed', async () => {
    showDetail()
    confirmBoth()
    await fill('ACKNOWLEDGE', NOTE)
    await user.click(saveButton())
    await fake.writes[0]!.accept('log-1')
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())
    expect(addDoc).toHaveBeenCalledTimes(2)
  })

  it('a stale incident blocks a new decision; nothing is written', () => {
    showDetail()
    confirmBoth()
    pushIncident(A1, true)
    fireEvent.submit(saveButton().closest('form')!)
    expect(addDoc).not.toHaveBeenCalled()
  })

  it('a write already in progress stays locked and visible when the incident then goes stale', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())
    pushIncident(A1, true)
    act(() => vi.advanceTimersByTime(SLOW_SAVE_AFTER_MS))

    expect(statusRegion()).toHaveTextContent(WAITING_TEXT)
    expect(saveButton()).toBeDisabled()
    expect(screen.queryByText(DECISION_UNAVAILABLE_TEXT)).not.toBeInTheDocument()
    await fake.writes[0]!.accept('log-1')
    expect(statusRegion()).toHaveTextContent('Decision saved')
  })

  it('a write in progress stays visible even when the incident view fails afterwards', async () => {
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())
    act(() => listenerFor('incident').error(firestoreError('unavailable')))

    expect(screen.getByRole('alert')).toHaveTextContent("The incident couldn't be loaded.")
    const region = screen.getByRole('region', { name: 'Your decision' })
    expect(region).toHaveTextContent('Saving your decision…')
    // CP7: without the form, it says what this is and that no new decision can start.
    expect(
      within(region).getByRole('heading', { level: 2, name: 'Your decision' })
    ).toBeInTheDocument()
    expect(region).toHaveTextContent("You can't record another one until the server confirms it.")
  })
})

describe('IncidentDetail — already-reviewed incidents', () => {
  it('a confirmed REVIEWED history shows the Reviewed badge; choosing REVIEWED again explains the effect', async () => {
    showDetail()
    confirmBoth(A1, [log('REVIEWED', 1)])
    expect(headerBadges().getByText('Reviewed')).toBeInTheDocument()

    await user.click(radio('REVIEWED'))
    expect(
      screen.getByText(
        /already reviewed\. Saving another REVIEWED decision adds a new history entry/
      )
    ).toBeInTheDocument()
    await fill(null, NOTE)
    await user.click(saveButton())
    expect(addDoc).toHaveBeenCalledTimes(1) // allowed: the history is append-only
  })

  it('no review status (and no note) while the history is not confirmed', async () => {
    showDetail()
    pushIncident(A1)
    pushHistory([log('REVIEWED', 1)], true)
    expect(headerBadges().queryByText('Reviewed')).not.toBeInTheDocument()
    expect(headerBadges().queryByText('Awaiting review')).not.toBeInTheDocument()
    await user.click(radio('REVIEWED'))
    expect(screen.queryByText(/already reviewed/)).not.toBeInTheDocument()
  })

  it('ACKNOWLEDGE and ESCALATE leave it awaiting review', () => {
    showDetail()
    confirmBoth(A1, [log('ACKNOWLEDGE', 1), log('ESCALATE', 2)])
    expect(headerBadges().getByText('Awaiting review')).toBeInTheDocument()
  })
})

// ── History ──────────────────────────────────────────────────────────────────

describe('IncidentDetail — decision history', () => {
  it('a confirmed empty history says so; while loading it does not', () => {
    showDetail()
    pushIncident(A1)
    expect(screen.getByText('Loading decision history…')).toBeInTheDocument()
    expect(screen.queryByText('No decisions recorded yet.')).not.toBeInTheDocument()
    pushHistory([])
    expect(screen.getByText('No decisions recorded yet.')).toBeInTheDocument()
    expect(screen.getByText('Newest first')).toBeInTheDocument()
  })

  it('lists every decision type newest first, with its rationale, server time and owner', () => {
    showDetail()
    const old = log('ACKNOWLEDGE', 1, { note: 'Oldest decision, acknowledged.' })
    const mid = log('ESCALATE', 2, { note: 'Middle decision, escalation noted.\nSecond line.' })
    const late = log('REVIEWED', 3, { note: 'Newest decision, reviewed.' })
    confirmBoth(A1, [old, late, mid])

    const items = within(
      screen.getByRole('list', { name: 'Saved decisions, newest first' })
    ).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByText(/decision/).textContent)).toEqual([
      'Newest decision, reviewed.',
      'Middle decision, escalation noted.\nSecond line.',
      'Oldest decision, acknowledged.',
    ])
    expect(items[0]).toHaveTextContent('Reviewed')
    expect(items[1]).toHaveTextContent('Escalation recorded')
    expect(items[2]).toHaveTextContent('Acknowledged')
    for (const item of items) expect(item).toHaveTextContent('Recorded by you')
    const time = items[0]!.querySelector('time')!
    expect(time).toHaveAttribute('dateTime', '2026-10-24T01:03:00.000Z')
  })

  it('repeated REVIEWED decisions are all listed', () => {
    showDetail()
    confirmBoth(A1, [log('REVIEWED', 1), log('REVIEWED', 2)])
    expect(
      within(screen.getByRole('list', { name: 'Saved decisions, newest first' })).getAllByRole(
        'listitem'
      )
    ).toHaveLength(2)
  })

  it('pending writes are not listed; malformed and foreign records are flagged, not shown as normal', () => {
    showDetail()
    confirmBoth(A1, [
      pending(log('REVIEWED', 9, { note: 'Pending decision text.' })),
      log('CLOSE', 2, { createdAt: null }),
      log('REVIEWED', 3, { ownerUid: BOB, note: 'Foreign decision text.' }),
    ])

    expect(screen.queryByText('Pending decision text.')).not.toBeInTheDocument()
    expect(screen.queryByText('Foreign decision text.')).not.toBeInTheDocument()
    expect(screen.getByText(/1 decision is waiting for the server/)).toBeInTheDocument()
    expect(screen.getByText(/1 entry has missing or unexpected fields/)).toBeInTheDocument()
    expect(screen.getByText(/1 record was not shown/)).toBeInTheDocument()
    const item = within(
      screen.getByRole('list', { name: 'Saved decisions, newest first' })
    ).getByRole('listitem')
    expect(item).toHaveTextContent('Unrecognised decision')
    expect(item).toHaveTextContent('Time not recorded')
    expect(headerBadges().getByText('Awaiting review')).toBeInTheDocument() // the pending REVIEWED doesn't count
  })

  it('stale history keeps its entries with a warning', () => {
    showDetail()
    const entry = log('ACKNOWLEDGE', 1)
    confirmBoth(A1, [entry])
    pushHistory([entry], true)
    expect(screen.getByText('Showing cached history; it may be out of date.')).toBeInTheDocument()
    expect(
      within(screen.getByRole('list', { name: 'Saved decisions, newest first' })).getAllByRole(
        'listitem'
      )
    ).toHaveLength(1)
  })

  it('history not confirmed in time is reported as offline, the incident still shown', () => {
    showDetail()
    pushIncident(A1)
    act(() => vi.advanceTimersByTime(SERVER_CONFIRMATION_TIMEOUT_MS))
    expect(
      screen.getByText("Decision history couldn't be confirmed with the server.")
    ).toBeInTheDocument()
    expect(fact('Device ID')).toHaveTextContent(A1.seed.deviceId)
  })

  it.each([
    ['a missing index', 'failed-precondition', 'Decision history is unavailable.'],
    ['a general error', 'permission-denied', "Decision history couldn't be loaded."],
  ])(
    '%s: a warning, never "No decisions", and a decision can still be saved',
    async (_label, code, title) => {
      showDetail()
      pushIncident(A1)
      act(() => listenerFor('history').error(firestoreError(code)))

      expect(screen.getByText(title)).toBeInTheDocument()
      expect(screen.getByText(/can't be verified right now/)).toBeInTheDocument()
      expect(screen.queryByText('No decisions recorded yet.')).not.toBeInTheDocument()
      expect(document.body).not.toHaveTextContent(RAW)

      await fill('ACKNOWLEDGE', NOTE)
      await user.click(saveButton())
      expect(addDoc).toHaveBeenCalledTimes(1)
    }
  )
})

// ── Isolation and lifecycle ──────────────────────────────────────────────────

describe('IncidentDetail — user and incident isolation', () => {
  it("switching account clears the form and never shows the previous user's incident", async () => {
    const { rerender } = showDetail()
    confirmBoth()
    await fill('REVIEWED', 'Alice private rationale text.')

    signedInAs(BOB)
    rerender(<IncidentDetail incidentId={A1.id} />)

    expect(screen.queryByText(A1.seed.deviceId)).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Alice private rationale text.')).not.toBeInTheDocument()
    expect(screen.getByText('Loading incident…')).toBeInTheDocument()
    expect(listenerFor('history').target.constraints?.[0]).toEqual({
      where: ['ownerUid', '==', BOB],
    })
  })

  it("a previous user's in-flight write and its result never appear for the next user", async () => {
    const { rerender } = showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    signedInAs(BOB)
    rerender(<IncidentDetail incidentId={B1.id} />)
    confirmBoth(B1)
    await fake.writes[0]!.accept('alice-log')

    expect(screen.queryByText(/Decision saved/)).not.toBeInTheDocument()
    expect(saveButton()).toHaveTextContent('Save decision')
    expect(saveButton()).toBeEnabled()
  })

  it('switching incident starts an empty form for the new incident', async () => {
    const { rerender } = showDetail()
    confirmBoth()
    await fill('ESCALATE', NOTE)

    rerender(<IncidentDetail incidentId={A2.id} />)
    confirmBoth(A2)
    expect(fact('Device ID')).toHaveTextContent(A2.seed.deviceId)
    expect(rationale()).toHaveValue('')
    expect(radio('ESCALATE')).not.toBeChecked()
  })

  it('returning to an incident whose write is unresolved shows it as still saving, and stays locked', async () => {
    const { rerender } = showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    rerender(<IncidentDetail incidentId={A2.id} />)
    rerender(<IncidentDetail incidentId={A1.id} />)
    confirmBoth()
    expect(saveButton()).toBeDisabled()
    expect(statusRegion()).toHaveTextContent('Saving your decision…')
    fireEvent.submit(saveButton().closest('form')!)
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('returning before the incident is confirmed again: the unresolved save is explained, not a bare line (CP7)', async () => {
    const { rerender } = showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    await user.click(saveButton())

    rerender(<IncidentDetail incidentId={A2.id} />)
    rerender(<IncidentDetail incidentId={A1.id} />) // back; the incident is still loading
    const region = screen.getByRole('region', { name: 'Your decision' })
    expect(region).toHaveTextContent(
      'A decision you submitted for this incident is still being saved.'
    )
    expect(screen.queryByRole('button', { name: /Save decision/ })).not.toBeInTheDocument()
    expect(addDoc).toHaveBeenCalledTimes(1)
  })

  it('signing out removes the incident and the form', () => {
    const { rerender } = showDetail()
    confirmBoth()
    signedInAs(null)
    rerender(<IncidentDetail incidentId={A1.id} />)
    expect(screen.getByText('Your session has ended.')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('under Strict Mode, mounting writes nothing and one save writes once', async () => {
    showDetail(A1.id, ALICE, { strict: true })
    confirmBoth()
    expect(addDoc).not.toHaveBeenCalled()
    await fill('ACKNOWLEDGE', NOTE)
    await user.click(saveButton())
    await fake.writes[0]!.accept('log-1')
    expect(addDoc).toHaveBeenCalledTimes(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('nothing typed is stored in the browser', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    showDetail()
    confirmBoth()
    await fill('REVIEWED', NOTE)
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })
})

describe('IncidentDetail — accessibility', () => {
  it('labels the form, links the hint and counter, and uses one heading level per section', () => {
    showDetail()
    confirmBoth()
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    for (const name of [
      'Incident facts',
      'Evidence and assessment',
      'Record a decision',
      'Decision history',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument()
    }
    expect(screen.getByRole('form', { name: 'Record a decision' })).toBeInTheDocument()
    const describedBy = rationale().getAttribute('aria-describedby') ?? ''
    expect(describedBy).toContain('decision-rationale-hint')
    expect(describedBy).toContain('decision-rationale-count')
    expect(rationale()).not.toHaveAttribute('aria-invalid')
  })

  it('explains, next to the disabled button, why saving is unavailable', () => {
    showDetail()
    confirmBoth()
    pushIncident(A1, true)
    const explanation = screen.getByText(DECISION_UNAVAILABLE_TEXT)
    expect(saveButton().getAttribute('aria-describedby')).toBe(explanation.id)
  })
})

// ── Phase 6: timeline presentation and navigation ────────────────────────────

describe('IncidentDetail — Phase 6 timeline and navigation', () => {
  it('shows a breadcrumb to the queue, with the incident as the current page', () => {
    showDetail()
    confirmBoth()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Incident queue' })).toHaveAttribute(
      'href',
      '/dashboard'
    )
    expect(within(crumbs).getByText(A1.seed.incidentCode)).toHaveAttribute('aria-current', 'page')
  })

  it('shows Melbourne time with the right zone on each side of the daylight-saving change', () => {
    showDetail(storedIncident(ALICE, 35).id)
    confirmBoth(storedIncident(ALICE, 35)) // INC-036, Daylesford
    expect(fact('Last signal (simulated)')).toHaveTextContent('Sun, 4 Oct 2026, 1:47 am AEST')
    expect(fact('Reported (simulated)')).toHaveTextContent('Sun, 4 Oct 2026, 3:09 am AEDT')
  })

  it('a version 1 (legacy) record loads with no data warning and no invented report time', () => {
    showDetail()
    const { reportedAt: _reported, ...v1 } = A1.data
    confirmBoth({ ...A1, data: { ...v1, _schemaVersion: 1 } })

    expect(
      screen.getByRole('heading', { level: 1, name: A1.seed.incidentCode })
    ).toBeInTheDocument()
    expect(fact('Reported (simulated)')).toHaveTextContent(
      'Not recorded in this earlier-format record'
    )
    expect(fact('Reported (simulated)').querySelector('time')).toBeNull()
    expect(fact('Last signal (simulated)').querySelector('time')).not.toBeNull()
    expect(screen.queryByText('This incident record has missing or unexpected fields.')).toBeNull()
    expect(
      within(screen.getByRole('region', { name: 'Dataset record' })).getByText(
        'Version 1 (earlier format)'
      )
    ).toBeInTheDocument()
    // The decision workflow is unchanged for a legacy record.
    expect(radio('REVIEWED')).toBeEnabled()
  })

  it('states that the incident is a historical, fictional scenario', () => {
    showDetail()
    confirmBoth()
    expect(
      within(screen.getByRole('region', { name: 'Incident facts' })).getByText(
        /historical, fictional scenario — not a live alert/
      )
    ).toBeInTheDocument()
  })
})
