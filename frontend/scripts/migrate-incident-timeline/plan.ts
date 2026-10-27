import { createHash } from 'node:crypto'
import type { IncidentVersions } from './legacy.ts'

/**
 * The pure core of the incident timeline migration (schema v1 → v2).
 *
 * Nothing here touches Firestore. It decides, from documents and metadata
 * already read, exactly which documents may change and how, and it refuses
 * anything unexpected. Only three fields ever change: `reportedAt` (added),
 * `lastSignalAt` and `_schemaVersion`. A document is converted only if it is
 * strictly, field for field, the version 1 document the seed wrote.
 */

/** The fields a migration update may set. Everything else is never written. */
export const MIGRATED_FIELDS = ['reportedAt', 'lastSignalAt', '_schemaVersion'] as const

/** Firestore's last-update time, kept exact (nanoseconds) for write preconditions. */
export interface UpdateTime {
  seconds: number
  nanoseconds: number
}

export interface StoredIncident {
  data: Record<string, unknown>
  updateTime: UpdateTime
}

/** What the planner needs to know about the live (or emulator) state. */
export interface MigrationReads {
  /** The allowlisted documents that exist, by document ID. */
  incidents: ReadonlyMap<string, StoredIncident>
  /** IDs of every incident whose ownerUid is the expected owner. */
  ownerIncidentIds: readonly string[]
  /** IDs of every action log whose ownerUid is the expected owner (recorded, never touched). */
  ownerActionLogIds: readonly string[]
}

export type Classification = 'V1_ORIGINAL' | 'V2_TARGET' | 'MISSING' | 'CONFLICT'

export interface DocumentPlan {
  id: string
  classification: Classification
  /** Fields that differ from both the v1 and the v2 form (CONFLICT only). */
  differences: string[]
  updateTime: UpdateTime | null
}

export interface PlannedUpdate {
  id: string
  /** The write is refused unless the document is still at exactly this version. */
  lastUpdateTime: UpdateTime
  patch: { reportedAt: Date; lastSignalAt: Date; _schemaVersion: 2 }
}

export interface MigrationPlan {
  decision: 'PROCEED' | 'NOTHING_TO_DO' | 'STOP'
  reasons: string[]
  documents: DocumentPlan[]
  updates: PlannedUpdate[]
  ownerActionLogIds: string[]
  /** SHA-256 over everything above: a write must present the digest of the plan it was approved from. */
  digest: string
}

// ── Strict value comparison ──────────────────────────────────────────────────

/** A Firestore Timestamp (Admin or client SDK) or a plain Date, as exact seconds + nanoseconds. */
function asInstant(value: unknown): UpdateTime | null {
  if (value instanceof Date) {
    const ms = value.getTime()
    if (Number.isNaN(ms)) return null
    return {
      seconds: Math.floor(ms / 1000),
      nanoseconds: (((ms % 1000) + 1000) % 1000) * 1_000_000,
    }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toDate?: unknown }).toDate === 'function' &&
    typeof (value as { seconds?: unknown }).seconds === 'number' &&
    typeof (value as { nanoseconds?: unknown }).nanoseconds === 'number'
  ) {
    const { seconds, nanoseconds } = value as UpdateTime
    return { seconds, nanoseconds }
  }
  return null
}

/**
 * Canonical, type-tagged JSON: a timestamp never equals a string or number
 * with the same text, and key order never matters.
 */
export function canonical(value: unknown): string {
  const instant =
    value instanceof Date || (typeof value === 'object' && value !== null && 'toDate' in value)
      ? asInstant(value)
      : null
  if (instant) return JSON.stringify({ $ts: [instant.seconds, instant.nanoseconds] })
  if (value instanceof Date) return JSON.stringify({ $ts: 'invalid' })
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  if (value === undefined) return '{"$undefined":true}'
  return JSON.stringify({ [typeof value]: value })
}

