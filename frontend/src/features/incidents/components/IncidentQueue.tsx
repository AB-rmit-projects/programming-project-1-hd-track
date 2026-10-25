import Link from 'next/link'
import { formatDatetime } from '@/lib/utils'
import { CAUSE_CATEGORY_LABELS, FALLBACK_LABELS } from '@/features/incidents/labels'
import type { ReviewedIncidentRow } from '@/features/incidents/types'
import { IncidentStatusBadge, ReviewStatusBadge } from './IncidentBadges'
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

function LastSignal({ at }: { at: Date | null }) {
  if (!at) return FALLBACK_LABELS.lastSignalAt
  return <time dateTime={at.toISOString()}>{formatDatetime(at)}</time>
}

const LINK_FOCUS =
  'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 dark:focus-visible:outline-zinc-100'

interface IncidentQueueProps {
  rows: readonly ReviewedIncidentRow[]
  /** Describes the rows, e.g. "Awaiting review incidents" — the table caption and list label. */
  label: string
}

/**
 * The incident list: a table from md up, stacked cards below. Both are
 * rendered and one is hidden with CSS (display: none), which also removes it
 * from the accessibility tree, so screen readers meet each incident once.
 * Each incident has exactly one link per layout.
 */
export function IncidentQueue({ rows, label }: IncidentQueueProps) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-zinc-200 bg-white shadow-sm md:block dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">
            {label}. Awaiting review first, then the longest without a signal.
          </caption>
          <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:bg-zinc-950">
            <tr>
              {[
                'Incident',
                'Device',
                'Location',
                'Status',
                'Cause category',
                'Last signal',
                'Review',
              ].map((heading) => (
                <th key={heading} scope="col" className="px-4 py-3 whitespace-nowrap">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                <th scope="row" className="px-4 py-3 font-medium whitespace-nowrap">
                  <Link
                    href={incidentHref(row.id)}
                    prefetch={false}
                    aria-label={linkLabel(row)}
                    className={`underline-offset-4 hover:underline ${LINK_FOCUS}`}
                  >
                    <Text value={row.incidentCode} />
                  </Link>
                </th>
                <td className="px-4 py-3 font-mono text-xs whitespace-nowrap">
                  <Text value={row.deviceId} />
                </td>
                <td className="px-4 py-3">
                  <Location row={row} />
                </td>
                <td className="px-4 py-3">
                  <IncidentStatusBadge status={row.status} />
                </td>
                <td className="px-4 py-3">
                  <Cause row={row} />
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-zinc-600 dark:text-zinc-400">
                  <LastSignal at={row.lastSignalAt} />
                </td>
                <td className="px-4 py-3">
                  <ReviewStatusBadge status={row.reviewStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul aria-label={label} className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li
            key={row.id}
            className="relative rounded-lg border border-zinc-200 bg-white p-4 shadow-sm focus-within:ring-2 focus-within:ring-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:focus-within:ring-zinc-100"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">
                {/* The ::after overlay makes the whole card clickable while the link stays one short, named target. */}
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
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt className="text-zinc-500">Status</dt>
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
              <dt className="text-zinc-500">Last signal</dt>
              <dd>
                <LastSignal at={row.lastSignalAt} />
              </dd>
              <dt className="text-zinc-500">Device</dt>
              <dd className="font-mono text-xs leading-5">
                <Text value={row.deviceId} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>
    </>
  )
}
