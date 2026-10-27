// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILTERS,
  applyFilters,
  applyQueueView,
  hasActiveFilters,
  isInvertedRange,
  matchesSearch,
  reportedDateBounds,
  searchTerms,
  sortRows,
  type QueueFilters,
} from '@/features/incidents/queueView'
import type { ReviewedIncidentRow } from '@/features/incidents/types'

function row(overrides: Partial<ReviewedIncidentRow> & { id: string }): ReviewedIncidentRow {
  return {
    incidentCode: 'INC-001',
    deviceId: 'SC-1000',
    suburb: 'Ballarat',
    postcode: '3350',
    status: 'OFFLINE',
    causeCategory: 'UNPLANNED_OUTAGE',
    reportedAt: new Date('2026-09-04T08:23:40Z'),
    lastSignalAt: new Date('2026-09-04T07:48:26Z'),
    legacyTimeline: false,
    dataIssues: [],
    reviewStatus: 'AWAITING_REVIEW',
    ...overrides,
  }
}

const filters = (patch: Partial<QueueFilters>): QueueFilters => ({ ...DEFAULT_FILTERS, ...patch })
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

describe('search', () => {
  const r = row({
    id: 'a',
    incidentCode: 'INC-018',
    deviceId: 'SC-7531',
    suburb: 'Lakes Entrance',
    postcode: '3909',
  })

  it('splits on any whitespace and lower-cases', () => {
    expect(searchTerms('  Lakes\t ENTRANCE \n')).toEqual(['lakes', 'entrance'])
    expect(searchTerms('   ')).toEqual([])
  })

  it.each([
    ['', true],
    ['lakes', true],
    ['LAKES ENTRANCE', true],
    ['entrance 3909', true], // every word must match some field
    ['inc-018', true],
    ['inc018', true], // punctuation-insensitive fallback
    ['sc 7531', true],
    ['7531', true],
    ['lakes 3000', false],
    ['ballarat', false],
    ['-', true], // punctuation-only words only have to match literally
  ])('%j → %s', (query, expected) => {
    expect(matchesSearch(r, query)).toBe(expected)
  })

  it('ignores missing fields instead of matching "null"', () => {
    expect(matchesSearch(row({ id: 'b', suburb: null }), 'null')).toBe(false)
  })
})

describe('filters', () => {
  const rows = [
    row({ id: 'sep1', status: 'OFFLINE', reportedAt: new Date('2026-08-31T21:22:05Z') }), // 1 Sep 7:22 am AEST
    row({ id: 'sep30', status: 'SILENT', reportedAt: new Date('2026-09-30T13:59:59Z') }), // 30 Sep 11:59:59 pm AEST
    row({ id: 'oct1', status: 'SILENT', reportedAt: new Date('2026-09-30T14:00:00Z') }), // 1 Oct 12:00 am AEST
    row({ id: 'legacy', reportedAt: null, legacyTimeline: true }),
  ]

  it('applies date bounds inclusively on Melbourne dates', () => {
    expect(
      ids(applyFilters(rows, filters({ reportedFrom: '2026-09-01', reportedTo: '2026-09-30' })))
    ).toEqual(['sep1', 'sep30'])
    expect(ids(applyFilters(rows, filters({ reportedFrom: '2026-10-01' })))).toEqual(['oct1'])
    expect(ids(applyFilters(rows, filters({ reportedTo: '2026-09-01' })))).toEqual(['sep1'])
  })

  it('leaves out rows without a report time only when a date bound is set', () => {
    expect(ids(applyFilters(rows, DEFAULT_FILTERS))).toContain('legacy')
    expect(ids(applyFilters(rows, filters({ reportedFrom: '2000-01-01' })))).not.toContain('legacy')
  })

  it('ignores a malformed (half-typed) date bound', () => {
    expect(applyFilters(rows, filters({ reportedFrom: '2026-1' }))).toHaveLength(4)
    expect(hasActiveFilters(filters({ reportedFrom: '2026-1' }))).toBe(false)
  })

  it('an inverted range matches nothing', () => {
    const inverted = filters({ reportedFrom: '2026-10-01', reportedTo: '2026-09-01' })
    expect(isInvertedRange(inverted)).toBe(true)
    expect(applyFilters(rows, inverted)).toEqual([])
    expect(isInvertedRange(filters({ reportedFrom: '2026-09-01', reportedTo: '2026-09-01' }))).toBe(
      false
    )
  })

  it('combines connectivity, search and date (all must hold)', () => {
    expect(ids(applyFilters(rows, filters({ connectivity: 'SILENT' })))).toEqual(['sep30', 'oct1'])
    expect(
      ids(
        applyFilters(
          rows,
          filters({ connectivity: 'SILENT', reportedTo: '2026-09-30', search: 'ballarat' })
        )
      )
    ).toEqual(['sep30'])
  })

  it('knows when anything is filtered', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false)
    expect(hasActiveFilters(filters({ search: '   ' }))).toBe(false)
    expect(hasActiveFilters(filters({ search: 'x' }))).toBe(true)
    expect(hasActiveFilters(filters({ connectivity: 'OFFLINE' }))).toBe(true)
    expect(hasActiveFilters(filters({ reportedTo: '2026-10-01' }))).toBe(true)
  })

  it('does not modify its input', () => {
    const copy = [...rows]
    applyQueueView(rows, filters({ connectivity: 'SILENT' }), 'CODE_ASC')
    expect(rows).toEqual(copy)
  })
})

