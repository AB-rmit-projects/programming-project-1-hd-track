// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase/firestore'
import { parseIncident } from '@/features/incidents/incidentRow'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import { buildSeedIncidents, type SeedRecord } from '../../../../scripts/seed-incidents/dataset'

const OWNER = 'demoOperatorUid01'
const NOW = new Date('2026-10-21T00:00:00.000Z')

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
function parseRow(data: unknown) {
  const parsed = parseIncident(ID, data)
  if (!parsed.ok) throw new Error(`expected the record to be accepted, got ${parsed.reason}`)
  return parsed.row
}

describe('parseIncident — valid seeded records', () => {
  it('maps a stored seed record to a row with no data issues', () => {
    expect(parseIncident(ID, asStored(FIRST))).toEqual({
      ok: true,
      row: {
        id: ID,
        incidentCode: FIRST.data.incidentCode,
        deviceId: FIRST.data.deviceId,
        suburb: FIRST.data.suburb,
        postcode: FIRST.data.postcode,
        status: FIRST.data.status,
        causeCategory: FIRST.data.causeCategory,
        lastSignalAt: FIRST.data.lastSignalAt,
        dataIssues: [],
      },
    })
  })

  it('accepts all 50 Phase 3 seed records without issues', () => {
    const rows = SEED.map((record) => parseRow(asStored(record)))
    expect(rows).toHaveLength(50)
    expect(rows.every((row) => row.dataIssues.length === 0)).toBe(true)
  })

  it('keeps the document ID it was given', () => {
    expect(parseRow(asStored(FIRST)).id).toBe(ID)
  })

  it('does not modify the document data', () => {
    const data = Object.freeze(storedWith({ status: 'BROKEN' }))
    expect(() => parseIncident(ID, data)).not.toThrow()
    expect(data.status).toBe('BROKEN')
  })
})

describe('parseIncident — isSimulated must be exactly true', () => {
  it.each([
    ['false', false],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
    ['an object', { value: true }],
  ])('rejects isSimulated set to %s', (_label, value) => {
    expect(parseIncident(ID, storedWith({ isSimulated: value }))).toEqual({
      ok: false,
      id: ID,
      reason: 'NOT_SIMULATED',
    })
  })

  it('rejects a record with no isSimulated field', () => {
    expect(parseIncident(ID, withoutField('isSimulated'))).toEqual({
      ok: false,
      id: ID,
      reason: 'NOT_SIMULATED',
    })
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'INC-001'],
    ['an array', [{ isSimulated: true }]],
  ])('rejects document data that is %s', (_label, data) => {
    expect(parseIncident(ID, data)).toEqual({ ok: false, id: ID, reason: 'NOT_SIMULATED' })
  })

  it('a rejected record carries none of its fields, only the ID and the reason', () => {
    const parsed = parseIncident(ID, storedWith({ isSimulated: false }))
    expect(Object.keys(parsed).sort()).toEqual(['id', 'ok', 'reason'])
  })
})

describe('parseIncident — other malformed fields fall back and are recorded', () => {
  const TEXT_FIELDS = ['incidentCode', 'deviceId', 'suburb', 'postcode'] as const

  it.each(TEXT_FIELDS)('%s: missing → null + issue', (field) => {
    const row = parseRow(withoutField(field))
    expect(row[field]).toBeNull()
    expect(row.dataIssues).toEqual([field])
  })

  it.each(TEXT_FIELDS)('%s: empty or whitespace-only → null + issue', (field) => {
    for (const value of ['', '   ']) {
      const row = parseRow(storedWith({ [field]: value }))
      expect(row[field]).toBeNull()
      expect(row.dataIssues).toEqual([field])
    }
  })

  it.each(TEXT_FIELDS)('%s: not a string → null + issue', (field) => {
    const row = parseRow(storedWith({ [field]: 3350 }))
    expect(row[field]).toBeNull()
    expect(row.dataIssues).toEqual([field])
  })

  it.each([['UNKNOWN'], ['offline'], [''], [7], [null]])('status %j → null + issue', (value) => {
    const row = parseRow(storedWith({ status: value }))
    expect(row.status).toBeNull()
    expect(row.dataIssues).toEqual(['status'])
  })

  it.each([['SOLAR_FLARE'], ['unplanned_outage'], ['toString'], ['__proto__'], [42]])(
    'causeCategory %j → null + issue',
    (value) => {
      const row = parseRow(storedWith({ causeCategory: value }))
      expect(row.causeCategory).toBeNull()
      expect(row.dataIssues).toEqual(['causeCategory'])
    }
  )

  it('records every problem field in a badly damaged record, in field order', () => {
    const row = parseRow({ isSimulated: true, suburb: 'Ballarat', status: 'SILENT' })
    expect(row).toEqual({
      id: ID,
      incidentCode: null,
      deviceId: null,
      suburb: 'Ballarat',
      postcode: null,
      status: 'SILENT',
      causeCategory: null,
      lastSignalAt: null,
      dataIssues: ['incidentCode', 'deviceId', 'postcode', 'causeCategory', 'lastSignalAt'],
    })
  })
})

describe('parseIncident — lastSignalAt', () => {
  it('converts a Firestore Timestamp to the same instant', () => {
    const at = new Date('2026-10-20T21:45:30.123Z')
    expect(parseRow(storedWith({ lastSignalAt: Timestamp.fromDate(at) })).lastSignalAt).toEqual(at)
  })

  it('missing → null + issue', () => {
    const row = parseRow(withoutField('lastSignalAt'))
    expect(row.lastSignalAt).toBeNull()
    expect(row.dataIssues).toEqual(['lastSignalAt'])
  })

  it.each([
    ['an ISO string', '2026-10-20T21:45:30.000Z'],
    ['epoch milliseconds', 1_792_000_000_000],
    ['a plain Date (the client SDK never returns one)', new Date('2026-10-20T21:45:30.000Z')],
    ['a Timestamp-like object that is not a Timestamp', { toDate: () => new Date() }],
    ['null', null],
  ])('%s → null + issue', (_label, value) => {
    const row = parseRow(storedWith({ lastSignalAt: value }))
    expect(row.lastSignalAt).toBeNull()
    expect(row.dataIssues).toEqual(['lastSignalAt'])
  })

  it('a Timestamp that converts to an invalid Date → null + issue', () => {
    const row = parseRow(storedWith({ lastSignalAt: new Timestamp(Number.NaN, 0) }))
    expect(row.lastSignalAt).toBeNull()
    expect(row.dataIssues).toEqual(['lastSignalAt'])
  })
})
