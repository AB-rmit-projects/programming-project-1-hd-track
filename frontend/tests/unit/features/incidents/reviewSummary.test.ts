// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { parseIncident } from '@/features/incidents/incidentRow'
import {
  compareQueueOrder,
  confirmedReviewEvidence,
  deriveReviewSummary,
  filterByTab,
  type ActionLogSnapshotDoc,
  type ReviewEvidence,
} from '@/features/incidents/reviewSummary'
import type { IncidentRow, ReviewStatus, ReviewedIncidentRow } from '@/features/incidents/types'
import type { ActionType } from '@/types/firestore'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

const OWNER = 'demoOperatorUid01'
const NOW = new Date('2026-10-21T00:00:00.000Z')

/** The 50 Phase 3 incidents as the dashboard sees them: stored, read back, parsed. */
const SEED_ROWS: IncidentRow[] = buildSeedIncidents(OWNER, NOW).map(({ id, data }) => {
  const parsed = parseIncident(id, {
    ...data,
    reportedAt: Timestamp.fromDate(data.reportedAt),
    lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
    createdAt: Timestamp.fromDate(data.createdAt),
  })
  if (!parsed.ok) throw new Error(`seed record ${id} was rejected`)
  return parsed.row
})

const incidentId = (code: string) => `${OWNER}_${code}`

function log(actionType: ActionType, code: string): ReviewEvidence {
  return { actionType, incidentId: incidentId(code) }
}

function statusOf(rows: ReviewedIncidentRow[], code: string): ReviewStatus | undefined {
  return rows.find((row) => row.incidentCode === code)?.reviewStatus
}

function counts({ total, awaiting, reviewed }: ReturnType<typeof deriveReviewSummary>) {
  return { total, awaiting, reviewed }
}

describe('deriveReviewSummary — counts from the seeded dataset', () => {
  it('50 seeded incidents and no action logs: 50 total, 50 awaiting, 0 reviewed', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
    expect(summary.rows).toHaveLength(50)
    expect(summary.rows.every((row) => row.reviewStatus === 'AWAITING_REVIEW')).toBe(true)
  })

  it('one REVIEWED log: 50 total, 49 awaiting, 1 reviewed', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [log('REVIEWED', 'INC-007')])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    expect(statusOf(summary.rows, 'INC-007')).toBe('REVIEWED')
  })

  it('ACKNOWLEDGE and ESCALATE never mark an incident as reviewed', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [
      log('ACKNOWLEDGE', 'INC-001'),
      log('ESCALATE', 'INC-002'),
      log('ACKNOWLEDGE', 'INC-002'),
    ])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
    expect(statusOf(summary.rows, 'INC-001')).toBe('AWAITING_REVIEW')
    expect(statusOf(summary.rows, 'INC-002')).toBe('AWAITING_REVIEW')
  })

  it('ACKNOWLEDGE and ESCALATE alongside a REVIEWED log leave the counts at 50 / 49 / 1', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [
      log('ACKNOWLEDGE', 'INC-007'),
      log('REVIEWED', 'INC-007'),
      log('ESCALATE', 'INC-007'),
      log('ESCALATE', 'INC-010'),
    ])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
    expect(statusOf(summary.rows, 'INC-010')).toBe('AWAITING_REVIEW')
  })

  it('several REVIEWED logs for one incident count once', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [
      log('REVIEWED', 'INC-003'),
      log('REVIEWED', 'INC-003'),
      log('REVIEWED', 'INC-003'),
    ])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 49, reviewed: 1 })
  })

  it('REVIEWED logs for incidents outside the dataset are ignored', () => {
    const summary = deriveReviewSummary(SEED_ROWS, [
      { actionType: 'REVIEWED', incidentId: 'otherOperator_INC-001' },
      { actionType: 'REVIEWED', incidentId: incidentId('INC-999') },
      { actionType: 'REVIEWED', incidentId: '' },
    ])
    expect(counts(summary)).toEqual({ total: 50, awaiting: 50, reviewed: 0 })
  })

  it('counts every incident once all 50 are reviewed', () => {
    const summary = deriveReviewSummary(
      SEED_ROWS,
      SEED_ROWS.map((row) => ({ actionType: 'REVIEWED', incidentId: row.id }) as const)
    )
    expect(counts(summary)).toEqual({ total: 50, awaiting: 0, reviewed: 50 })
  })

  it('an owner with no incidents gets 0 / 0 / 0, whatever logs exist', () => {
    const summary = deriveReviewSummary([], [log('REVIEWED', 'INC-001')])
    expect(summary).toEqual({ rows: [], total: 0, awaiting: 0, reviewed: 0 })
  })

  it('keeps every row field and adds only reviewStatus', () => {
    const [first] = deriveReviewSummary([SEED_ROWS[0]!], []).rows
    expect(first).toEqual({ ...SEED_ROWS[0], reviewStatus: 'AWAITING_REVIEW' })
  })
})

