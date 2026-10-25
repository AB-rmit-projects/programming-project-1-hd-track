// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { parseIncidentDetail } from '@/features/incidents/incidentDetail'
import { parseIncident } from '@/features/incidents/incidentRow'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents, type SeedRecord } from '../../../../scripts/seed-incidents/dataset'

const OWNER = 'demoOperatorUid01'
const OTHER = 'otherOperatorUid02'
const NOW = new Date('2026-10-21T00:00:00.000Z')
const EXPECTED = { ownerUid: OWNER }

/** A seed record as the client SDK returns it: stored Dates come back as Timestamps. */
function asStored({ data }: SeedRecord): Record<string, unknown> {
  return {
    ...data,
    lastSignalAt: Timestamp.fromDate(data.lastSignalAt),
    createdAt: Timestamp.fromDate(data.createdAt),
  }
}

const SEED = buildSeedIncidents(OWNER, NOW)
const FIRST = SEED[0]!
const ID = FIRST.id

function storedWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...asStored(FIRST), ...overrides }
}

function withoutField(field: string): Record<string, unknown> {
  const data = asStored(FIRST)
  delete data[field]
  return data
}

/** Parses and asserts the record was accepted. */
function parseDetail(data: unknown) {
  const parsed = parseIncidentDetail(ID, data, EXPECTED)
  if (!parsed.ok) throw new Error(`expected the record to be accepted, got ${parsed.reason}`)
  return parsed.detail
}

describe('parseIncidentDetail — complete records', () => {
  it('maps every field of a stored seed record, with no data issues', () => {
    expect(parseIncidentDetail(ID, asStored(FIRST), EXPECTED)).toEqual({
      ok: true,
      detail: {
        id: ID,
        incidentCode: FIRST.data.incidentCode,
        deviceId: FIRST.data.deviceId,
        suburb: FIRST.data.suburb,
        postcode: FIRST.data.postcode,
        status: FIRST.data.status,
        causeCategory: FIRST.data.causeCategory,
        lastSignalAt: FIRST.data.lastSignalAt,
        state: 'VIC',
        likelyCause: FIRST.data.likelyCause,
        evidenceSummary: FIRST.data.evidenceSummary,
        recommendedAction: FIRST.data.recommendedAction,
        createdAt: FIRST.data.createdAt,
        dataIssues: [],
      },
    })
  })

  it('accepts all 50 Phase 3 seed records without issues', () => {
    const details = SEED.map((record) => parseDetail(asStored(record)))
    expect(details).toHaveLength(50)
    expect(details.every((detail) => detail.dataIssues.length === 0)).toBe(true)
  })

  it('agrees with the dashboard row parser on every queue field', () => {
    for (const record of SEED) {
      const row = parseIncident(record.id, asStored(record))
      const detail = parseIncidentDetail(record.id, asStored(record), EXPECTED)
      if (!row.ok || !detail.ok) throw new Error('expected both to accept the seed record')
      expect(detail.detail).toMatchObject(row.row)
    }
  })

  it('does not include fields the schema does not define (no confidence score, no owner)', () => {
    const detail = parseDetail(storedWith({ confidence: 0.92 }))
    expect(detail).not.toHaveProperty('confidence')
    expect(detail).not.toHaveProperty('ownerUid')
  })

  it('does not modify the document data', () => {
    const data = Object.freeze(storedWith({ likelyCause: 42 }))
    expect(() => parseIncidentDetail(ID, data, EXPECTED)).not.toThrow()
    expect(data.likelyCause).toBe(42)
  })
})

describe('parseIncidentDetail — fails closed', () => {
  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['missing', undefined],
  ])(
    'rejects a record whose isSimulated is %s, carrying none of its fields',
    (_label, isSimulated) => {
      const data =
        isSimulated === undefined ? withoutField('isSimulated') : storedWith({ isSimulated })
      expect(parseIncidentDetail(ID, data, EXPECTED)).toEqual({
        ok: false,
        id: ID,
        reason: 'NOT_SIMULATED',
      })
    }
  )

  it.each([null, undefined, 'text', 42, ['a']])('rejects a document whose data is %s', (data) => {
    expect(parseIncidentDetail(ID, data, EXPECTED)).toEqual({
      ok: false,
      id: ID,
      reason: 'NOT_SIMULATED',
    })
  })

  it("rejects another operator's incident", () => {
    expect(parseIncidentDetail(ID, asStored(FIRST), { ownerUid: OTHER })).toEqual({
      ok: false,
      id: ID,
      reason: 'OWNER_MISMATCH',
    })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
  ])('rejects a record whose ownerUid is %s', (_label, ownerUid) => {
    const data = ownerUid === undefined ? withoutField('ownerUid') : storedWith({ ownerUid })
    expect(parseIncidentDetail(ID, data, EXPECTED)).toMatchObject({
      ok: false,
      reason: 'OWNER_MISMATCH',
    })
  })

  it('reports a non-simulated record as such even when the owner also differs', () => {
    const data = storedWith({ isSimulated: false, ownerUid: OTHER })
    expect(parseIncidentDetail(ID, data, EXPECTED)).toMatchObject({
      ok: false,
      reason: 'NOT_SIMULATED',
    })
  })
})

