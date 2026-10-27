// @vitest-environment node
import { describe, expect, it } from 'vitest'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import {
  CATEGORY_DISTRIBUTION,
  LATEST_REPORTED_AT,
  SEED_INCIDENT_COUNT,
  buildSeedIncidents,
  type SeedRecord,
} from '../../../../scripts/seed-incidents/dataset'
import {
  FICTIONAL_DATA_NOTE,
  SCENARIOS,
  SILENT_MAX_HEARTBEAT_AGE_MINUTES,
} from '../../../../scripts/seed-incidents/scenarios'
import { melbourneDateKey, toMelbourneLocal } from '@/lib/melbourneTime'

const OWNER = 'demoOperatorUid01'
const NOW = new Date('2026-10-21T00:00:00.000Z')

/** The 16 required fields of the Incident type, schema v2 (frontend/src/types/firestore.ts). */
const INCIDENT_FIELDS = [
  'ownerUid',
  'incidentCode',
  'deviceId',
  'status',
  'suburb',
  'state',
  'postcode',
  'reportedAt',
  'lastSignalAt',
  'causeCategory',
  'likelyCause',
  'recommendedAction',
  'evidenceSummary',
  'isSimulated',
  'createdAt',
  '_schemaVersion',
]

/** Document IDs must satisfy the actionLogs rule's incidentId pattern. */
const RULES_INCIDENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Allowed (category, status) pairs — mirrors the approved Phase 3 matrix. */
const ALLOWED_STATUSES: Record<string, string[]> = {
  UNPLANNED_OUTAGE: ['OFFLINE'],
  PLANNED_MAINTENANCE: ['OFFLINE'],
  DEVICE_SIDE: ['OFFLINE', 'SILENT'],
  EXTERNAL_HAZARD: ['OFFLINE', 'SILENT'],
  INSUFFICIENT_EVIDENCE: ['SILENT'],
}

/** Words that would imply a real, confirmed event, a dispatch, or a real organisation. */
const BANNED_TERMS = [
  /\bconfirmed\b/i,
  /\bverified\b/i,
  /\bdispatch(ed)?\b/i,
  /\bambulance\b/i,
  /\bpolice\b/i,
  /\b000\b/,
  /\bwelfare check\b/i,
  /\b(telstra|optus|vodafone|tpg|nbn)\b/i,
  /\b(powercor|ausnet|jemena|citipower)\b/i,
  /\b(cfa|ses|vicemergency|bureau of meteorology|bom)\b/i,
]

const records = buildSeedIncidents(OWNER, NOW)

function countBy(list: SeedRecord[], key: (r: SeedRecord) => string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of list) counts[key(r)] = (counts[key(r)] ?? 0) + 1
  return counts
}

describe('seed dataset size and identity', () => {
  it('has exactly 50 scenarios and 50 records', () => {
    expect(SEED_INCIDENT_COUNT).toBe(50)
    expect(SCENARIOS).toHaveLength(50)
    expect(records).toHaveLength(50)
  })

  it('uses incident codes INC-001 to INC-050 in order with no gaps', () => {
    const expected = Array.from({ length: 50 }, (_, i) => `INC-${String(i + 1).padStart(3, '0')}`)
    expect(records.map((r) => r.data.incidentCode)).toEqual(expected)
  })

  it('derives deterministic owner-scoped document IDs', () => {
    for (const r of records) {
      expect(r.id).toBe(`${OWNER}_${r.data.incidentCode}`)
      expect(r.id).toMatch(RULES_INCIDENT_ID)
    }
    expect(new Set(records.map((r) => r.id)).size).toBe(50)
  })

  it('gives every record a unique fictional pendant ID', () => {
    const ids = records.map((r) => r.data.deviceId)
    expect(new Set(ids).size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^SC-\d{4}$/)
  })

  it('assigns every record to the given owner', () => {
    for (const r of records) expect(r.data.ownerUid).toBe(OWNER)
  })

  it('produces disjoint document IDs for different owners but the same device IDs', () => {
    const other = buildSeedIncidents('anotherDemoUid', NOW)
    const ids = new Set(records.map((r) => r.id))
    expect(other.some((r) => ids.has(r.id))).toBe(false)
    expect(other.map((r) => r.data.deviceId)).toEqual(records.map((r) => r.data.deviceId))
  })

  it('is deterministic for the same inputs', () => {
    expect(buildSeedIncidents(OWNER, NOW)).toEqual(records)
  })
})

