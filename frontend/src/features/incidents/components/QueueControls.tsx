'use client'

import { useId } from 'react'
import { Search, X } from 'lucide-react'
import { INCIDENT_STATUS_DESCRIPTIONS, INCIDENT_STATUS_LABELS } from '@/features/incidents/labels'
import {
  QUEUE_SORTS,
  QUEUE_SORT_LABELS,
  hasActiveFilters,
  isInvertedRange,
  type ConnectivityFilter,
  type QueueFilters,
  type QueueSort,
} from '@/features/incidents/queueView'

const FIELD =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-visible:outline-zinc-100'
const LABEL = 'block text-xs font-medium text-zinc-600 dark:text-zinc-400'

const CONNECTIVITY_OPTIONS: { value: ConnectivityFilter; label: string }[] = [
  { value: 'ALL', label: 'All pendants' },
  { value: 'OFFLINE', label: INCIDENT_STATUS_LABELS.OFFLINE },
  { value: 'SILENT', label: INCIDENT_STATUS_LABELS.SILENT },
]

interface QueueControlsProps {
  filters: QueueFilters
  sort: QueueSort
  /** Earliest/latest report dates in the data (`YYYY-MM-DD`), for the date pickers. */
  dateBounds: { min: string; max: string } | null
  onFiltersChange: (filters: QueueFilters) => void
  onSortChange: (sort: QueueSort) => void
  onClear: () => void
}

/**
 * Search, connectivity, report-date range and sort for the queue. Native form
 * controls with visible labels, so keyboard and screen-reader use work as
 * usual; changes apply as you type or pick — there is no submit step.
 */
export function QueueControls({
  filters,
  sort,
  dateBounds,
  onFiltersChange,
  onSortChange,
  onClear,
}: QueueControlsProps) {
  const id = useId()
  const set = (patch: Partial<QueueFilters>) => onFiltersChange({ ...filters, ...patch })
  const inverted = isInvertedRange(filters)

  return (
    <section
      aria-label="Search and filter incidents"
      className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm sm:p-4 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
        <div className="col-span-2 lg:col-span-1">
          <label htmlFor={`${id}-search`} className={LABEL}>
            Search
          </label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 mt-0.5 size-4 -translate-y-1/2 text-zinc-400"
            />
            <input
              id={`${id}-search`}
              type="search"
              value={filters.search}
              onChange={(event) => set({ search: event.target.value })}
              placeholder="Incident, device, suburb or postcode"
              aria-describedby={`${id}-search-hint`}
              autoComplete="off"
              className={`${FIELD} pl-9`}
            />
          </div>
          <p id={`${id}-search-hint`} className="sr-only">
            Matches incident code, device ID, suburb and postcode. Separate words to match all of
            them.
          </p>
        </div>

        <div className="col-span-2 sm:col-span-1">
          <label htmlFor={`${id}-connectivity`} className={LABEL}>
            Pendant connectivity
          </label>
          <select
            id={`${id}-connectivity`}
            value={filters.connectivity}
            onChange={(event) => set({ connectivity: event.target.value as ConnectivityFilter })}
            className={FIELD}
          >
            {CONNECTIVITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`${id}-from`} className={LABEL}>
            Reported from
          </label>
          <input
            id={`${id}-from`}
            type="date"
            value={filters.reportedFrom}
            min={dateBounds?.min}
            max={dateBounds?.max}
            onChange={(event) => set({ reportedFrom: event.target.value })}
            aria-invalid={inverted || undefined}
            aria-describedby={inverted ? `${id}-range-error` : undefined}
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor={`${id}-to`} className={LABEL}>
            Reported to
          </label>
          <input
            id={`${id}-to`}
            type="date"
            value={filters.reportedTo}
            min={dateBounds?.min}
            max={dateBounds?.max}
            onChange={(event) => set({ reportedTo: event.target.value })}
            aria-invalid={inverted || undefined}
            aria-describedby={inverted ? `${id}-range-error` : undefined}
            className={FIELD}
          />
        </div>

        <div className="col-span-2 sm:col-span-1">
          <label htmlFor={`${id}-sort`} className={LABEL}>
            Sort by
          </label>
          <select
            id={`${id}-sort`}
            value={sort}
            onChange={(event) => onSortChange(event.target.value as QueueSort)}
            className={FIELD}
          >
            {QUEUE_SORTS.map((option) => (
              <option key={option} value={option}>
                {QUEUE_SORT_LABELS[option]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {inverted && (
        <p
          id={`${id}-range-error`}
          role="alert"
          className="mt-2 text-sm text-red-700 dark:text-red-400"
        >
          “Reported from” is after “Reported to”, so no incident can match. Change one of the dates.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2 border-t border-zinc-100 pt-3 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between dark:border-zinc-800 dark:text-zinc-400">
        <p>
          Dates are Melbourne calendar days (inclusive) of the simulated report time.{' '}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {INCIDENT_STATUS_LABELS.OFFLINE}:
          </span>{' '}
          {INCIDENT_STATUS_DESCRIPTIONS.OFFLINE}{' '}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {INCIDENT_STATUS_LABELS.SILENT}:
          </span>{' '}
          {INCIDENT_STATUS_DESCRIPTIONS.SILENT}
        </p>
        <button
          type="button"
          onClick={onClear}
          disabled={!hasActiveFilters(filters)}
          className="inline-flex shrink-0 items-center gap-1 self-start rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:focus-visible:outline-zinc-100"
        >
          <X aria-hidden="true" className="size-4" />
          Clear filters
        </button>
      </div>
    </section>
  )
}
