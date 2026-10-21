import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore'
import type { SeedIncidentData, SeedRecord } from './dataset.ts'

/**
 * Preflight + create-only writes for the seed records.
 *
 * Never calls set(), update() or delete(), and never uses batches or
 * transactions — an existing document is never modified. Only the incidents
 * collection is touched; actionLogs is never referenced.
 */

/** Keep in sync with INCIDENTS_COLLECTION in src/lib/firebase/firestore.ts (asserted by a unit test). */
export const INCIDENTS_COLLECTION = 'incidents'

/** gRPC status code the Firestore SDK uses when create() hits an existing document. */
const ALREADY_EXISTS = 6

/**
 * Fields that identify an existing document as the expected seed record.
 * Descriptive fields (likelyCause, evidenceSummary, …) are deliberately not
 * compared: a difference there is not a conflict, and nothing is ever
 * overwritten either way.
 */
export const IDENTITY_FIELDS = [
  'ownerUid',
  'incidentCode',
  'deviceId',
  'isSimulated',
  '_schemaVersion',
] as const satisfies readonly (keyof SeedIncidentData)[]

export type IdentityField = (typeof IDENTITY_FIELDS)[number]

/** Identity fields as stored — unknown, because an existing document may be malformed. */
export type ExistingIncident = Record<IdentityField, unknown>

/** The only Firestore operations the seed runner may use. */
export interface IncidentStore {
  /** Existing documents among `ids`, keyed by document ID. */
  readMany(ids: string[]): Promise<Map<string, ExistingIncident>>
  read(id: string): Promise<ExistingIncident | null>
  /** Create-only: resolves 'already-exists' instead of writing if the document exists. */
  create(id: string, data: SeedIncidentData): Promise<'created' | 'already-exists'>
}

export function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === ALREADY_EXISTS
  )
}

/** Picks the identity fields from any document-like source; missing fields read as undefined. */
export function identityOf(get: (field: IdentityField) => unknown): ExistingIncident {
  return {
    ownerUid: get('ownerUid'),
    incidentCode: get('incidentCode'),
    deviceId: get('deviceId'),
    isSimulated: get('isSimulated'),
    _schemaVersion: get('_schemaVersion'),
  }
}

function toExisting(snap: DocumentSnapshot): ExistingIncident | null {
  return snap.exists ? identityOf((field) => snap.get(field)) : null
}

/** IncidentStore backed by the Admin SDK; uses only getAll(), get() and create(). */
export function adminIncidentStore(db: Firestore): IncidentStore {
  const incidents = db.collection(INCIDENTS_COLLECTION)
  return {
    async readMany(ids) {
      const found = new Map<string, ExistingIncident>()
      if (ids.length === 0) return found
      const snaps = await db.getAll(...ids.map((id) => incidents.doc(id)))
      for (const snap of snaps) {
        const existing = toExisting(snap)
        if (existing) found.set(snap.id, existing)
      }
      return found
    },
    async read(id) {
      return toExisting(await incidents.doc(id).get())
    },
    async create(id, data) {
      try {
        await incidents.doc(id).create(data)
        return 'created'
      } catch (error) {
        if (isAlreadyExistsError(error)) return 'already-exists'
        throw error
      }
    },
  }
}

export interface SeedConflict {
  id: string
  found: ExistingIncident
  /** Identity fields whose stored value differs from the expected seed record. */
  mismatched: IdentityField[]
}

export interface SeedFailure {
  id: string
  error: string
}

export interface SeedReport {
  mode: 'dry-run' | 'write'
  total: number
  /** Dry run only: records that a write run would create. */
  wouldCreate: string[]
  created: string[]
  /** Already present with every identity field as expected; left untouched. */
  skipped: string[]
  /** Present but at least one identity field differs (or is missing/malformed); left untouched. */
  conflicts: SeedConflict[]
  failed: SeedFailure[]
  status: 'COMPLETE' | 'INCOMPLETE'
}

/** Identity fields that differ, compared with strict equality (so '1' ≠ 1, 'true' ≠ true). */
export function mismatchedFields(existing: ExistingIncident, record: SeedRecord): IdentityField[] {
  return IDENTITY_FIELDS.filter((field) => existing[field] !== record.data[field])
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export async function runSeed(
  store: IncidentStore,
  records: readonly SeedRecord[],
  { write }: { write: boolean }
): Promise<SeedReport> {
  const report: SeedReport = {
    mode: write ? 'write' : 'dry-run',
    total: records.length,
    wouldCreate: [],
    created: [],
    skipped: [],
    conflicts: [],
    failed: [],
    status: 'INCOMPLETE',
  }

  let existing: Map<string, ExistingIncident>
  try {
    existing = await store.readMany(records.map((r) => r.id))
  } catch (error) {
    const reason = `preflight read failed: ${messageOf(error)}`
    report.failed = records.map((r) => ({ id: r.id, error: reason }))
    return report
  }

  // Existing documents are only ever classified, never written.
  const classifyExisting = (record: SeedRecord, found: ExistingIncident) => {
    const mismatched = mismatchedFields(found, record)
    if (mismatched.length === 0) report.skipped.push(record.id)
    else report.conflicts.push({ id: record.id, found, mismatched })
  }

  const toCreate: SeedRecord[] = []
  for (const record of records) {
    const found = existing.get(record.id)
    if (found) classifyExisting(record, found)
    else toCreate.push(record)
  }

  if (!write) {
    report.wouldCreate = toCreate.map((r) => r.id)
  } else {
    // One at a time, so every record gets its own outcome and one failure
    // cannot affect any other record.
    for (const record of toCreate) {
      let outcome: 'created' | 'already-exists'
      try {
        outcome = await store.create(record.id, record.data)
      } catch (error) {
        report.failed.push({ id: record.id, error: messageOf(error) })
        continue
      }
      if (outcome === 'created') {
        report.created.push(record.id)
        continue
      }

      // Created by someone else after the preflight: check what is there now.
      let found: ExistingIncident | null
      try {
        found = await store.read(record.id)
      } catch (error) {
        report.failed.push({
          id: record.id,
          error: `already exists, and the re-read failed: ${messageOf(error)}`,
        })
        continue
      }
      if (found === null) {
        report.failed.push({
          id: record.id,
          error: 'reported as existing but not found on re-read',
        })
      } else {
        classifyExisting(record, found)
      }
    }
  }

  report.status =
    report.conflicts.length === 0 && report.failed.length === 0 ? 'COMPLETE' : 'INCOMPLETE'
  return report
}

/** 0 = COMPLETE; 1 = any conflict or failure. */
export function exitCodeFor(report: SeedReport): 0 | 1 {
  return report.status === 'COMPLETE' ? 0 : 1
}