describe('seed dataset distribution', () => {
  it('matches the approved 15/12/10/8/5 category distribution', () => {
    expect(CATEGORY_DISTRIBUTION).toEqual({
      UNPLANNED_OUTAGE: 15,
      DEVICE_SIDE: 12,
      PLANNED_MAINTENANCE: 10,
      EXTERNAL_HAZARD: 8,
      INSUFFICIENT_EVIDENCE: 5,
    })
    expect(countBy(records, (r) => r.data.causeCategory)).toEqual(CATEGORY_DISTRIBUTION)
  })

  it('uses 36 OFFLINE and 14 SILENT statuses', () => {
    expect(countBy(records, (r) => r.data.status)).toEqual({ OFFLINE: 36, SILENT: 14 })
  })

  it('interleaves categories instead of grouping them in blocks', () => {
    const firstTen = new Set(records.slice(0, 10).map((r) => r.data.causeCategory))
    expect(firstTen.size).toBe(5)
  })
})

describe('seed dataset schema', () => {
  it('has exactly the 16 Incident fields on every record', () => {
    expect(INCIDENT_FIELDS).toHaveLength(16)
    for (const r of records) {
      expect(Object.keys(r.data).sort()).toEqual([...INCIDENT_FIELDS].sort())
    }
  })

  it('uses the correct value types and constants', () => {
    for (const { data } of records) {
      expect(['OFFLINE', 'SILENT']).toContain(data.status)
      expect(data.state).toBe('VIC')
      expect(data.postcode).toMatch(/^3\d{3}$/)
      expect(typeof data.suburb).toBe('string')
      expect(data.suburb.length).toBeGreaterThan(0)
      expect(data.isSimulated).toBe(true)
      expect(data._schemaVersion).toBe(2)
      for (const text of [data.likelyCause, data.evidenceSummary, data.recommendedAction]) {
        expect(typeof text).toBe('string')
        expect(text.length).toBeGreaterThan(20)
      }
    }
  })

  it('uses real Victorian suburbs only once each', () => {
    expect(new Set(records.map((r) => r.data.suburb)).size).toBe(50)
  })

  it('uses now only for createdAt (the real write time); simulated times come from the timeline', () => {
    const later = buildSeedIncidents(OWNER, new Date('2026-11-30T12:00:00.000Z'))
    for (const [i, { data }] of records.entries()) {
      expect(data.createdAt).toBeInstanceOf(Date)
      expect(data.reportedAt).toBeInstanceOf(Date)
      expect(data.lastSignalAt).toBeInstanceOf(Date)
      expect(data.createdAt.getTime()).toBe(NOW.getTime())
      expect(later[i]!.data.reportedAt.getTime()).toBe(data.reportedAt.getTime())
      expect(later[i]!.data.lastSignalAt.getTime()).toBe(data.lastSignalAt.getTime())
    }
  })

  it('does not share Date instances with the caller, between fields or between records', () => {
    const now = new Date(NOW.getTime())
    const [first, second] = buildSeedIncidents(OWNER, now)
    now.setFullYear(2000)
    expect(first?.data.createdAt.getTime()).toBe(NOW.getTime())
    first!.data.reportedAt.setFullYear(2000)
    expect(buildSeedIncidents(OWNER, NOW)[0]!.data.reportedAt.getFullYear()).toBe(2026)
    expect(first!.data.reportedAt).not.toBe(second!.data.reportedAt)
  })

  it('refuses a seed time before the latest report time (no future-dated incidents)', () => {
    expect(LATEST_REPORTED_AT.toISOString()).toBe('2026-10-20T09:12:07.000Z')
    expect(() => buildSeedIncidents(OWNER, new Date(LATEST_REPORTED_AT.getTime() - 1))).toThrow(
      /future/
    )
    expect(() => buildSeedIncidents(OWNER, new Date(Number.NaN))).toThrow(/future/)
    expect(buildSeedIncidents(OWNER, LATEST_REPORTED_AT)).toHaveLength(50)
  })

  it('rejects owner UIDs that would break the rules incidentId pattern', () => {
    for (const bad of ['', 'has space', 'slash/uid', 'dot.uid', 'a'.repeat(121)]) {
      expect(() => buildSeedIncidents(bad, NOW)).toThrow(/ownerUid/)
    }
    expect(buildSeedIncidents('a'.repeat(120), NOW)[49]?.id).toMatch(RULES_INCIDENT_ID)
  })
})

