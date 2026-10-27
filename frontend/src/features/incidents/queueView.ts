import type { Incident } from '@/types/firestore'
import { DATE_KEY_PATTERN, melbourneDateKey } from '@/lib/melbourneTime'
import type { ReviewedIncidentRow } from './types'

/**
 * Search, filters and sorting for the incident queue (Phase 6).
 *
 * Pure functions over the rows the owner-scoped listener already delivered:
 * no Firestore query, rule or index is involved, and the review counts are
 * untouched (they come from deriveReviewSummary). The review-status tabs
 * still filter first (filterByTab); these refine the tab's rows.
 */

export type ConnectivityFilter = 'ALL' | Incident['status']

export interface QueueFilters {
  /** Free text over incident code, device ID, suburb and postcode. */
  search: string
  connectivity: ConnectivityFilter
  /** Inclusive Melbourne calendar dates (`YYYY-MM-DD`) on the report time; '' = no bound. */
  reportedFrom: string
  reportedTo: string
}

export const DEFAULT_FILTERS: QueueFilters = {
  search: '',
  connectivity: 'ALL',
  reportedFrom: '',
  reportedTo: '',
}

export const QUEUE_SORTS = [
  'REPORTED_DESC',
  'REPORTED_ASC',
  'SIGNAL_DESC',
  'SIGNAL_ASC',
  'CODE_ASC',
  'LOCATION_ASC',
] as const

export type QueueSort = (typeof QUEUE_SORTS)[number]

export const DEFAULT_SORT: QueueSort = 'REPORTED_DESC'

export const QUEUE_SORT_LABELS: Record<QueueSort, string> = {
  REPORTED_DESC: 'Newest reported',
  REPORTED_ASC: 'Oldest reported',
  SIGNAL_DESC: 'Newest last signal',
  SIGNAL_ASC: 'Oldest last signal',
  CODE_ASC: 'Incident code',
  LOCATION_ASC: 'Location (A–Z)',
}

/** Lower-case words of a search query; whitespace of any kind and amount separates them. */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Letters and digits only, so "inc001" finds "INC-001" and "sc 1234" finds "SC-1234". */
function compact(value: string): string {
  return value.replace(/[^a-z0-9]/g, '')
}

/**
 * True when every search term appears in at least one of the row's searchable
 * fields (case-insensitive; punctuation-insensitive as a fallback). An empty
 * query matches everything.
 */
export function matchesSearch(row: ReviewedIncidentRow, query: string): boolean {
  const fields = [row.incidentCode, row.deviceId, row.suburb, row.postcode]
    .filter((value): value is string => value !== null)
    .map((value) => value.toLowerCase())
  return searchTerms(query).every((term) => {
    const compactTerm = compact(term)
    return fields.some(
      (field) =>
        field.includes(term) || (compactTerm !== '' && compact(field).includes(compactTerm))
    )
  })
}

export function isDateKey(value: string): boolean {
  return DATE_KEY_PATTERN.test(value)
}

/** From is after To — no date can satisfy both, so the queue says so instead of guessing. */
export function isInvertedRange({ reportedFrom, reportedTo }: QueueFilters): boolean {
  return isDateKey(reportedFrom) && isDateKey(reportedTo) && reportedFrom > reportedTo
}

/**
 * Inclusive Melbourne-date bounds on the report time. Dates compare as
 * `YYYY-MM-DD` strings, so no time-zone arithmetic is needed. A row without a
 * report time (a legacy record) can't be placed in a range, so it is left out
 * whenever a bound is set.
 */
function withinReportedRange(row: ReviewedIncidentRow, from: string, to: string): boolean {
  if (from === '' && to === '') return true
  if (row.reportedAt === null) return false
  const day = melbourneDateKey(row.reportedAt)
  return (from === '' || day >= from) && (to === '' || day <= to)
}

/** Ignores a malformed bound (as an empty one), e.g. a half-typed date. */
function bound(value: string): string {
  return isDateKey(value) ? value : ''
}

export function hasActiveFilters(filters: QueueFilters): boolean {
  return (
    searchTerms(filters.search).length > 0 ||
    filters.connectivity !== 'ALL' ||
    bound(filters.reportedFrom) !== '' ||
    bound(filters.reportedTo) !== ''
  )
}

export function applyFilters(
  rows: readonly ReviewedIncidentRow[],
  filters: QueueFilters
): ReviewedIncidentRow[] {
  if (isInvertedRange(filters)) return []
  const from = bound(filters.reportedFrom)
  const to = bound(filters.reportedTo)
  return rows.filter(
    (row) =>
      (filters.connectivity === 'ALL' || row.status === filters.connectivity) &&
      matchesSearch(row, filters.search) &&
      withinReportedRange(row, from, to)
  )
}

/** Missing values sort last in either direction. */
function compareNullable<T>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compare(a, b)
}

const byTime = (x: Date, y: Date) => x.getTime() - y.getTime()
/** Plain code-unit order: deterministic and locale-independent. */
const byText = (x: string, y: string) => (x === y ? 0 : x < y ? -1 : 1)

function primary(sort: QueueSort, a: ReviewedIncidentRow, b: ReviewedIncidentRow): number {
  switch (sort) {
    case 'REPORTED_DESC':
      return compareNullable(a.reportedAt, b.reportedAt, (x, y) => byTime(y, x))
    case 'REPORTED_ASC':
      return compareNullable(a.reportedAt, b.reportedAt, byTime)
    case 'SIGNAL_DESC':
      return compareNullable(a.lastSignalAt, b.lastSignalAt, (x, y) => byTime(y, x))
    case 'SIGNAL_ASC':
      return compareNullable(a.lastSignalAt, b.lastSignalAt, byTime)
    case 'CODE_ASC':
      return compareNullable(a.incidentCode, b.incidentCode, byText)
    case 'LOCATION_ASC':
      return (
        compareNullable(a.suburb, b.suburb, (x, y) => byText(x.toLowerCase(), y.toLowerCase())) ||
        compareNullable(a.postcode, b.postcode, byText)
      )
  }
}

/**
 * Sorted copy of `rows`. Ties fall back to incident code, then document ID
 * (unique), so every order is fully deterministic.
 */
export function sortRows(
  rows: readonly ReviewedIncidentRow[],
  sort: QueueSort
): ReviewedIncidentRow[] {
  return [...rows].sort(
    (a, b) =>
      primary(sort, a, b) ||
      compareNullable(a.incidentCode, b.incidentCode, byText) ||
      byText(a.id, b.id)
  )
}

/** Filters, then sorts. Always returns a new array; inputs are not modified. */
export function applyQueueView(
  rows: readonly ReviewedIncidentRow[],
  filters: QueueFilters,
  sort: QueueSort
): ReviewedIncidentRow[] {
  return sortRows(applyFilters(rows, filters), sort)
}

/** Earliest and latest report dates among the rows, for the date inputs' min and max. */
export function reportedDateBounds(
  rows: readonly ReviewedIncidentRow[]
): { min: string; max: string } | null {
  const days = rows
    .flatMap((row) => (row.reportedAt ? [melbourneDateKey(row.reportedAt)] : []))
    .sort()
  if (days.length === 0) return null
  return { min: days[0]!, max: days[days.length - 1]! }
}
