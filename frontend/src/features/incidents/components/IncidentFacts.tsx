import type { ReactNode } from 'react'
import {
  CAUSE_CATEGORY_LABELS,
  FALLBACK_LABELS,
  NOT_IN_DATASET_LABELS,
} from '@/features/incidents/labels'
import type { IncidentDetail } from '@/features/incidents/types'
import { IncidentStatusBadge } from './IncidentBadges'
import { IncidentTime } from './IncidentTime'
import { Missing, Text } from './MissingValue'

const CARD =
  'rounded-lg border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 dark:border-zinc-800 dark:bg-zinc-900'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 sm:grid sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 [overflow-wrap:anywhere] sm:mt-0">{children}</dd>
    </div>
  )
}

/** Long free text from the record, kept exactly as stored. */
function Prose({ value }: { value: string | null }) {
  if (value === null) return <Missing />
  return <span className="whitespace-pre-line">{value}</span>
}

/**
 * The incident's facts and its simulated evidence, read-only. Missing values
 * are shown as placeholders, never filled in; the likely cause is presented as
 * an interpretation of the evidence, not a diagnosis.
 */
export function IncidentFacts({ incident }: { incident: IncidentDetail }) {
  const cause = incident.causeCategory
    ? CAUSE_CATEGORY_LABELS[incident.causeCategory]
    : FALLBACK_LABELS.causeCategory

  return (
    <div className="min-w-0 space-y-4">
      <section aria-labelledby="incident-facts-heading" className={CARD}>
        <h2 id="incident-facts-heading" className="text-base font-semibold">
          Incident facts
        </h2>
        <dl className="mt-3 space-y-3 text-sm">
          <Fact label="Incident code">
            <Text value={incident.incidentCode} />
          </Fact>
          <Fact label="Device ID">
            <span className="font-mono text-xs">
              <Text value={incident.deviceId} />
            </span>
          </Fact>
          <Fact label="Pendant connectivity">
            <IncidentStatusBadge status={incident.status} />
          </Fact>
          <Fact label="Location">
            <Text value={incident.suburb} />, <Text value={incident.state} />{' '}
            <Text value={incident.postcode} />
          </Fact>
          <Fact label="Reported (simulated)">
            <IncidentTime
              at={incident.reportedAt}
              fallback={
                incident.legacyTimeline
                  ? NOT_IN_DATASET_LABELS.legacyReportedAt
                  : FALLBACK_LABELS.reportedAt
              }
            />
          </Fact>
          <Fact label="Last signal (simulated)">
            <IncidentTime at={incident.lastSignalAt} fallback={FALLBACK_LABELS.lastSignalAt} />
          </Fact>
        </dl>
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          A historical, fictional scenario — not a live alert. Times are Melbourne time.
        </p>
      </section>

      <section aria-labelledby="incident-evidence-heading" className={CARD}>
        <h2 id="incident-evidence-heading" className="text-base font-semibold">
          Evidence and assessment
        </h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          All of this is simulated and advisory. It is an assessment of the evidence, not a
          confirmed diagnosis.
        </p>
        <dl className="mt-3 space-y-3 text-sm">
          <Fact label="Evidence (simulated)">
            <Prose value={incident.evidenceSummary} />
          </Fact>
          <Fact label="Cause category">
            {cause}
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">
              A scenario association, not a confirmed cause.
            </span>
          </Fact>
          <Fact label="Likely cause (interpretation)">
            <Prose value={incident.likelyCause} />
          </Fact>
          <Fact label="Confidence">
            <span className="text-zinc-500 dark:text-zinc-400">
              {NOT_IN_DATASET_LABELS.confidence}
            </span>
          </Fact>
          <Fact label="Recommended action (advisory)">
            <Prose value={incident.recommendedAction} />
          </Fact>
        </dl>
      </section>
    </div>
  )
}