/** Field names whose values differ (missing and extra fields included), sorted. */
export function differingFields(stored: Record<string, unknown>, expected: object): string[] {
  const exp = expected as Record<string, unknown>
  const keys = new Set([...Object.keys(stored), ...Object.keys(exp)])
  return [...keys]
    .filter(
      (key) =>
        Object.hasOwn(stored, key) !== Object.hasOwn(exp, key) ||
        canonical(stored[key]) !== canonical(exp[key])
    )
    .sort()
}

// ── Planning ─────────────────────────────────────────────────────────────────

export function classify(
  stored: StoredIncident | undefined,
  versions: IncidentVersions
): DocumentPlan {
  if (!stored) {
    return { id: versions.id, classification: 'MISSING', differences: [], updateTime: null }
  }
  const fromV1 = differingFields(stored.data, versions.v1)
  if (fromV1.length === 0) {
    return {
      id: versions.id,
      classification: 'V1_ORIGINAL',
      differences: [],
      updateTime: stored.updateTime,
    }
  }
  const fromV2 = differingFields(stored.data, versions.v2)
  if (fromV2.length === 0) {
    return {
      id: versions.id,
      classification: 'V2_TARGET',
      differences: [],
      updateTime: stored.updateTime,
    }
  }
  // Report the smaller difference: usually what was changed on an otherwise expected document.
  const differences = fromV1.length <= fromV2.length ? fromV1 : fromV2
  return { id: versions.id, classification: 'CONFLICT', differences, updateTime: stored.updateTime }
}

function digestOf(payload: unknown): string {
  return createHash('sha256').update(canonical(payload)).digest('hex')
}

/**
 * Builds the migration plan. STOP (and no updates) if any allowlisted
 * document is missing or differs from both forms, or if the owner has any
 * incident outside the allowlist; NOTHING_TO_DO when every document is
 * already version 2 (re-running is a no-op); otherwise PROCEED with one
 * update per version 1 document.
 */
export function planTimelineMigration(
  expected: readonly IncidentVersions[],
  reads: MigrationReads
): MigrationPlan {
  const reasons: string[] = []
  const allowlist = new Set(expected.map((v) => v.id))
  if (allowlist.size !== expected.length) reasons.push('the allowlist contains duplicate IDs')

  const documents = expected.map((versions) => classify(reads.incidents.get(versions.id), versions))

  for (const doc of documents) {
    if (doc.classification === 'MISSING') reasons.push(`${doc.id} is missing`)
    if (doc.classification === 'CONFLICT') {
      reasons.push(`${doc.id} differs from the expected document in: ${doc.differences.join(', ')}`)
    }
  }
  for (const id of reads.incidents.keys()) {
    if (!allowlist.has(id)) reasons.push(`${id} was read but is not on the allowlist`)
  }
  const extra = reads.ownerIncidentIds.filter((id) => !allowlist.has(id))
  if (extra.length > 0) {
    reasons.push(
      `the owner has ${extra.length} incident(s) outside the allowlist: ${[...extra].sort().join(', ')}`
    )
  }
  const missingFromOwnerQuery = [...allowlist].filter(
    (id) => reads.incidents.has(id) && !reads.ownerIncidentIds.includes(id)
  )
  if (missingFromOwnerQuery.length > 0) {
    reasons.push(
      `${missingFromOwnerQuery.length} allowlisted incident(s) are not returned by the owner query`
    )
  }

  const byId = new Map(expected.map((v) => [v.id, v]))
  const updates: PlannedUpdate[] =
    reasons.length > 0
      ? []
      : documents
          .filter((doc) => doc.classification === 'V1_ORIGINAL')
          .map((doc) => {
            const target = byId.get(doc.id)!.v2
            return {
              id: doc.id,
              lastUpdateTime: doc.updateTime!,
              patch: {
                reportedAt: new Date(target.reportedAt.getTime()),
                lastSignalAt: new Date(target.lastSignalAt.getTime()),
                _schemaVersion: 2 as const,
              },
            }
          })

  const decision: MigrationPlan['decision'] =
    reasons.length > 0 ? 'STOP' : updates.length === 0 ? 'NOTHING_TO_DO' : 'PROCEED'
  const ownerActionLogIds = [...reads.ownerActionLogIds].sort()

  return {
    decision,
    reasons,
    documents,
    updates,
    ownerActionLogIds,
    digest: digestOf({ decision, reasons, documents, updates, ownerActionLogIds }),
  }
}

