// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { Timestamp } from 'firebase/firestore'
// The migration lives outside src/, so the @/ alias cannot reach it.
import {
  LEGACY_V1_SIGNAL_OFFSET_MINUTES,
  buildIncidentVersions,
} from '../../../../scripts/migrate-incident-timeline/legacy'
import {
  DELETE_FIELD,
  MIGRATED_FIELDS,
  canonical,
  differingFields,
  planTimelineMigration,
  planTimelineRollback,
  snapshotOf,
  verifyMigrated,
  type MigrationReads,
  type StoredIncident,
} from '../../../../scripts/migrate-incident-timeline/plan'
import { expectedVersions } from '../../../../scripts/migrate-incident-timeline/migrate'

const OWNER = 'demoOperatorUid01'
/** The live seed time recorded on 23 October 2026 (4:33:44 pm AEDT). */
const SEED_TIME = new Date('2026-10-23T05:33:44.000Z')
const VERSIONS = buildIncidentVersions(OWNER, SEED_TIME)
const IDS = VERSIONS.map((v) => v.id)

const at = (seconds: number, nanoseconds = 0) => ({ seconds, nanoseconds })

/** Stored documents in the given form, with distinct update times. */
function stored(form: 'v1' | 'v2', overrides: Record<string, Record<string, unknown>> = {}) {
  return new Map<string, StoredIncident>(
    VERSIONS.map((v, i) => [
      v.id,
      {
        data: { ...(form === 'v1' ? v.v1 : v.v2), ...overrides[v.id] },
        updateTime: at(1_793_000_000 + i, 123_456_789),
      },
    ])
  )
}

function reads(
  incidents: Map<string, StoredIncident>,
  extra: Partial<MigrationReads> = {}
): MigrationReads {
  return { incidents, ownerIncidentIds: [...incidents.keys()], ownerActionLogIds: [], ...extra }
}

describe('legacy (version 1) reconstruction', () => {
  it('has one legacy offset per scenario and rebuilds INC-001 exactly as the v1 seed wrote it', () => {
    expect(LEGACY_V1_SIGNAL_OFFSET_MINUTES).toHaveLength(50)
    const first = VERSIONS[0]!
    expect(first.id).toBe(`${OWNER}_INC-001`)
    expect(Object.keys(first.v1)).toHaveLength(15)
    expect('reportedAt' in first.v1).toBe(false)
    expect(first.v1._schemaVersion).toBe(1)
    expect(first.v1.createdAt.toISOString()).toBe('2026-10-23T05:33:44.000Z')
    expect(first.v1.lastSignalAt.toISOString()).toBe('2026-10-23T03:58:44.000Z') // seed − 95 min
  })

  it('v1 and v2 differ only in reportedAt, lastSignalAt and _schemaVersion; createdAt is kept', () => {
    for (const { v1, v2 } of VERSIONS) {
      expect(differingFields(v1, v2)).toEqual([...MIGRATED_FIELDS].sort())
      expect(v2.createdAt.getTime()).toBe(SEED_TIME.getTime())
      expect(v2._schemaVersion).toBe(2)
      expect(v2.reportedAt.getTime()).toBeLessThanOrEqual(SEED_TIME.getTime()) // nothing future-dated
    }
  })

  it('refuses a seed time earlier than the latest report time', () => {
    expect(() => buildIncidentVersions(OWNER, new Date('2026-10-01T00:00:00Z'))).toThrow(/future/)
  })

  it('requires the explicit allowlist to be exactly the 50 derived IDs', () => {
    expect(
      expectedVersions({ ownerUid: OWNER, seedTime: SEED_TIME, allowlist: [...IDS].reverse() })
    ).toHaveLength(50)
    for (const allowlist of [IDS.slice(1), [...IDS, 'extra'], [...IDS.slice(1), 'other_INC-001']]) {
      expect(() => expectedVersions({ ownerUid: OWNER, seedTime: SEED_TIME, allowlist })).toThrow(
        /allowlist/
      )
    }
  })
})

