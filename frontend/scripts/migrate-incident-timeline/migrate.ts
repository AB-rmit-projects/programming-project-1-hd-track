import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { assertTimelineInPast } from '../seed-incidents/dataset.ts'
import { buildIncidentVersions, type IncidentVersions } from './legacy.ts'
import {
  DELETE_FIELD,
  planTimelineMigration,
  planTimelineRollback,
  snapshotOf,
  verifyMigrated,
  type MigrationPlan,
  type MigrationReads,
  type PlannedRollback,
  type PlannedUpdate,
  type StoredIncident,
  type UpdateTime,
  type VerificationResult,
} from './plan.ts'

/**
 * Executor for the incident timeline migration. The decisions are made by the
 * pure planner (plan.ts); this only reads, applies an approved plan, and
 * re-reads to verify. It is exercised against the local emulator by
 * tests/rules/incidentTimelineMigration.rules.test.ts. A live run needs its
 * own separately approved tool and credential: nothing here picks a project.
 */

/** Keep in sync with INCIDENTS_COLLECTION / ACTION_LOGS_COLLECTION in src/lib/firebase/firestore.ts. */
export const INCIDENTS = 'incidents'
export const ACTION_LOGS = 'actionLogs'

/** The only Firestore operations the migration may use. */
export interface MigrationStore {
  read(ownerUid: string, ids: readonly string[]): Promise<MigrationReads>
  /**
   * Applies every update atomically (one batch): all or nothing. Each update
   * carries a last-update-time precondition, so a document changed since it
   * was read fails the whole batch and nothing is written.
   */
  commit(updates: readonly (PlannedUpdate | PlannedRollback)[]): Promise<void>
}

export interface MigrationTarget {
  ownerUid: string
  /** The version 1 seed time (= every document's createdAt). */
  seedTime: Date
  /** Exact allowlist; must equal the 50 IDs derived from ownerUid. */
  allowlist: readonly string[]
  /** The real current time. Nothing is planned while a simulated report time is still in the future. */
  currentTime: Date
}

/** The derived document versions, after checking the explicit allowlist matches them exactly. */
export function expectedVersions(target: MigrationTarget): IncidentVersions[] {
  assertTimelineInPast(target.currentTime)
  const versions = buildIncidentVersions(target.ownerUid, target.seedTime)
  const derived = versions.map((v) => v.id)
  const given = [...target.allowlist]
  if (
    given.length !== derived.length ||
    [...given].sort().join('\n') !== [...derived].sort().join('\n')
  ) {
    throw new Error('the allowlist does not match the 50 incident IDs derived from the owner UID')
  }
  return versions
}

export interface DryRunReport {
  plan: MigrationPlan
  /** Canonical snapshot of the 50 documents as read — the backup. */
  backup: string
}

export async function dryRun(
  store: MigrationStore,
  target: MigrationTarget
): Promise<DryRunReport> {
  const versions = expectedVersions(target)
  const reads = await store.read(target.ownerUid, target.allowlist)
  return { plan: planTimelineMigration(versions, reads), backup: snapshotOf(reads.incidents) }
}

export interface WriteReport {
  status: 'WRITTEN' | 'NOTHING_TO_DO' | 'REFUSED'
  reason?: string
  plan: MigrationPlan
  verification: VerificationResult | null
}

/**
 * Re-plans from fresh reads and writes only if the new plan's digest equals
 * the approved dry run's: any change since the approval — a document edited,
 * an incident or action log added — refuses the write before it starts.
 * After writing, everything is read back and verified.
 */
export async function write(
  store: MigrationStore,
  target: MigrationTarget,
  approvedDigest: string
): Promise<WriteReport> {
  const versions = expectedVersions(target)
  const plan = planTimelineMigration(versions, await store.read(target.ownerUid, target.allowlist))
  if (plan.digest !== approvedDigest) {
    return {
      status: 'REFUSED',
      reason: 'the state changed since the approved dry run',
      plan,
      verification: null,
    }
  }
  if (plan.decision === 'STOP') {
    return { status: 'REFUSED', reason: plan.reasons.join('; '), plan, verification: null }
  }
  if (plan.decision === 'NOTHING_TO_DO') {
    return { status: 'NOTHING_TO_DO', plan, verification: null }
  }
  await store.commit(plan.updates)
  const after = await store.read(target.ownerUid, target.allowlist)
  return { status: 'WRITTEN', plan, verification: verifyMigrated(versions, plan, after) }
}

/** Restores version 1 for documents that are exactly in their v2 form (atomic, preconditioned). */
export async function rollback(
  store: MigrationStore,
  target: MigrationTarget
): Promise<ReturnType<typeof planTimelineRollback>> {
  const versions = expectedVersions(target)
  const reads = await store.read(target.ownerUid, target.allowlist)
  const plan = planTimelineRollback(versions, reads.incidents)
  if (plan.decision === 'PROCEED') await store.commit(plan.updates)
  return plan
}

// ── Admin SDK adapter ────────────────────────────────────────────────────────

const toUpdateTime = (ts: Timestamp): UpdateTime => ({
  seconds: ts.seconds,
  nanoseconds: ts.nanoseconds,
})

/** MigrationStore backed by the Admin SDK: getAll, two owner-scoped ID queries, one batch. */
export function adminMigrationStore(db: Firestore): MigrationStore {
  const incidents = db.collection(INCIDENTS)
  return {
    async read(ownerUid, ids) {
      const found = new Map<string, StoredIncident>()
      if (ids.length > 0) {
        for (const snap of await db.getAll(...ids.map((id) => incidents.doc(id)))) {
          if (snap.exists)
            found.set(snap.id, { data: snap.data()!, updateTime: toUpdateTime(snap.updateTime!) })
        }
      }
      // IDs only (select()): no action-log content is read, and nothing is ever written there.
      const [ownerIncidents, ownerLogs] = await Promise.all([
        incidents.where('ownerUid', '==', ownerUid).select().get(),
        db.collection(ACTION_LOGS).where('ownerUid', '==', ownerUid).select().get(),
      ])
      return {
        incidents: found,
        ownerIncidentIds: ownerIncidents.docs.map((d) => d.id),
        ownerActionLogIds: ownerLogs.docs.map((d) => d.id),
      }
    },
    async commit(updates) {
      if (updates.length > 500) throw new Error('more updates than one batch allows')
      const batch = db.batch()
      for (const { id, patch, lastUpdateTime } of updates) {
        const data: Record<string, unknown> = {}
        for (const [field, value] of Object.entries(patch)) {
          data[field] = value === DELETE_FIELD ? FieldValue.delete() : value
        }
        batch.update(incidents.doc(id), data, {
          lastUpdateTime: new Timestamp(lastUpdateTime.seconds, lastUpdateTime.nanoseconds),
        })
      }
      await batch.commit()
    },
  }
}
