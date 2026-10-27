// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import {
  buildActionHistory,
  deriveIncidentReviewStatus,
  parseActionLog,
  sortNewestFirst,
} from '@/features/incidents/actionHistory'
import { parseIncident } from '@/features/incidents/incidentRow'
import { deriveReviewSummary } from '@/features/incidents/reviewSummary'
import type { ActionHistoryEntry, IncidentRow } from '@/features/incidents/types'
import type { ActionType } from '@/types/firestore'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents } from '../../../../scripts/seed-incidents/dataset'

const OWNER = 'demoOperatorUid01'
const OTHER = 'otherOperatorUid02'
const INCIDENT = `${OWNER}_INC-001`
const OTHER_INCIDENT = `${OWNER}_INC-002`
const CONTEXT = { ownerUid: OWNER, incidentId: INCIDENT }
const NOTE = 'Checked the simulated outage evidence.'

const at = (iso: string) => Timestamp.fromDate(new Date(iso))

/** An action log as the client SDK returns it. */
function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerUid: OWNER,
    incidentId: INCIDENT,
    actionType: 'ACKNOWLEDGE',
    note: NOTE,
    createdAt: at('2026-10-24T01:00:00Z'),
    _schemaVersion: 1,
    ...overrides,
  }
}

function withoutField(field: string): Record<string, unknown> {
  const data = stored()
  delete data[field]
  return data
}

function parseEntry(data: unknown, id = 'log-1') {
  const parsed = parseActionLog(id, data, CONTEXT)
  if (!parsed.ok) throw new Error(`expected the log to be accepted, got ${parsed.reason}`)
  return parsed.entry
}

function entry(
  id: string,
  actionType: ActionType | null,
  createdAt: string | null,
  incidentId = INCIDENT
): ActionHistoryEntry {
  return {
    id,
    incidentId,
    actionType,
    note: NOTE,
    createdAt: createdAt ? new Date(createdAt) : null,
    dataIssues: [],
  }
}

describe('parseActionLog — valid logs', () => {
  it.each(['ACKNOWLEDGE', 'ESCALATE', 'REVIEWED'])(
    'maps a stored %s log with no data issues',
    (actionType) => {
      expect(parseActionLog('log-1', stored({ actionType }), CONTEXT)).toEqual({
        ok: true,
        entry: {
          id: 'log-1',
          incidentId: INCIDENT,
          actionType,
          note: NOTE,
          createdAt: new Date('2026-10-24T01:00:00Z'),
          dataIssues: [],
        },
      })
    }
  )

  it('keeps a multi-line note exactly as stored', () => {
    const note = 'Line one of the note.\nLine two.'
    expect(parseEntry(stored({ note })).note).toBe(note)
  })

  it('accepts notes of exactly 10 and exactly 500 characters', () => {
    expect(parseEntry(stored({ note: 'a'.repeat(10) })).note).toBe('a'.repeat(10))
    expect(parseEntry(stored({ note: 'a'.repeat(500) })).note).toBe('a'.repeat(500))
  })

  it('checks nothing it was not asked to: no context means any owner and incident', () => {
    const parsed = parseActionLog('log-1', stored({ ownerUid: OTHER, incidentId: OTHER_INCIDENT }))
    expect(parsed).toMatchObject({ ok: true, entry: { incidentId: OTHER_INCIDENT } })
  })

  it('does not modify the document data', () => {
    const data = Object.freeze(stored({ actionType: 'CLOSE' }))
    expect(() => parseActionLog('log-1', data, CONTEXT)).not.toThrow()
    expect(data.actionType).toBe('CLOSE')
  })
})

describe('parseActionLog — owner and incident must match the context', () => {
  it("rejects another operator's log", () => {
    expect(parseActionLog('log-1', stored({ ownerUid: OTHER }), CONTEXT)).toEqual({
      ok: false,
      id: 'log-1',
      reason: 'OWNER_MISMATCH',
    })
  })

  it('rejects a log for a different incident', () => {
    expect(parseActionLog('log-1', stored({ incidentId: OTHER_INCIDENT }), CONTEXT)).toEqual({
      ok: false,
      id: 'log-1',
      reason: 'INCIDENT_MISMATCH',
    })
  })

  it.each([
    ['missing', undefined],
    ['not a string', 7],
  ])('rejects a log whose ownerUid is %s, even without a context', (_label, ownerUid) => {
    const data = ownerUid === undefined ? withoutField('ownerUid') : stored({ ownerUid })
    expect(parseActionLog('log-1', data)).toMatchObject({ ok: false, reason: 'OWNER_MISMATCH' })
  })

  it.each([
    ['missing', undefined],
    ['not a string', 7],
  ])('rejects a log whose incidentId is %s, even without a context', (_label, incidentId) => {
    const data = incidentId === undefined ? withoutField('incidentId') : stored({ incidentId })
    expect(parseActionLog('log-1', data)).toMatchObject({ ok: false, reason: 'INCIDENT_MISMATCH' })
  })

  it.each([null, undefined, 'text', 42, ['a']])('rejects a document whose data is %s', (data) => {
    expect(parseActionLog('log-1', data, CONTEXT)).toMatchObject({
      ok: false,
      reason: 'OWNER_MISMATCH',
    })
  })
})

