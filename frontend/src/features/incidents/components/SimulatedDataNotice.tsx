import { FlaskConical } from 'lucide-react'

/** States plainly that every incident on screen is fictional (spec: visible simulated-data label). */
export function SimulatedDataNotice() {
  return (
    <div
      role="note"
      className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      <FlaskConical className="mt-0.5 size-4 shrink-0" />
      <p>
        <span className="font-semibold">Simulated data.</span> These incidents are fictional and for
        demonstration only. They are not real emergencies, and no alerts or welfare checks are sent.
      </p>
    </div>
  )
}

/** Compact label for the page header. */
export function SimulatedDataPill() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800 dark:bg-amber-950 dark:text-amber-300">
      <FlaskConical className="size-3.5 shrink-0" />
      Simulated data
    </span>
  )
}
