import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import {
  CAUSE_CATEGORY_LABELS,
  FALLBACK_LABELS,
  NOT_IN_DATASET_LABELS,
} from '@/features/incidents/labels'
import type { ReviewedIncidentRow } from '@/features/incidents/types'
import { IncidentStatusBadge, ReviewStatusBadge } from './IncidentBadges'
import { IncidentTime } from './IncidentTime'
import { Text } from './MissingValue'

/**
 * The incident detail route (Phase 5); the ID is encoded so any document ID is a safe path segment.
 * The links use prefetch={false}: prefetching each visible incident would run the
 * (dashboard) layout's session check (a Firebase revocation lookup) per link.
 */
export function incidentHref(id: string): string {
  return `/dashboard/incidents/${encodeURIComponent(id)}`
}

function linkLabel(row: ReviewedIncidentRow): string {
  return `Open incident ${row.incidentCode ?? 'with missing code'}`
}

function Location({ row }: { row: ReviewedIncidentRow }) {
  return (
    <>
      <Text value={row.suburb} /> <Text value={row.postcode} />
    </>
  )
}

function Cause({ row }: { row: ReviewedIncidentRow }) {
  return row.causeCategory
    ? CAUSE_CATEGORY_LABELS[row.causeCategory]
    : FALLBACK_LABELS.causeCategory
}

/** A legacy (version 1) record has no report time at all — said plainly, never estimated. */
function Reported({ row }: { row: ReviewedIncidentRow }) {
  return (
    <IncidentTime
      at={row.reportedAt}
      fallback={
        row.legacyTimeline ? NOT_IN_DATASET_LABELS.legacyReportedAt : FALLBACK_LABELS.reportedAt
      }
    />
  )
}

/** Visual cue only: the incident link (one per row) already carries the accessible name. */
function OpenCue({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center gap-0.5 text-sm font-medium whitespace-nowrap text-zinc-900 group-hover:underline dark:text-zinc-100 ${className ?? ''}`}
    >
      Review
      <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
    </span>
  )
}

interface IncidentQueueProps {
  rows: readonly ReviewedIncidentRow[]
  /** Describes the rows, e.g. "Awaiting review incidents" — the table caption and list label. */
  label: string
}

/**
 * The incident list: a table from xl up (wide enough beside the sidebar), cards below
 * (two per row from sm). Both are
 * rendered and one is hidden with CSS (display: none), which also removes it
 * from the accessibility tree, so screen readers meet each incident once.
 *
 * Each incident has exactly one link per layout (its code, named "Open
 * incident …"). Its ::after overlay stretches over the whole row or card, so
 * clicking anywhere on it opens the incident, while keyboard and screen-reader
 * users meet one short, named target.
 */
export function IncidentQueue({ rows, label }: IncidentQueueProps) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm xl:block dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {label}. Times are simulated and shown in Melbourne time. Select an incident to review
            it.
          </caption>
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:bg-zinc-950">
            <tr>
              {[
                'Incident',
                'Location',
                'Pendant',
                'Cause category',
                'Reported / last signal (simulated)',
                'Review',
              ].map((heading) => (
                <th key={heading} scope="col" className="px-4 py-3 align-bottom">
                  {heading}
                </th>
              ))}
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => (
              <tr
                key={row.id}
                className="group relative cursor-pointer transition-colors focus-within:bg-zinc-50 hover:bg-zinc-50 dark:focus-within:bg-zinc-800/50 dark:hover:bg-zinc-800/50"
              >
                <th scope="row" className="px-4 py-3 font-medium whitespace-nowrap">
                  <Link
                    href={incidentHref(row.id)}
                    prefetch={false}
                    aria-label={linkLabel(row)}
                    className="rounded-sm after:absolute after:inset-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100"
                  >
                    <Text value={row.incidentCode} />
                  </Link>
                  <span className="block font-mono text-xs font-normal text-zinc-500">
                    <Text value={row.deviceId} />
                  </span>
                </th>
                <td className="px-4 py-3">
                  <Location row={row} />
                </td>
                <td className="px-4 py-3">
                  <IncidentStatusBadge status={row.status} />
                </td>
                <td className="px-4 py-3">
                  <Cause row={row} />
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  <span className="block">
                    <Reported row={row} />
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    Last signal{' '}
                    <IncidentTime at={row.lastSignalAt} fallback={FALLBACK_LABELS.lastSignalAt} />
                  </span>
                </td>
                <td className="px-4 py-3">
                  <ReviewStatusBadge status={row.reviewStatus} />
                </td>
                <td className="px-4 py-3 text-right">
                  <OpenCue />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={label} className="grid gap-3 sm:grid-cols-2 xl:hidden">
        {rows.map((row) => (
          <li
            key={row.id}
            className="group relative rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-zinc-900 hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:ring-zinc-100 dark:hover:border-zinc-600"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="font-semibold">
                <Link
                  href={incidentHref(row.id)}
                  prefetch={false}
                  aria-label={linkLabel(row)}
                  className="after:absolute after:inset-0 focus-visible:outline-none"
                >
                  <Text value={row.incidentCode} />
                </Link>
              </p>
              <ReviewStatusBadge status={row.reviewStatus} />
            </div>
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-zinc-500">Pendant</dt>
              <dd>
                <IncidentStatusBadge status={row.status} />
              </dd>
              <dt className="text-zinc-500">Location</dt>
              <dd>
                <Location row={row} />
              </dd>
              <dt className="text-zinc-500">Cause</dt>
              <dd>
                <Cause row={row} />
              </dd>
              <dt className="text-zinc-500">Reported</dt>
              <dd>
                <Reported row={row} />
              </dd>
              <dt className="text-zinc-500">Last signal</dt>
              <dd>
                <IncidentTime at={row.lastSignalAt} fallback={FALLBACK_LABELS.lastSignalAt} />
              </dd>
              <dt className="text-zinc-500">Device</dt>
              <dd className="font-mono text-xs leading-5">
                <Text value={row.deviceId} />
              </dd>
            </dl>
            <div className="mt-3 flex justify-end border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <OpenCue />
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