describe('parseIncidentDetail — missing or unexpected fields become null and are reported', () => {
  it.each(['likelyCause', 'evidenceSummary', 'recommendedAction'])('%s missing', (field) => {
    const detail = parseDetail(withoutField(field))
    expect(detail[field as 'likelyCause']).toBeNull()
    expect(detail.dataIssues).toEqual([field])
  })

  it.each([
    ['blank', '   '],
    ['a number', 7],
    ['an object', { text: 'x' }],
  ])('an evidence field that is %s', (_label, value) => {
    const detail = parseDetail(storedWith({ evidenceSummary: value }))
    expect(detail.evidenceSummary).toBeNull()
    expect(detail.dataIssues).toEqual(['evidenceSummary'])
  })

  it.each([['NSW'], ['vic'], [''], [undefined]])('state %s', (state) => {
    const data = state === undefined ? withoutField('state') : storedWith({ state })
    const detail = parseDetail(data)
    expect(detail.state).toBeNull()
    expect(detail.dataIssues).toEqual(['state'])
  })

  it.each([
    ['missing', undefined],
    ['an ISO string', '2026-10-20T00:00:00Z'],
    ['a plain Date', new Date('2026-10-20T00:00:00Z')],
    ['an invalid Timestamp', new Timestamp(Number.NaN, 0)],
  ])('createdAt %s', (_label, createdAt) => {
    const data = createdAt === undefined ? withoutField('createdAt') : storedWith({ createdAt })
    const detail = parseDetail(data)
    expect(detail.createdAt).toBeNull()
    expect(detail.dataIssues).toEqual(['createdAt'])
  })

  it.each([[2], ['1'], [undefined]])(
    'reports _schemaVersion %s but still shows the checked values',
    (version) => {
      const data =
        version === undefined
          ? withoutField('_schemaVersion')
          : storedWith({ _schemaVersion: version })
      const detail = parseDetail(data)
      expect(detail.dataIssues).toEqual(['_schemaVersion'])
      expect(detail.likelyCause).toBe(FIRST.data.likelyCause)
    }
  )

  it('keeps the queue-field issues first, then the detail issues, without duplicates', () => {
    const detail = parseDetail(
      storedWith({ deviceId: '', status: 'BROKEN', recommendedAction: null, state: 'NSW' })
    )
    expect(detail.deviceId).toBeNull()
    expect(detail.status).toBeNull()
    expect(detail.recommendedAction).toBeNull()
    expect(detail.dataIssues).toEqual(['deviceId', 'status', 'state', 'recommendedAction'])
  })

  it('fills nothing in: a record with only the required markers has every field null', () => {
    const detail = parseDetail({ isSimulated: true, ownerUid: OWNER, _schemaVersion: 1 })
    expect(detail).toEqual({
      id: ID,
      incidentCode: null,
      deviceId: null,
      suburb: null,
      postcode: null,
      status: null,
      causeCategory: null,
      lastSignalAt: null,
      state: null,
      likelyCause: null,
      evidenceSummary: null,
      recommendedAction: null,
      createdAt: null,
      dataIssues: [
        'incidentCode',
        'deviceId',
        'suburb',
        'postcode',
        'status',
        'causeCategory',
        'lastSignalAt',
        'state',
        'likelyCause',
        'evidenceSummary',
        'recommendedAction',
        'createdAt',
      ],
    })
  })

  it('keeps long evidence text exactly as stored (no truncation)', () => {
    const long = `${'Simulated evidence. '.repeat(200)}End.`
    expect(parseDetail(storedWith({ evidenceSummary: long })).evidenceSummary).toBe(long)
  })
})