describe('parseActionLog — malformed fields become null and are reported', () => {
  it.each([['CLOSE'], ['reviewed'], [''], [3], [null], [undefined]])(
    'actionType %s',
    (actionType) => {
      const data = actionType === undefined ? withoutField('actionType') : stored({ actionType })
      const parsed = parseEntry(data)
      expect(parsed.actionType).toBeNull()
      expect(parsed.dataIssues).toEqual(['actionType'])
    }
  )

  it.each([
    ['9 characters', 'a'.repeat(9)],
    ['501 characters', 'a'.repeat(501)],
    ['empty', ''],
    ['a number', 1234567890],
    ['missing', undefined],
  ])('note that is %s', (_label, note) => {
    const data = note === undefined ? withoutField('note') : stored({ note })
    const parsed = parseEntry(data)
    expect(parsed.note).toBeNull()
    expect(parsed.dataIssues).toEqual(['note'])
  })

  it.each([
    ['missing', undefined],
    ['null (a pending server timestamp)', null],
    ['an ISO string', '2026-10-24T01:00:00Z'],
    ['an invalid Timestamp', new Timestamp(Number.NaN, 0)],
  ])('createdAt %s', (_label, createdAt) => {
    const data = createdAt === undefined ? withoutField('createdAt') : stored({ createdAt })
    const parsed = parseEntry(data)
    expect(parsed.createdAt).toBeNull()
    expect(parsed.dataIssues).toEqual(['createdAt'])
  })

  it('reports an unexpected _schemaVersion', () => {
    expect(parseEntry(stored({ _schemaVersion: 2 })).dataIssues).toEqual(['_schemaVersion'])
  })
})

describe('sortNewestFirst', () => {
  it('orders by time, newest first, with untimed entries last and ties broken by ID', () => {
    const entries = [
      entry('b', 'ACKNOWLEDGE', '2026-10-24T01:00:00Z'),
      entry('c', 'REVIEWED', null),
      entry('d', 'ESCALATE', '2026-10-24T03:00:00Z'),
      entry('a', 'REVIEWED', '2026-10-24T01:00:00Z'),
      entry('e', 'ACKNOWLEDGE', null),
    ]
    expect(sortNewestFirst(entries).map((e) => e.id)).toEqual(['d', 'a', 'b', 'c', 'e'])
  })

  it('returns a new array and leaves the input unchanged', () => {
    const entries = [
      entry('a', 'ACKNOWLEDGE', '2026-10-24T01:00:00Z'),
      entry('b', 'REVIEWED', '2026-10-24T02:00:00Z'),
    ]
    const sorted = sortNewestFirst(entries)
    expect(sorted).not.toBe(entries)
    expect(entries.map((e) => e.id)).toEqual(['a', 'b'])
  })
})

describe('buildActionHistory', () => {
  it('keeps this incident’s logs newest first and counts the rejected ones', () => {
    const history = buildActionHistory(
      [
        { id: 'old', data: stored({ createdAt: at('2026-10-24T01:00:00Z') }) },
        {
          id: 'new',
          data: stored({ actionType: 'REVIEWED', createdAt: at('2026-10-24T05:00:00Z') }),
        },
        { id: 'other-incident', data: stored({ incidentId: OTHER_INCIDENT }) },
        { id: 'other-owner', data: stored({ ownerUid: OTHER }) },
        {
          id: 'mid',
          data: stored({ actionType: 'ESCALATE', createdAt: at('2026-10-24T03:00:00Z') }),
        },
      ],
      CONTEXT
    )
    expect(history.entries.map((e) => e.id)).toEqual(['new', 'mid', 'old'])
    expect(history.rejectedCount).toBe(2)
  })

  it('returns an empty history for no logs', () => {
    expect(buildActionHistory([], CONTEXT)).toEqual({ entries: [], rejectedCount: 0 })
  })
})