describe('sorting', () => {
  const a = row({
    id: 'a',
    incidentCode: 'INC-002',
    suburb: 'bendigo',
    reportedAt: new Date('2026-10-01T00:00:00Z'),
    lastSignalAt: new Date('2026-09-30T00:00:00Z'),
  })
  const b = row({
    id: 'b',
    incidentCode: 'INC-001',
    suburb: 'Ararat',
    reportedAt: new Date('2026-10-02T00:00:00Z'),
    lastSignalAt: new Date('2026-09-29T00:00:00Z'),
  })
  const tieA = row({
    id: 'z',
    incidentCode: 'INC-003',
    suburb: 'Ararat',
    postcode: '3377',
    reportedAt: new Date('2026-10-02T00:00:00Z'),
  })
  const tieB = row({
    id: 'y',
    incidentCode: 'INC-003',
    suburb: 'Ararat',
    postcode: '3377',
    reportedAt: new Date('2026-10-02T00:00:00Z'),
  })
  const missing = row({
    id: 'm',
    incidentCode: null,
    suburb: null,
    reportedAt: null,
    lastSignalAt: null,
  })

  it.each([
    ['REPORTED_DESC', ['b', 'y', 'z', 'a', 'm']],
    ['REPORTED_ASC', ['a', 'b', 'y', 'z', 'm']],
    ['SIGNAL_DESC', ['a', 'b', 'y', 'z', 'm']],
    ['SIGNAL_ASC', ['y', 'z', 'b', 'a', 'm']],
    ['CODE_ASC', ['b', 'a', 'y', 'z', 'm']],
    ['LOCATION_ASC', ['b', 'y', 'z', 'a', 'm']], // case-insensitive suburb, then postcode, then code, then ID
  ] as const)('%s, missing values last, ties broken by code then document ID', (sort, expected) => {
    expect(ids(sortRows([missing, a, tieA, b, tieB], sort))).toEqual(expected)
  })

  it('is deterministic whatever the input order', () => {
    const input = [missing, a, tieA, b, tieB]
    const reversed = [...input].reverse()
    for (const sort of ['REPORTED_DESC', 'LOCATION_ASC', 'SIGNAL_ASC'] as const) {
      expect(ids(sortRows(input, sort))).toEqual(ids(sortRows(reversed, sort)))
    }
  })
})

describe('reportedDateBounds', () => {
  it('gives the earliest and latest Melbourne report dates, ignoring rows without one', () => {
    expect(
      reportedDateBounds([
        row({ id: '1', reportedAt: new Date('2026-10-20T09:12:07Z') }),
        row({ id: '2', reportedAt: null }),
        row({ id: '3', reportedAt: new Date('2026-08-31T21:22:05Z') }),
      ])
    ).toEqual({ min: '2026-09-01', max: '2026-10-20' })
    expect(reportedDateBounds([row({ id: '1', reportedAt: null })])).toBeNull()
  })
})
