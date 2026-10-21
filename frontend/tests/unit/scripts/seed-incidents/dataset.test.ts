// @vitest-environment node
import { describe, expect, it } from 'vitest'
// The seed script lives outside src/, so the @/ alias cannot reach it.
import {
  CATEGORY_DISTRIBUTION,
  SEED_INCIDENT_COUNT,
  buildSeedIncidents,
  type SeedRecord,
} from '../../../../scripts/seed-incidents/dataset'
import {
  FICTIONAL_DATA_NOTE,
  SCENARIOS,
  SILENT_MAX_HEARTBEAT_AGE_MINUTES,
} from '../../../../scripts/seed-incidents/scenarios'

const OWNER = 'demoOperatorUid01'
const NOW = new Date('2026-10-21T00:00:00.000Z')

/** The 15 required fields of the Incident type (frontend/src/types/firestore.ts). */
const INCIDENT_FIELDS = [
  'ownerUid',
  'incidentCode',
  'deviceId',
  'status',
  'suburb',
  'state',
  'postcode',
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
  it('has exactly the 15 Incident fields on every record', () => {
    expect(INCIDENT_FIELDS).toHaveLength(15)
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
      expect(data._schemaVersion).toBe(1)
      for (const text of [data.likelyCause, data.evidenceSummary, data.recommendedAction]) {
        expect(typeof text).toBe('string')
        expect(text.length).toBeGreaterThan(20)
      }
    }
  })

  it('uses real Victorian suburbs only once each', () => {
    expect(new Set(records.map((r) => r.data.suburb)).size).toBe(50)
  })

  it('derives timestamps from the injected now', () => {
    for (const { data } of records) {
      expect(data.createdAt).toBeInstanceOf(Date)
      expect(data.lastSignalAt).toBeInstanceOf(Date)
      expect(data.createdAt.getTime()).toBe(NOW.getTime())
      const ageMinutes = (NOW.getTime() - data.lastSignalAt.getTime()) / 60_000
      expect(ageMinutes).toBeGreaterThanOrEqual(10)
      expect(ageMinutes).toBeLessThanOrEqual(72 * 60)
    }
  })

  it('does not share Date instances with the caller or between fields', () => {
    const now = new Date(NOW.getTime())
    const [first] = buildSeedIncidents(OWNER, now)
    now.setFullYear(2000)
    expect(first?.data.createdAt.getTime()).toBe(NOW.getTime())
  })

  it('rejects owner UIDs that would break the rules incidentId pattern', () => {
    for (const bad of ['', 'has space', 'slash/uid', 'dot.uid', 'a'.repeat(121)]) {
      expect(() => buildSeedIncidents(bad, NOW)).toThrow(/ownerUid/)
    }
    expect(buildSeedIncidents('a'.repeat(120), NOW)[49]?.id).toMatch(RULES_INCIDENT_ID)
  })
})

describe('seed dataset signal ages', () => {
  const ageMinutes = (r: SeedRecord) => (NOW.getTime() - r.data.lastSignalAt.getTime()) / 60_000
  const silent = records.filter((r) => r.data.status === 'SILENT')
  const offline = records.filter((r) => r.data.status === 'OFFLINE')

  it('uses a 60-minute demonstration threshold for SILENT heartbeats', () => {
    expect(SILENT_MAX_HEARTBEAT_AGE_MINUTES).toBe(60)
  })

  it('gives every SILENT pendant a recent heartbeat (10–60 minutes old)', () => {
    expect(silent).toHaveLength(14)
    for (const r of silent) {
      expect(ageMinutes(r), r.data.incidentCode).toBeGreaterThanOrEqual(10)
      expect(ageMinutes(r), r.data.incidentCode).toBeLessThanOrEqual(
        SILENT_MAX_HEARTBEAT_AGE_MINUTES
      )
    }
  })

  it('keeps the broad 10-minute to 72-hour range, with the long gaps on OFFLINE incidents', () => {
    const all = records.map(ageMinutes)
    expect(Math.min(...all)).toBe(10)
    expect(Math.max(...all)).toBe(72 * 60)
    const longGaps = records.filter((r) => ageMinutes(r) > SILENT_MAX_HEARTBEAT_AGE_MINUTES)
    expect(longGaps.every((r) => r.data.status === 'OFFLINE')).toBe(true)
    expect(offline.filter((r) => ageMinutes(r) >= 24 * 60).length).toBeGreaterThanOrEqual(5)
  })

  it('keeps planned-maintenance signal gaps short enough to sit inside a maintenance window', () => {
    for (const r of records.filter((x) => x.data.causeCategory === 'PLANNED_MAINTENANCE')) {
      expect(ageMinutes(r), r.data.incidentCode).toBeLessThanOrEqual(4 * 60)
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