describe('deriveIncidentReviewStatus', () => {
  it('is awaiting review with no decisions', () => {
    expect(deriveIncidentReviewStatus(INCIDENT, [])).toBe('AWAITING_REVIEW')
  })

  it.each(['ACKNOWLEDGE', 'ESCALATE'] as const)(
    '%s alone does not mark the incident reviewed',
    (actionType) => {
      expect(
        deriveIncidentReviewStatus(INCIDENT, [entry('a', actionType, '2026-10-24T01:00:00Z')])
      ).toBe('AWAITING_REVIEW')
    }
  )

  it('ACKNOWLEDGE and ESCALATE together still do not', () => {
    const entries = [
      entry('a', 'ACKNOWLEDGE', '2026-10-24T01:00:00Z'),
      entry('b', 'ESCALATE', '2026-10-24T02:00:00Z'),
    ]
    expect(deriveIncidentReviewStatus(INCIDENT, entries)).toBe('AWAITING_REVIEW')
  })

  it('one REVIEWED decision marks it reviewed, whatever else was recorded and in any order', () => {
    const entries = [
      entry('a', 'ESCALATE', '2026-10-24T03:00:00Z'),
      entry('b', 'REVIEWED', '2026-10-24T01:00:00Z'),
      entry('c', 'ACKNOWLEDGE', '2026-10-24T02:00:00Z'),
    ]
    expect(deriveIncidentReviewStatus(INCIDENT, entries)).toBe('REVIEWED')
  })

  it('several REVIEWED decisions still mean one reviewed incident', () => {
    const entries = [
      entry('a', 'REVIEWED', '2026-10-24T01:00:00Z'),
      entry('b', 'REVIEWED', '2026-10-24T02:00:00Z'),
    ]
    expect(deriveIncidentReviewStatus(INCIDENT, entries)).toBe('REVIEWED')
  })

  it('a REVIEWED decision for another incident does not count', () => {
    const entries = [entry('a', 'REVIEWED', '2026-10-24T01:00:00Z', OTHER_INCIDENT)]
    expect(deriveIncidentReviewStatus(INCIDENT, entries)).toBe('AWAITING_REVIEW')
  })

  it('an unrecognised action type never counts as REVIEWED', () => {
    const parsed = parseEntry(stored({ actionType: 'reviewed' }))
    expect(deriveIncidentReviewStatus(INCIDENT, [parsed])).toBe('AWAITING_REVIEW')
  })

  it('logs the parser rejected cannot affect the status', () => {
    const history = buildActionHistory(
      [
        { id: 'x', data: stored({ actionType: 'REVIEWED', ownerUid: OTHER }) },
        { id: 'y', data: stored({ actionType: 'REVIEWED', incidentId: OTHER_INCIDENT }) },
      ],
      CONTEXT
    )
    expect(history.entries).toEqual([])
    expect(deriveIncidentReviewStatus(INCIDENT, history.entries)).toBe('AWAITING_REVIEW')
  })
})

describe('deriveIncidentReviewStatus — consistent with the dashboard (deriveReviewSummary)', () => {
  const rows: IncidentRow[] = buildSeedIncidents(OWNER, new Date('2026-10-21T00:00:00Z')).map(
    ({ id, data }) => {
      const parsed = parseIncident(id, {
        ...data,
        reportedAt: Timestamp.fromDate(data.reportedAt),
        lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
        createdAt: Timestamp.fromDate(data.createdAt),
      })
      if (!parsed.ok) throw new Error('seed record rejected')
      return parsed.row
    }
  )

  it('gives every incident the same status the dashboard does for a mixed set of decisions', () => {
    const logs = [
      entry('1', 'REVIEWED', '2026-10-24T01:00:00Z', rows[0]!.id),
      entry('2', 'REVIEWED', '2026-10-24T02:00:00Z', rows[0]!.id),
      entry('3', 'ACKNOWLEDGE', '2026-10-24T01:00:00Z', rows[1]!.id),
      entry('4', 'ESCALATE', '2026-10-24T01:00:00Z', rows[2]!.id),
      entry('5', 'ESCALATE', '2026-10-24T01:00:00Z', rows[3]!.id),
      entry('6', 'REVIEWED', '2026-10-24T03:00:00Z', rows[3]!.id),
    ]
    const dashboard = deriveReviewSummary(
      rows,
      logs.flatMap((log) =>
        log.actionType ? [{ incidentId: log.incidentId, actionType: log.actionType }] : []
      )
    )
    expect(dashboard).toMatchObject({ total: 50, reviewed: 2, awaiting: 48 })
    for (const row of dashboard.rows) {
      const ownLogs = logs.filter((log) => log.incidentId === row.id)
      expect(deriveIncidentReviewStatus(row.id, ownLogs)).toBe(row.reviewStatus)
    }
  })
})