describe('strict comparison', () => {
  it('treats a Firestore Timestamp and a Date at the same millisecond as equal, but not a string', () => {
    const date = new Date('2026-10-23T05:33:44.000Z')
    expect(canonical(Timestamp.fromDate(date))).toBe(canonical(date))
    expect(canonical(date.toISOString())).not.toBe(canonical(date))
    expect(canonical(new Timestamp(date.getTime() / 1000, 1))).not.toBe(canonical(date)) // 1 ns later
  })

  it('distinguishes types and missing keys, ignores key order', () => {
    expect(canonical({ a: 1, b: 2 })).toBe(canonical({ b: 2, a: 1 }))
    expect(canonical({ v: 1 })).not.toBe(canonical({ v: '1' }))
    expect(canonical({ v: true })).not.toBe(canonical({ v: 'true' }))
    expect(differingFields({ a: 1 }, { a: 1, b: undefined })).toEqual(['b'])
  })
})

describe('planTimelineMigration', () => {
  it('PROCEEDs for 50 untouched v1 documents, changing only the three timeline fields', () => {
    const incidents = stored('v1')
    const plan = planTimelineMigration(VERSIONS, reads(incidents))
    expect(plan.decision).toBe('PROCEED')
    expect(plan.reasons).toEqual([])
    expect(plan.updates).toHaveLength(50)
    for (const [i, update] of plan.updates.entries()) {
      const v = VERSIONS[i]!
      expect(update.id).toBe(v.id)
      expect(Object.keys(update.patch).sort()).toEqual([...MIGRATED_FIELDS].sort())
      expect(update.patch.reportedAt.getTime()).toBe(v.v2.reportedAt.getTime())
      expect(update.patch.lastSignalAt.getTime()).toBe(v.v2.lastSignalAt.getTime())
      expect(update.patch._schemaVersion).toBe(2)
      expect(update.lastUpdateTime).toEqual(incidents.get(v.id)!.updateTime) // concurrency precondition
    }
    expect(plan.documents.every((d) => d.classification === 'V1_ORIGINAL')).toBe(true)
  })

  it('accepts Timestamps as read from Firestore', () => {
    const incidents = new Map(
      [...stored('v1')].map(([id, doc]) => [
        id,
        {
          ...doc,
          data: {
            ...doc.data,
            lastSignalAt: Timestamp.fromDate(doc.data.lastSignalAt as Date),
            createdAt: Timestamp.fromDate(doc.data.createdAt as Date),
          },
        },
      ])
    )
    expect(planTimelineMigration(VERSIONS, reads(incidents)).decision).toBe('PROCEED')
  })

  it('is idempotent: NOTHING_TO_DO once every document is v2', () => {
    const plan = planTimelineMigration(VERSIONS, reads(stored('v2')))
    expect(plan.decision).toBe('NOTHING_TO_DO')
    expect(plan.updates).toEqual([])
    expect(plan.documents.every((d) => d.classification === 'V2_TARGET')).toBe(true)
  })

  it('updates only the remaining v1 documents when some are already v2', () => {
    const incidents = stored('v1')
    const v2 = stored('v2')
    for (const id of IDS.slice(0, 10)) incidents.set(id, v2.get(id)!)
    const plan = planTimelineMigration(VERSIONS, reads(incidents))
    expect(plan.decision).toBe('PROCEED')
    expect(plan.updates.map((u) => u.id)).toEqual(IDS.slice(10))
  })

  it.each([
    ['edited evidence text', { likelyCause: 'changed' }, ['likelyCause']],
    ['a different owner', { ownerUid: 'someone-else' }, ['ownerUid']],
    ['a changed createdAt', { createdAt: new Date('2026-10-23T05:33:45.000Z') }, ['createdAt']],
    ['an extra field', { note: 'x' }, ['note']],
    ['a timestamp stored as a string', { createdAt: '2026-10-23T05:33:44.000Z' }, ['createdAt']],
    ['not simulated', { isSimulated: false }, ['isSimulated']],
    ['a partly migrated document', { _schemaVersion: 2 }, ['_schemaVersion']],
  ])('STOPs, writing nothing, for one document with %s', (_label, change, differences) => {
    const plan = planTimelineMigration(VERSIONS, reads(stored('v1', { [IDS[4]!]: change })))
    expect(plan.decision).toBe('STOP')
    expect(plan.updates).toEqual([])
    const doc = plan.documents.find((d) => d.id === IDS[4])!
    expect(doc.classification).toBe('CONFLICT')
    expect(doc.differences).toEqual(differences)
    expect(plan.reasons[0]).toContain(IDS[4])
  })

  it('STOPs when an allowlisted document is missing', () => {
    const incidents = stored('v1')
    incidents.delete(IDS[7]!)
    const plan = planTimelineMigration(VERSIONS, reads(incidents))
    expect(plan.decision).toBe('STOP')
    expect(plan.reasons).toContain(`${IDS[7]} is missing`)
  })

  it('STOPs when the owner has any incident outside the allowlist', () => {
    const incidents = stored('v1')
    const plan = planTimelineMigration(
      VERSIONS,
      reads(incidents, { ownerIncidentIds: [...incidents.keys(), `${OWNER}_INC-051`] })
    )
    expect(plan.decision).toBe('STOP')
    expect(plan.reasons.join()).toMatch(/1 incident\(s\) outside the allowlist/)
  })

  it('STOPs if a document not on the allowlist was read', () => {
    const incidents = stored('v1')
    incidents.set('intruder', { data: {}, updateTime: at(1) })
    expect(planTimelineMigration(VERSIONS, reads(incidents)).decision).toBe('STOP')
  })

  it('never plans to touch action logs; it only records their IDs', () => {
    const plan = planTimelineMigration(
      VERSIONS,
      reads(stored('v1'), { ownerActionLogIds: ['b', 'a'] })
    )
    expect(plan.ownerActionLogIds).toEqual(['a', 'b'])
    expect(plan.updates.every((u) => IDS.includes(u.id))).toBe(true)
  })

  it('digest changes whenever what was read changes (update time, action logs, a document)', () => {
    const base = planTimelineMigration(VERSIONS, reads(stored('v1'))).digest
    expect(planTimelineMigration(VERSIONS, reads(stored('v1'))).digest).toBe(base)

    const touched = stored('v1')
    touched.set(IDS[0]!, { ...touched.get(IDS[0]!)!, updateTime: at(1_793_000_000, 123_456_790) })
    expect(planTimelineMigration(VERSIONS, reads(touched)).digest).not.toBe(base)
    expect(
      planTimelineMigration(VERSIONS, reads(stored('v1'), { ownerActionLogIds: ['x'] })).digest
    ).not.toBe(base)
  })
})