describe('seed dataset timeline (schema v2)', () => {
  const gapMinutes = (r: SeedRecord) =>
    (r.data.reportedAt.getTime() - r.data.lastSignalAt.getTime()) / 60_000
  const local = (date: Date) => toMelbourneLocal(date)
  const hour = (date: Date) => Number(local(date).slice(11, 13))
  const byCode = (code: string) => records.find((r) => r.data.incidentCode === code)!
  const silent = records.filter((r) => r.data.status === 'SILENT')
  const offline = records.filter((r) => r.data.status === 'OFFLINE')

  it('reports every incident between 1 September and 20 October 2026 (Melbourne dates)', () => {
    for (const r of records) {
      const day = melbourneDateKey(r.data.reportedAt)
      expect(day >= '2026-09-01' && day <= '2026-10-20', r.data.incidentCode).toBe(true)
    }
  })

  it('splits the incidents 25 September / 25 October', () => {
    expect(countBy(records, (r) => melbourneDateKey(r.data.reportedAt).slice(0, 7))).toEqual({
      '2026-09': 25,
      '2026-10': 25,
    })
  })

  it('keeps every time in the past relative to the real write time', () => {
    for (const { data } of records) {
      expect(data.lastSignalAt.getTime()).toBeLessThan(data.reportedAt.getTime())
      expect(data.reportedAt.getTime()).toBeLessThanOrEqual(data.createdAt.getTime())
    }
  })

  it('spreads report times over the whole day and night', () => {
    const quarters = countBy(records, (r) => String(Math.floor(hour(r.data.reportedAt) / 6)))
    expect(Object.keys(quarters).sort()).toEqual(['0', '1', '2', '3'])
    for (const count of Object.values(quarters)) expect(count).toBeGreaterThanOrEqual(8)
  })

  it('has no repeated clock pattern: varied minutes and seconds, no 4:33 pm cluster', () => {
    const minutes = new Set(records.map((r) => local(r.data.reportedAt).slice(14, 16)))
    expect(minutes.size).toBeGreaterThanOrEqual(30)
    const times = new Set(records.map((r) => local(r.data.reportedAt).slice(11, 16)))
    expect(times.size).toBe(50)
    expect(records.filter((r) => local(r.data.reportedAt).slice(11, 16) === '16:33')).toHaveLength(
      0
    )
    expect(records.every((r) => r.data.reportedAt.getUTCSeconds() !== 0)).toBe(true)
    expect(new Set(records.map((r) => r.data.reportedAt.getUTCSeconds())).size).toBeGreaterThan(25)
  })

  it('uses irregular signal gaps, not a fixed offset or round numbers', () => {
    const gaps = records.map(gapMinutes)
    expect(new Set(gaps.map((g) => Math.round(g))).size).toBeGreaterThanOrEqual(35)
    expect(gaps.filter((g) => Number.isInteger(g) && g % 5 === 0)).toHaveLength(0)
  })

  it('uses a 60-minute demonstration threshold for SILENT heartbeats', () => {
    expect(SILENT_MAX_HEARTBEAT_AGE_MINUTES).toBe(60)
  })

  it('gives every SILENT pendant a recent heartbeat (10–60 minutes before the report)', () => {
    expect(silent).toHaveLength(14)
    for (const r of silent) {
      expect(gapMinutes(r), r.data.incidentCode).toBeGreaterThanOrEqual(10)
      expect(gapMinutes(r), r.data.incidentCode).toBeLessThanOrEqual(
        SILENT_MAX_HEARTBEAT_AGE_MINUTES
      )
    }
  })

  it('puts planned-maintenance losses in an overnight window, reported soon after', () => {
    const maintenance = records.filter((r) => r.data.causeCategory === 'PLANNED_MAINTENANCE')
    expect(maintenance).toHaveLength(10)
    for (const r of maintenance) {
      expect(hour(r.data.lastSignalAt), r.data.incidentCode).toBeLessThan(4)
      expect(gapMinutes(r), r.data.incidentCode).toBeLessThanOrEqual(90)
    }
  })

  it('lets battery losses build up over hours, and keeps long gaps on OFFLINE incidents', () => {
    const battery = records.filter((r) => r.data.likelyCause.includes('battery'))
    expect(battery).toHaveLength(6)
    for (const r of battery) {
      expect(gapMinutes(r), r.data.incidentCode).toBeGreaterThanOrEqual(6 * 60)
      expect(gapMinutes(r), r.data.incidentCode).toBeLessThanOrEqual(20 * 60)
    }
    const longGaps = records.filter((r) => gapMinutes(r) > SILENT_MAX_HEARTBEAT_AGE_MINUTES)
    expect(longGaps.every((r) => r.data.status === 'OFFLINE')).toBe(true)
    expect(offline.every((r) => gapMinutes(r) <= 20 * 60)).toBe(true)
  })

  it('groups hazard incidents in their fictional advisory periods', () => {
    const hazardDays = (kind: string) =>
      records
        .filter((r) => r.data.evidenceSummary.includes(`simulated ${kind} advisory`))
        .map((r) => melbourneDateKey(r.data.reportedAt))
    for (const day of hazardDays('flood'))
      expect(day >= '2026-09-21' && day <= '2026-09-25').toBe(true)
    for (const day of hazardDays('severe-storm'))
      expect(day >= '2026-10-02' && day <= '2026-10-06').toBe(true)
    for (const day of hazardDays('bushfire'))
      expect(day >= '2026-10-13' && day <= '2026-10-18').toBe(true)
    expect(hazardDays('flood')).toHaveLength(3)
    expect(hazardDays('severe-storm')).toHaveLength(2)
    expect(hazardDays('bushfire')).toHaveLength(3)
  })

  it('handles the start of daylight saving: INC-036 spans 01:47 AEST to 03:09 AEDT in 22 minutes', () => {
    const r = byCode('INC-036')
    expect(local(r.data.lastSignalAt)).toBe('2026-10-04T01:47:10')
    expect(local(r.data.reportedAt)).toBe('2026-10-04T03:09:22')
    expect(r.data.lastSignalAt.toISOString()).toBe('2026-10-03T15:47:10.000Z')
    expect(r.data.reportedAt.toISOString()).toBe('2026-10-03T16:09:22.000Z')
    expect(gapMinutes(r)).toBeCloseTo(22.2, 5)
  })

  it('pins representative CP8A timeline entries exactly', () => {
    expect(byCode('INC-001').data.reportedAt.toISOString()).toBe('2026-09-04T08:23:40.000Z')
    expect(local(byCode('INC-001').data.reportedAt)).toBe('2026-09-04T18:23:40')
    expect(local(byCode('INC-005').data.reportedAt)).toBe('2026-10-13T16:08:53')
    expect(local(byCode('INC-007').data.reportedAt)).toBe('2026-09-01T07:22:05')
    expect(local(byCode('INC-049').data.reportedAt)).toBe('2026-10-20T20:12:07')
  })

  it('keeps incident codes as dataset references, not in date order', () => {
    const chronological = [...records]
      .sort((a, b) => a.data.reportedAt.getTime() - b.data.reportedAt.getTime())
      .map((r) => r.data.incidentCode)
    expect(chronological).not.toEqual(records.map((r) => r.data.incidentCode))
  })

  it('defines every scenario time as a valid Melbourne wall-clock time', () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.reported).toMatch(/^2026-(09|10)-\d{2}T\d{2}:\d{2}:\d{2}$/)
      expect(scenario.lastSignal < scenario.reported).toBe(true)
    }
    for (const [i, r] of records.entries()) {
      expect(local(r.data.reportedAt)).toBe(SCENARIOS[i]!.reported)
      expect(local(r.data.lastSignalAt)).toBe(SCENARIOS[i]!.lastSignal)
    }
  })
})