// ── Queue order ──────────────────────────────────────────────────────────────

function row(overrides: Partial<IncidentRow> & { id: string }): IncidentRow {
  return {
    incidentCode: 'INC-001',
    deviceId: 'SC-1000',
    suburb: 'Ballarat',
    postcode: '3350',
    status: 'OFFLINE',
    causeCategory: 'UNPLANNED_OUTAGE',
    reportedAt: new Date('2026-10-20T00:30:00Z'),
    lastSignalAt: new Date('2026-10-20T00:00:00Z'),
    legacyTimeline: false,
    dataIssues: [],
    ...overrides,
  }
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

describe('deriveReviewSummary — queue order', () => {
  it('lists awaiting incidents before reviewed ones, even when the reviewed one is older', () => {
    const rows = [
      row({ id: 'awaiting', lastSignalAt: new Date('2026-10-20T12:00:00Z') }),
      row({ id: 'reviewed', lastSignalAt: new Date('2026-10-18T00:00:00Z') }),
    ]
    const summary = deriveReviewSummary(rows, [{ actionType: 'REVIEWED', incidentId: 'reviewed' }])
    expect(ids(summary.rows)).toEqual(['awaiting', 'reviewed'])
  })

  it('within a group, the oldest last signal comes first', () => {
    const rows = [
      row({ id: 'newest', lastSignalAt: new Date('2026-10-20T23:00:00Z') }),
      row({ id: 'oldest', lastSignalAt: new Date('2026-10-18T00:00:00Z') }),
      row({ id: 'middle', lastSignalAt: new Date('2026-10-19T12:00:00Z') }),
    ]
    expect(ids(deriveReviewSummary(rows, []).rows)).toEqual(['oldest', 'middle', 'newest'])
  })

  it('a missing last signal sorts last within its own group, not after reviewed incidents', () => {
    const rows = [
      row({ id: 'reviewed-dated', lastSignalAt: new Date('2026-10-18T00:00:00Z') }),
      row({ id: 'reviewed-undated', lastSignalAt: null }),
      row({ id: 'awaiting-undated', lastSignalAt: null }),
      row({ id: 'awaiting-dated', lastSignalAt: new Date('2026-10-20T00:00:00Z') }),
    ]
    const summary = deriveReviewSummary(rows, [
      { actionType: 'REVIEWED', incidentId: 'reviewed-dated' },
      { actionType: 'REVIEWED', incidentId: 'reviewed-undated' },
    ])
    expect(ids(summary.rows)).toEqual([
      'awaiting-dated',
      'awaiting-undated',
      'reviewed-dated',
      'reviewed-undated',
    ])
  })

  it('equal last signals are ordered by incident code, then document ID', () => {
    const rows = [
      row({ id: 'b', incidentCode: 'INC-002' }),
      row({ id: 'z', incidentCode: 'INC-001' }),
      row({ id: 'a', incidentCode: 'INC-001' }),
      row({ id: 'no-code', incidentCode: null }),
    ]
    expect(ids(deriveReviewSummary(rows, []).rows)).toEqual(['a', 'z', 'b', 'no-code'])
  })

  it('gives the same order whatever order the incidents arrive in', () => {
    const logs = [log('REVIEWED', 'INC-004'), log('REVIEWED', 'INC-030')]
    const forward = ids(deriveReviewSummary(SEED_ROWS, logs).rows)
    const reversed = ids(deriveReviewSummary([...SEED_ROWS].reverse(), logs).rows)
    expect(reversed).toEqual(forward)
  })

  it('every adjacent pair of the seeded queue is in order', () => {
    const { rows } = deriveReviewSummary(SEED_ROWS, [log('REVIEWED', 'INC-012')])
    for (let i = 1; i < rows.length; i++) {
      expect(compareQueueOrder(rows[i - 1]!, rows[i]!)).toBeLessThan(0)
    }
    expect(rows.at(-1)?.incidentCode).toBe('INC-012') // the only reviewed incident
  })
})

// ── Tabs and immutability ────────────────────────────────────────────────────

describe('filterByTab', () => {
  const summary = deriveReviewSummary(SEED_ROWS, [
    log('REVIEWED', 'INC-005'),
    log('REVIEWED', 'INC-040'),
    log('ACKNOWLEDGE', 'INC-006'),
  ])

  it('ALL returns every row in queue order', () => {
    expect(filterByTab(summary.rows, 'ALL')).toEqual(summary.rows)
  })

  it('AWAITING_REVIEW and REVIEWED split the rows to match the counts, keeping queue order', () => {
    const awaiting = filterByTab(summary.rows, 'AWAITING_REVIEW')
    const reviewed = filterByTab(summary.rows, 'REVIEWED')

    expect(awaiting).toHaveLength(summary.awaiting)
    expect(reviewed).toHaveLength(summary.reviewed)
    expect(awaiting.every((r) => r.reviewStatus === 'AWAITING_REVIEW')).toBe(true)
    expect(reviewed.map((r) => r.incidentCode).sort()).toEqual(['INC-005', 'INC-040'])
    expect([...awaiting, ...reviewed]).toEqual(summary.rows)
  })

  it('an empty tab returns an empty array', () => {
    const none = deriveReviewSummary(SEED_ROWS, [])
    expect(filterByTab(none.rows, 'REVIEWED')).toEqual([])
  })

  it('always returns a new array, including for ALL', () => {
    expect(filterByTab(summary.rows, 'ALL')).not.toBe(summary.rows)
  })
})

describe('inputs are never modified', () => {
  it('deriveReviewSummary leaves frozen incident and log arrays untouched', () => {
    const rows = Object.freeze([...SEED_ROWS].reverse().map((r) => Object.freeze({ ...r })))
    const logs = Object.freeze([Object.freeze(log('REVIEWED', 'INC-001'))])
    const before = ids(rows)

    const summary = deriveReviewSummary(rows, logs)

    expect(ids(rows)).toEqual(before)
    expect(rows.every((r) => !('reviewStatus' in r))).toBe(true)
    expect(summary.rows).not.toBe(rows)
  })

  it('filterByTab leaves a frozen row array untouched', () => {
    const { rows } = deriveReviewSummary(SEED_ROWS, [log('REVIEWED', 'INC-001')])
    const frozen = Object.freeze([...rows])
    const before = ids(frozen)

    for (const tab of ['ALL', 'AWAITING_REVIEW', 'REVIEWED'] as const) filterByTab(frozen, tab)

    expect(ids(frozen)).toEqual(before)
  })
})

describe('confirmedReviewEvidence', () => {
  function snapshotDoc(code: string, hasPendingWrites: boolean): ActionLogSnapshotDoc {
    return {
      metadata: { hasPendingWrites },
      data: vi.fn(() => ({
        incidentId: incidentId(code),
        actionType: 'REVIEWED' as const,
        createdAt: Timestamp.fromDate(new Date('2026-10-24T01:00:00Z')),
      })),
    }
  }

  it('keeps server-accepted documents in order and drops pending ones', () => {
    const docs = [
      snapshotDoc('INC-003', false),
      snapshotDoc('INC-001', true),
      snapshotDoc('INC-002', false),
    ]
    expect(confirmedReviewEvidence(docs)).toEqual([
      { incidentId: incidentId('INC-003'), actionType: 'REVIEWED' },
      { incidentId: incidentId('INC-002'), actionType: 'REVIEWED' },
    ])
    expect(docs[1]!.data).not.toHaveBeenCalled()
  })

  it('returns only the two fields the counts depend on', () => {
    const doc: ActionLogSnapshotDoc = {
      metadata: { hasPendingWrites: false },
      data: () =>
        ({
          incidentId: incidentId('INC-001'),
          actionType: 'REVIEWED',
          ownerUid: OWNER,
          note: 'Checked the simulated outage evidence.',
          createdAt: Timestamp.fromDate(new Date('2026-10-24T01:00:00Z')),
        }) as ReviewEvidence,
    }
    expect(confirmedReviewEvidence([doc])).toEqual([
      { incidentId: incidentId('INC-001'), actionType: 'REVIEWED' },
    ])
  })

  it('drops a confirmed log with no createdAt field — the ordered history query can never return it', () => {
    const missing: ActionLogSnapshotDoc = {
      metadata: { hasPendingWrites: false },
      data: () => ({ incidentId: incidentId('INC-001'), actionType: 'REVIEWED' }),
    }
    expect(confirmedReviewEvidence([missing, snapshotDoc('INC-002', false)])).toEqual([
      { incidentId: incidentId('INC-002'), actionType: 'REVIEWED' },
    ])
  })

  it.each([
    ['null', null],
    ['a string', '2026-10-24T01:00:00Z'],
    ['a number', 1761267600],
  ])(
    'keeps a log whose createdAt is present but %s — Firestore still includes it in the ordered history',
    (_label, createdAt) => {
      const doc: ActionLogSnapshotDoc = {
        metadata: { hasPendingWrites: false },
        data: () => ({ incidentId: incidentId('INC-001'), actionType: 'REVIEWED', createdAt }),
      }
      expect(confirmedReviewEvidence([doc])).toHaveLength(1)
    }
  )

  it('is empty when every document is pending, and for an empty snapshot', () => {
    expect(confirmedReviewEvidence([snapshotDoc('INC-001', true)])).toEqual([])
    expect(confirmedReviewEvidence([])).toEqual([])
  })

  it('feeds deriveReviewSummary so a pending REVIEWED log leaves the counts at 50 / 50 / 0', () => {
    const summary = deriveReviewSummary(
      SEED_ROWS,
      confirmedReviewEvidence([snapshotDoc('INC-001', true)])
    )
    expect(summary).toMatchObject({ total: 50, awaiting: 50, reviewed: 0 })
  })
})