describe('rollback and verification', () => {
  it('rollback restores v1 for every v2 document: old lastSignalAt, reportedAt removed, version 1', () => {
    const v2 = stored('v2')
    const plan = planTimelineRollback(VERSIONS, v2)
    expect(plan.decision).toBe('PROCEED')
    expect(plan.updates).toHaveLength(50)
    for (const [i, update] of plan.updates.entries()) {
      expect(update.patch.reportedAt).toBe(DELETE_FIELD)
      expect(update.patch.lastSignalAt.getTime()).toBe(VERSIONS[i]!.v1.lastSignalAt.getTime())
      expect(update.patch._schemaVersion).toBe(1)
      expect(update.lastUpdateTime).toEqual(v2.get(update.id)!.updateTime)
    }
    expect(planTimelineRollback(VERSIONS, stored('v1')).decision).toBe('NOTHING_TO_DO')
    expect(
      planTimelineRollback(VERSIONS, stored('v2', { [IDS[0]!]: { suburb: 'x' } })).decision
    ).toBe('STOP')
  })

  it('verification passes only when all 50 are exactly v2 and nothing else changed', () => {
    const before = planTimelineMigration(
      VERSIONS,
      reads(stored('v1'), { ownerActionLogIds: ['log1'] })
    )
    expect(
      verifyMigrated(VERSIONS, before, reads(stored('v2'), { ownerActionLogIds: ['log1'] })).ok
    ).toBe(true)

    const notAll = stored('v2')
    notAll.set(IDS[3]!, stored('v1').get(IDS[3]!)!)
    expect(
      verifyMigrated(VERSIONS, before, reads(notAll, { ownerActionLogIds: ['log1'] })).failures
    ).toEqual([`${IDS[3]} is V1_ORIGINAL`])
    expect(
      verifyMigrated(VERSIONS, before, reads(stored('v2'), { ownerActionLogIds: [] })).ok
    ).toBe(false)
    const extra = reads(stored('v2'), { ownerActionLogIds: ['log1'] })
    expect(
      verifyMigrated(VERSIONS, before, {
        ...extra,
        ownerIncidentIds: [...extra.ownerIncidentIds, 'new'],
      }).ok
    ).toBe(false)
  })

  it('the backup snapshot is canonical and includes the update times', () => {
    const snapshot = snapshotOf(stored('v1'))
    expect(snapshot).toBe(snapshotOf(new Map([...stored('v1')].reverse())))
    expect(snapshot).toContain('"updateTime"')
    expect(snapshot).toContain(IDS[49])
  })
})