describe('seed dataset semantic consistency', () => {
  it('only uses approved (category, status) pairs', () => {
    for (const { data } of records) {
      expect(ALLOWED_STATUSES[data.causeCategory]).toContain(data.status)
    }
  })

  it('describes OFFLINE as no heartbeat and SILENT as a heartbeat with a missed check-in', () => {
    for (const { data } of records) {
      const evidence = data.evidenceSummary.toLowerCase()
      if (data.status === 'OFFLINE') {
        expect(evidence).toContain('no heartbeat')
        expect(evidence).not.toMatch(/heartbeat still received|intermittent heartbeat/)
      } else {
        expect(evidence).toMatch(/heartbeat still received|intermittent heartbeat/)
        expect(evidence).not.toContain('no heartbeat')
        // A missing check-in must be stated outright; incomplete diagnostics alone are not enough.
        expect(evidence).toMatch(
          /missed check-in|check-in was missed|self-test was missed|check-in did not arrive/
        )
      }
    }
  })

  it('ties maintenance evidence to a scheduled window and outage evidence to none', () => {
    for (const { data } of records) {
      const evidence = data.evidenceSummary.toLowerCase()
      if (data.causeCategory === 'PLANNED_MAINTENANCE') {
        expect(evidence).toContain('scheduled maintenance window')
        expect(data.recommendedAction.toLowerCase()).toContain('maintenance window')
      }
      if (data.causeCategory === 'UNPLANNED_OUTAGE') {
        expect(evidence).toContain('no scheduled maintenance is listed')
      }
    }
  })

  it('treats hazards as associations, not proof of cause', () => {
    for (const { data } of records.filter((r) => r.data.causeCategory === 'EXTERNAL_HAZARD')) {
      expect(data.evidenceSummary).toMatch(/simulated (severe-storm|flood|bushfire) advisory/)
      expect(data.evidenceSummary).toContain('association only, not proof of cause')
      expect(data.likelyCause).toContain('may be associated')
    }
  })

  it('does not suggest a likely cause when evidence is insufficient', () => {
    for (const { data } of records.filter(
      (r) => r.data.causeCategory === 'INSUFFICIENT_EVIDENCE'
    )) {
      expect(data.likelyCause).toMatch(/insufficient|conflict/)
      expect(data.recommendedAction.toLowerCase()).toContain('manually review')
    }
  })

  it('mentions the incident suburb in its evidence', () => {
    for (const { data } of records) expect(data.evidenceSummary).toContain(data.suburb)
  })
})

describe('seed dataset wording', () => {
  it('labels cause and evidence as simulated and evidence as fictional', () => {
    for (const { data } of records) {
      expect(data.likelyCause.startsWith('Simulated assessment:')).toBe(true)
      expect(data.evidenceSummary.startsWith('Simulated evidence:')).toBe(true)
      expect(data.evidenceSummary.endsWith(FICTIONAL_DATA_NOTE)).toBe(true)
    }
  })

  it('contains no wording that implies a confirmed real event, dispatch or real organisation', () => {
    for (const { data } of records) {
      for (const text of [data.likelyCause, data.evidenceSummary, data.recommendedAction]) {
        for (const term of BANNED_TERMS) expect(text).not.toMatch(term)
      }
    }
  })

  it('does not quantify supporting devices that are not part of the seeded dataset', () => {
    const counted =
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|many)\s+(other\s+)?(nearby\s+)?(simulated\s+)?devices\b/i
    for (const { data } of records) expect(data.evidenceSummary).not.toMatch(counted)
  })

  it('keeps recommended actions advisory (escalation is only ever considered)', () => {
    for (const { data } of records) {
      const action = data.recommendedAction.toLowerCase()
      if (action.includes('escalat')) expect(action).toContain('consider escalation')
    }
  })
})
