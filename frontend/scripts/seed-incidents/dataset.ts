import type { CauseCategory, Incident } from '../../src/types/firestore'
import { SCENARIO_KINDS, SCENARIOS, scenarioText, type ScenarioKind } from './scenarios.ts'

/**
 * Builds the 50 fictional incident documents for one demo operator.
 *
 * Pure and deterministic: the same ownerUid and `now` always produce the same
 * records. Nothing here touches Firestore — writing is the seed runner's job.
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
export type SeedIncidentData = Omit<Incident, 'lastSignalAt' | 'createdAt'> & {
  lastSignalAt: Date
  createdAt: Date
}

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

  const seen: Partial<Record<ScenarioKind, number>> = {}

  return SCENARIOS.map((scenario, index) => {
    const occurrence = seen[scenario.kind] ?? 0
    seen[scenario.kind] = occurrence + 1

    const { category, status } = SCENARIO_KINDS[scenario.kind]
    const code = incidentCode(index)
    const data = {
      ownerUid,
      incidentCode: code,
      deviceId: deviceId(index),
      status,
      suburb: scenario.suburb,
      state: 'VIC',
      postcode: scenario.postcode,
      lastSignalAt: new Date(now.getTime() - scenario.signalOffsetMinutes * 60_000),
      causeCategory: category,
      ...scenarioText(scenario, occurrence),
      isSimulated: true,
      createdAt: new Date(now.getTime()),
      _schemaVersion: 1,
    } satisfies SeedIncidentData

    return { id: incidentDocId(ownerUid, code), data }
  })
}