// ── Rollback ─────────────────────────────────────────────────────────────────

/** Sentinel for "remove this field"; the Admin adapter maps it to FieldValue.delete(). */
export const DELETE_FIELD = Symbol('delete-field')

export interface PlannedRollback {
  id: string
  lastUpdateTime: UpdateTime
  patch: { reportedAt: typeof DELETE_FIELD; lastSignalAt: Date; _schemaVersion: 1 }
}

/**
 * The inverse of a migration, for documents that are exactly in their v2
 * form: restore the v1 `lastSignalAt`, remove `reportedAt`, set version 1.
 * STOP if any allowlisted document is in neither form.
 */
export function planTimelineRollback(
  expected: readonly IncidentVersions[],
  incidents: ReadonlyMap<string, StoredIncident>
): {
  decision: 'PROCEED' | 'NOTHING_TO_DO' | 'STOP'
  reasons: string[]
  updates: PlannedRollback[]
} {
  const reasons: string[] = []
  const updates: PlannedRollback[] = []
  for (const versions of expected) {
    const doc = classify(incidents.get(versions.id), versions)
    if (doc.classification === 'MISSING' || doc.classification === 'CONFLICT') {
      reasons.push(
        `${doc.id}: ${doc.classification}${doc.differences.length ? ` (${doc.differences.join(', ')})` : ''}`
      )
    } else if (doc.classification === 'V2_TARGET') {
      updates.push({
        id: doc.id,
        lastUpdateTime: doc.updateTime!,
        patch: {
          reportedAt: DELETE_FIELD,
          lastSignalAt: new Date(versions.v1.lastSignalAt.getTime()),
          _schemaVersion: 1,
        },
      })
    }
  }
  if (reasons.length > 0) return { decision: 'STOP', reasons, updates: [] }
  return { decision: updates.length ? 'PROCEED' : 'NOTHING_TO_DO', reasons, updates }
}

// ── Backup and verification ──────────────────────────────────────────────────

/** A canonical, type-tagged snapshot of the documents and their update times, for the backup file. */
export function snapshotOf(incidents: ReadonlyMap<string, StoredIncident>): string {
  const ids = [...incidents.keys()].sort()
  return canonical(ids.map((id) => ({ id, ...incidents.get(id)! })))
}

export interface VerificationResult {
  ok: boolean
  failures: string[]
}

/**
 * After a write: every allowlisted document is exactly its v2 form (so
 * createdAt, owner, text and all other fields are unchanged), the owner still
 * has exactly the allowlisted incidents, and the owner's action logs are
 * exactly those recorded before the write.
 */
export function verifyMigrated(
  expected: readonly IncidentVersions[],
  before: MigrationPlan,
  after: MigrationReads
): VerificationResult {
  const failures: string[] = []
  for (const versions of expected) {
    const doc = classify(after.incidents.get(versions.id), versions)
    if (doc.classification !== 'V2_TARGET') {
      failures.push(
        `${versions.id} is ${doc.classification}${doc.differences.length ? ` (${doc.differences.join(', ')})` : ''}`
      )
    }
  }
  const allowlist = new Set(expected.map((v) => v.id))
  const ownerIds = [...after.ownerIncidentIds].sort()
  if (ownerIds.length !== allowlist.size || ownerIds.some((id) => !allowlist.has(id))) {
    failures.push(
      `the owner's incidents changed: ${ownerIds.length} found, ${allowlist.size} expected`
    )
  }
  if (canonical([...after.ownerActionLogIds].sort()) !== canonical(before.ownerActionLogIds)) {
    failures.push('the owner’s action logs changed during the migration')
  }
  return { ok: failures.length === 0, failures }
}
