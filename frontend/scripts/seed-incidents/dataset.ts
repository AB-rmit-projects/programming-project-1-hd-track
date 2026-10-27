import type { CauseCategory, Incident } from '../../src/types/firestore'
import { melbourneLocalToUtc } from '../../src/lib/melbourneTime.ts'
import { SCENARIO_KINDS, SCENARIOS, scenarioText, type ScenarioKind } from './scenarios.ts'

/**
 * Builds the 50 fictional incident documents for one demo operator.
 *
 * Pure and deterministic: the same ownerUid and `now` always produce the same
 * records. Nothing here touches Firestore — writing is the seed runner's job.
 *
 * The simulated times (`reportedAt`, `lastSignalAt`) come from the fixed
 * scenario timeline, never from the clock. Only `createdAt` uses `now`: it is
 * the real time the documents are written.
 */

export const SEED_INCIDENT_COUNT = 50

/** Approved Phase 3 distribution (spec: 15/12/10/8/5). */
export const CATEGORY_DISTRIBUTION = {
  UNPLANNED_OUTAGE: 15,
  DEVICE_SIDE: 12,
  PLANNED_MAINTENANCE: 10,
  EXTERNAL_HAZARD: 8,
  INSUFFICIENT_EVIDENCE: 5,
} as const satisfies Record<CauseCategory, number>

/**
 * Owner UIDs must keep `{ownerUid}_INC-NNN` within the actionLogs rule's
 * incidentId pattern `[A-Za-z0-9_-]{1,128}` (8 characters are the suffix).
 */
export const OWNER_UID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/

/**
 * The Admin SDK rejects the client SDK's Timestamp class, so seed data uses
 * plain Dates, which the Admin SDK stores as Firestore Timestamps.
 */
export type SeedIncidentData = Omit<Incident, 'reportedAt' | 'lastSignalAt' | 'createdAt'> & {
  reportedAt: Date
  lastSignalAt: Date
  createdAt: Date
}

/** Current incident schema version written by the seed script. */
export const INCIDENT_SCHEMA_VERSION = 2

/** Scenario times as instants, in scenario (incident code) order. */
export const SCENARIO_TIMES: readonly { reportedAt: Date; lastSignalAt: Date }[] = SCENARIOS.map(
  (scenario) => ({
    reportedAt: melbourneLocalToUtc(scenario.reported),
    lastSignalAt: melbourneLocalToUtc(scenario.lastSignal),
  })
)

/** The latest simulated report time. A seed run before it would create future-dated incidents. */
export const LATEST_REPORTED_AT = new Date(
  Math.max(...SCENARIO_TIMES.map((t) => t.reportedAt.getTime()))
)

export interface SeedRecord {
  /** Deterministic Firestore document ID: `{ownerUid}_{incidentCode}`. */
  id: string
  data: SeedIncidentData
}

/** 0-based index → `INC-001` … `INC-050`. */
export function incidentCode(index: number): string {
  return `INC-${String(index + 1).padStart(3, '0')}`
}

export function incidentDocId(ownerUid: string, code: string): string {
  return `${ownerUid}_${code}`
}

/** Fictional pendant ID. 7919 and 9000 are coprime, so IDs are unique for index < 9000. */
export function deviceId(index: number): string {
  return `SC-${1000 + ((4821 + index * 7919) % 9000)}`
}

export function buildSeedIncidents(ownerUid: string, now: Date): SeedRecord[] {
  if (!OWNER_UID_PATTERN.test(ownerUid)) {
    throw new Error('ownerUid must be 1–120 characters of A–Z, a–z, 0–9, "_" or "-"')
  }
  if (!(now.getTime() >= LATEST_REPORTED_AT.getTime())) {
    const seedTime = Number.isNaN(now.getTime()) ? 'an invalid date' : now.toISOString()
    throw new Error(
      `Seed time ${seedTime} is before the latest simulated report time ` +
        `${LATEST_REPORTED_AT.toISOString()}; incidents would be dated in the future`
    )
  }

  const seen: Partial<Record<ScenarioKind, number>> = {}

  return SCENARIOS.map((scenario, index) => {
    const occurrence = seen[scenario.kind] ?? 0
    seen[scenario.kind] = occurrence + 1

    const { category, status } = SCENARIO_KINDS[scenario.kind]
    const times = SCENARIO_TIMES[index]!
    const code = incidentCode(index)
    const data = {
      ownerUid,
      incidentCode: code,
      deviceId: deviceId(index),
      status,
      suburb: scenario.suburb,
      state: 'VIC',
      postcode: scenario.postcode,
      reportedAt: new Date(times.reportedAt.getTime()),
      lastSignalAt: new Date(times.lastSignalAt.getTime()),
      causeCategory: category,
      ...scenarioText(scenario, occurrence),
      isSimulated: true,
      createdAt: new Date(now.getTime()),
      _schemaVersion: INCIDENT_SCHEMA_VERSION,
    } satisfies SeedIncidentData

    return { id: incidentDocId(ownerUid, code), data }
  })
}
