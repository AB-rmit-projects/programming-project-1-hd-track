import {
  INCIDENT_SCHEMA_VERSION,
  buildSeedIncidents,
  type SeedIncidentData,
  type SeedRecord,
} from '../seed-incidents/dataset.ts'

/**
 * Exact reconstruction of the version 1 incident documents (Phases 3–5).
 *
 * Version 1 stored `lastSignalAt` as the seed time minus a per-scenario
 * offset and had no `reportedAt`. Every other field is unchanged in version 2
 * — the scenario text, IDs, owner and `createdAt` (= the seed time) — so a
 * version 1 document can be rebuilt exactly from the owner UID and the seed
 * time. The migration uses this to prove a stored document is untouched
 * before converting it, and the rollback uses it to restore one.
 */

/**
 * `signalOffsetMinutes` of the 50 version 1 scenarios, in incident code order
 * (INC-001 … INC-050), exactly as on main at 5d04a3b. Never change these:
 * they describe documents that already exist.
 */
export const LEGACY_V1_SIGNAL_OFFSET_MINUTES: readonly number[] = [
  95, 410, 45, 180, 260, 22, 30, 41, 120, 1440, 960, 18, 15, 75, 47, 230, 33, 150, 200, 60, 2160,
  400, 12, 35, 55, 125, 28, 85, 1200, 20, 160, 38, 1980, 50, 3600, 55, 110, 4320, 26, 10, 58, 140,
  315, 2880, 44, 1800, 90, 15, 240, 25,
]

export type LegacyIncidentData = Omit<SeedIncidentData, 'reportedAt' | '_schemaVersion'> & {
  _schemaVersion: 1
}

export interface IncidentVersions {
  id: string
  /** The document as the version 1 seed wrote it. */
  v1: LegacyIncidentData
  /** The same document after migration: v1 plus the new timeline, `createdAt` untouched. */
  v2: SeedIncidentData
}

/**
 * Both versions of every incident for one owner and the original seed time.
 * `seedTime` is the version 1 `createdAt`, kept unchanged in version 2. It may
 * be earlier than some simulated report times: `createdAt` records when the
 * fixture was written, not when the fictional incident happened. Pure — the
 * check that no report time is in the future uses the real clock, in
 * expectedVersions (migrate.ts).
 */
export function buildIncidentVersions(ownerUid: string, seedTime: Date): IncidentVersions[] {
  const current: SeedRecord[] = buildSeedIncidents(ownerUid, seedTime)
  if (current.length !== LEGACY_V1_SIGNAL_OFFSET_MINUTES.length) {
    throw new Error('the legacy offsets no longer match the scenario list')
  }
  return current.map(({ id, data }, index) => {
    // Everything except reportedAt, which version 1 did not have.
    const rest: Omit<SeedIncidentData, 'reportedAt'> & { reportedAt?: Date } = { ...data }
    delete rest.reportedAt
    const offset = LEGACY_V1_SIGNAL_OFFSET_MINUTES[index]!
    const v1: LegacyIncidentData = {
      ...rest,
      lastSignalAt: new Date(seedTime.getTime() - offset * 60_000),
      createdAt: new Date(seedTime.getTime()),
      _schemaVersion: 1,
    }
    const v2: SeedIncidentData = {
      ...data,
      createdAt: new Date(seedTime.getTime()),
      _schemaVersion: INCIDENT_SCHEMA_VERSION,
    }
    return { id, v1, v2 }
  })
}
