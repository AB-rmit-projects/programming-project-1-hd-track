import type { ReviewSummary } from '@/features/incidents/types'

interface SummaryStatsProps {
  /** null while counts are not confirmed — shown as "—", never as a guessed number. */
  summary: ReviewSummary | null
}

const STATS = [
  { key: 'total', label: 'Total incidents' },
  { key: 'awaiting', label: 'Awaiting review' },
  { key: 'reviewed', label: 'Reviewed' },
] as const

/**
 * Three compact cards side by side from 360px; below that (e.g. 320px phones)
 * one slim row per count, label left and value right. From sm up the cards
 * keep their full-size padding and type.
 */
export function SummaryStats({ summary }: SummaryStatsProps) {
  return (
    <dl aria-busy={summary === null} className="grid gap-2 min-[360px]:grid-cols-3 sm:gap-4">
      {STATS.map(({ key, label }) => (
        <div
          key={key}
          className="flex items-baseline justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm min-[360px]:flex-col min-[360px]:items-start min-[360px]:gap-1 min-[360px]:p-3 sm:p-4 dark:border-zinc-800 dark:bg-zinc-900"
        >
          <dt className="text-xs leading-tight font-medium text-zinc-500 sm:text-sm">{label}</dt>
          <dd className="text-xl font-bold tabular-nums min-[360px]:mt-auto min-[360px]:text-2xl sm:text-3xl">
            {summary ? (
              summary[key]
            ) : (
              <>
                <span aria-hidden="true">—</span>
                <span className="sr-only">Not available yet</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
