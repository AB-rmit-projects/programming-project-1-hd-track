import type { CauseCategory, Incident } from '../../src/types/firestore'

/**
 * The 50 fictional SafeCall incident scenarios used by the Phase 3 seed script.
 *
 * Every scenario is simulated. Suburbs and postcodes are real Victorian
 * localities, but no incident, device, outage, maintenance window or hazard
 * advisory described here ever happened. See docs/SEEDING.md (Phase 3C).
 *
 * Status, cause, evidence and recommended action all derive from one
 * ScenarioKind, so they cannot contradict each other:
 *   OFFLINE — no network heartbeat from the pendant
 *   SILENT  — the pendant still sends a heartbeat (possibly intermittent),
 *             but an expected check-in or self-test is missing
 */

export type IncidentStatus = Incident['status']

export const SCENARIO_KINDS = {
  OUTAGE_OFFLINE: { category: 'UNPLANNED_OUTAGE', status: 'OFFLINE' },
  MAINTENANCE_OFFLINE: { category: 'PLANNED_MAINTENANCE', status: 'OFFLINE' },
  DEVICE_BATTERY_OFFLINE: { category: 'DEVICE_SIDE', status: 'OFFLINE' },
  DEVICE_FAULT_SILENT: { category: 'DEVICE_SIDE', status: 'SILENT' },
  HAZARD_OFFLINE: { category: 'EXTERNAL_HAZARD', status: 'OFFLINE' },
  HAZARD_SILENT: { category: 'EXTERNAL_HAZARD', status: 'SILENT' },
  INCONCLUSIVE_SILENT: { category: 'INSUFFICIENT_EVIDENCE', status: 'SILENT' },
} as const satisfies Record<string, { category: CauseCategory; status: IncidentStatus }>

export type ScenarioKind = keyof typeof SCENARIO_KINDS

export type HazardType = 'storm' | 'flood' | 'bushfire'

type HazardKind = 'HAZARD_OFFLINE' | 'HAZARD_SILENT'

interface ScenarioBase {
  suburb: string
  /** Real Victorian postcode for the suburb, stored as a string. */
  postcode: string
  /**
   * Melbourne wall-clock time (`YYYY-MM-DDTHH:MM:SS`) of the last heartbeat
   * received before the incident was reported. OFFLINE — when the heartbeat
   * stopped; SILENT — the most recent heartbeat, at most
   * SILENT_MAX_HEARTBEAT_AGE_MINUTES before `reported`.
   */
  lastSignal: string
  /** Melbourne wall-clock time at which the fictional monitoring platform raised the incident. */
  reported: string
}

export type Scenario =
  | (ScenarioBase & { kind: Exclude<ScenarioKind, HazardKind> })
  | (ScenarioBase & { kind: HazardKind; hazard: HazardType })

export interface ScenarioText {
  likelyCause: string
  evidenceSummary: string
  recommendedAction: string
}

/**
 * Maximum age, in minutes, of a SILENT pendant's most recent heartbeat
 * (`lastSignalAt`) when the incident is reported (`reportedAt`). A
 * demonstration assumption for this fictional dataset, not a verified SafeCall
 * operational threshold.
 */
export const SILENT_MAX_HEARTBEAT_AGE_MINUTES = 60

/** Appended to every evidence summary. */
export const FICTIONAL_DATA_NOTE = 'Fictional data — not a live feed.'

const HAZARD_ADVISORY: Record<HazardType, string> = {
  storm: 'severe-storm advisory',
  flood: 'flood advisory',
  bushfire: 'bushfire advisory',
}

type Variant = (scenario: Scenario) => { likelyCause: string; evidence: string }

const hazardOf = (s: Scenario): string =>
  'hazard' in s ? HAZARD_ADVISORY[s.hazard] : 'hazard advisory'

/** Cause/evidence wording per kind; the n-th scenario of a kind uses variant n mod length. */
const VARIANTS: Record<ScenarioKind, Variant[]> = {
  OUTAGE_OFFLINE: [
    (s) => ({
      likelyCause: `Simulated assessment: the signal loss is consistent with an unplanned network outage near ${s.suburb}.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. Simulated area telemetry for ${s.suburb} shows a wider loss of network service over the same period, and no scheduled maintenance is listed for the area.`,
    }),
    (s) => ({
      likelyCause: `Simulated assessment: an unplanned outage at the simulated cell site serving ${s.suburb} may explain the signal loss.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. The simulated cell site for ${s.suburb} reported degraded service at about the same time, and no scheduled maintenance is listed for the area.`,
    }),
    (s) => ({
      likelyCause: `Simulated assessment: the pattern is consistent with a localised unplanned network outage around ${s.suburb}.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. Simulated network telemetry for ${s.suburb} shows a matching service gap, the pendant's battery reading was normal before the loss, and no scheduled maintenance is listed for the area.`,
    }),
  ],
  MAINTENANCE_OFFLINE: [
    (s) => ({
      likelyCause: `Simulated assessment: the signal loss is consistent with scheduled network maintenance near ${s.suburb}.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. The loss falls inside a simulated scheduled maintenance window for the network serving ${s.suburb}.`,
    }),
    (s) => ({
      likelyCause: `Simulated assessment: planned maintenance on the simulated cell site serving ${s.suburb} may explain the signal loss.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. A simulated scheduled maintenance window for ${s.suburb} began shortly before the loss, and other simulated devices in the area show the same gap.`,
    }),
  ],
  DEVICE_BATTERY_OFFLINE: [
    (s) => ({
      likelyCause:
        'Simulated assessment: the signal loss is consistent with a depleted pendant battery.',
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. The pendant reported simulated low-battery warnings before the loss, while other simulated devices near ${s.suburb} remain healthy.`,
    }),
    (s) => ({
      likelyCause:
        'Simulated assessment: a pendant power issue, such as a battery that was not recharged, may explain the signal loss.',
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. The simulated battery level fell steadily over the preceding day, and nearby simulated devices in ${s.suburb} are reporting normally.`,
    }),
  ],
  DEVICE_FAULT_SILENT: [
    (s) => ({
      likelyCause:
        'Simulated assessment: the missed check-in is consistent with a pendant fault rather than a network problem.',
      evidence: `Simulated evidence: heartbeat still received from the pendant, but its scheduled self-test was missed. Other simulated devices near ${s.suburb} are reporting normally.`,
    }),
    (s) => ({
      likelyCause:
        'Simulated assessment: a pendant button or sensor fault may explain the missing check-in.',
      evidence: `Simulated evidence: heartbeat still received from the pendant, but the expected daily check-in did not arrive. Network conditions for simulated devices in ${s.suburb} appear normal.`,
    }),
  ],
  HAZARD_OFFLINE: [
    (s) => ({
      likelyCause: `Simulated assessment: the signal loss may be associated with conditions during a simulated ${hazardOf(s)} for ${s.suburb}, such as local power loss.`,
      evidence: `Simulated evidence: no heartbeat from the pendant since its last recorded signal. The loss coincides with a simulated ${hazardOf(s)} covering ${s.suburb}; this is an association only, not proof of cause.`,
    }),
  ],
  HAZARD_SILENT: [
    (s) => ({
      likelyCause: `Simulated assessment: the missed check-in may be associated with disruption during a simulated ${hazardOf(s)} for ${s.suburb}.`,
      evidence: `Simulated evidence: intermittent heartbeat from the pendant, and the expected check-in was missed during a simulated ${hazardOf(s)} covering ${s.suburb}; this is an association only, not proof of cause.`,
    }),
  ],
  INCONCLUSIVE_SILENT: [
    (s) => ({
      likelyCause:
        'Simulated assessment: the available evidence is insufficient to suggest a likely cause.',
      evidence: `Simulated evidence: intermittent heartbeat from the pendant and a missed check-in, but no simulated outage, maintenance window or device fault is recorded for ${s.suburb}.`,
    }),
    (s) => ({
      likelyCause:
        'Simulated assessment: the simulated signals conflict, so no likely cause can be suggested.',
      evidence: `Simulated evidence: intermittent heartbeat from the pendant and an expected check-in was missed; simulated network data for ${s.suburb} looks normal, yet the device's own diagnostics are incomplete.`,
    }),
  ],
}

/** Advisory only — recording ESCALATE in the app records intent, nothing is dispatched. */
const RECOMMENDED_ACTION: Record<ScenarioKind, string> = {
  OUTAGE_OFFLINE:
    "Try the client's alternate contact number; consider escalation if they cannot be reached, and re-check the device once simulated network service is restored.",
  MAINTENANCE_OFFLINE:
    "Confirm the client's wellbeing through an alternate contact channel, then re-check the device after the simulated maintenance window ends.",
  DEVICE_BATTERY_OFFLINE:
    'Contact the client or their nominated contact to charge or replace the pendant; consider escalation if no one can be reached.',
  DEVICE_FAULT_SILENT:
    'Contact the client to run a pendant test call; arrange a device replacement if the test fails.',
  HAZARD_OFFLINE:
    'Prioritise a contact attempt using every listed number; consider escalation if the client cannot be reached.',
  HAZARD_SILENT:
    'Contact the client to confirm their wellbeing and that the pendant is within reach.',
  INCONCLUSIVE_SILENT:
    'Manually review the simulated signal history, attempt contact with the client and record the findings before deciding on next steps.',
}

/** Text for a scenario; `occurrence` is its 0-based position among scenarios of the same kind. */
export function scenarioText(scenario: Scenario, occurrence: number): ScenarioText {
  const variants = VARIANTS[scenario.kind]
  const variant = variants[occurrence % variants.length]
  if (!variant) throw new Error(`No text variant for scenario kind ${scenario.kind}`)
  const { likelyCause, evidence } = variant(scenario)
  return {
    likelyCause,
    evidenceSummary: `${evidence} ${FICTIONAL_DATA_NOTE}`,
    recommendedAction: RECOMMENDED_ACTION[scenario.kind],
  }
}

/**
 * Row i becomes INC-{i+1}. Kinds are interleaved so the queue does not read as
 * category blocks. Distribution: 15 outage · 12 device (6 offline + 6 silent) ·
 * 10 maintenance · 8 hazard (5 offline + 3 silent) · 5 inconclusive.
 *
 * Timeline (Phase 6, schema v2): historical fictional incidents reported
 * between 1 September and 20 October 2026, 25 in each month, all in Melbourne
 * time. Incident codes are dataset references, not chronological. Each
 * scenario's times fit its evidence: maintenance losses fall in overnight
 * windows, battery losses build up over hours, SILENT heartbeats are recent,
 * and the fictional flood (21–25 Sep), storm (2–6 Oct) and bushfire
 * (13–18 Oct) advisories group their hazard incidents. INC-036 straddles the
 * start of daylight saving on 4 October (01:47 AEST → 03:09 AEDT, 22 minutes).
 */
export const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Ballarat',
    postcode: '3350',
    lastSignal: '2026-09-04T17:48:26',
    reported: '2026-09-04T18:23:40',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Bendigo',
    postcode: '3550',
    lastSignal: '2026-10-07T22:12:54',
    reported: '2026-10-08T06:47:19',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Geelong',
    postcode: '3220',
    lastSignal: '2026-09-08T00:52:38',
    reported: '2026-09-08T01:19:03',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Shepparton',
    postcode: '3630',
    lastSignal: '2026-09-22T07:55:12',
    reported: '2026-09-22T08:46:30',
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Bright',
    postcode: '3741',
    lastSignal: '2026-10-13T15:22:17',
    reported: '2026-10-13T16:08:53',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Warrnambool',
    postcode: '3280',
    lastSignal: '2026-10-20T08:52:26',
    reported: '2026-10-20T09:30:14',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Mildura',
    postcode: '3500',
    lastSignal: '2026-09-01T06:41:17',
    reported: '2026-09-01T07:22:05',
  },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Traralgon',
    postcode: '3844',
    lastSignal: '2026-10-12T13:34:26',
    reported: '2026-10-12T14:12:58',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Wodonga',
    postcode: '3690',
    lastSignal: '2026-09-30T02:33:16',
    reported: '2026-09-30T03:41:09',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Sale',
    postcode: '3850',
    lastSignal: '2026-10-07T21:53:07',
    reported: '2026-10-07T22:29:38',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Horsham',
    postcode: '3400',
    lastSignal: '2026-09-01T21:16:44',
    reported: '2026-09-02T08:05:31',
  },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'flood',
    suburb: 'Echuca',
    postcode: '3564',
    lastSignal: '2026-09-21T16:02:41',
    reported: '2026-09-21T16:51:08',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Bairnsdale',
    postcode: '3875',
    lastSignal: '2026-10-09T09:26:45',
    reported: '2026-10-09T10:51:02',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Wangaratta',
    postcode: '3677',
    lastSignal: '2026-10-19T01:58:13',
    reported: '2026-10-19T02:35:49',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Swan Hill',
    postcode: '3585',
    lastSignal: '2026-09-03T09:58:09',
    reported: '2026-09-03T10:31:52',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Hamilton',
    postcode: '3300',
    lastSignal: '2026-09-06T13:09:51',
    reported: '2026-09-06T14:57:12',
  },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Portland',
    postcode: '3305',
    lastSignal: '2026-09-09T15:12:04',
    reported: '2026-09-09T15:49:37',
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'storm',
    suburb: 'Lakes Entrance',
    postcode: '3909',
    lastSignal: '2026-10-06T15:37:42',
    reported: '2026-10-06T17:14:26',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Colac',
    postcode: '3250',
    lastSignal: '2026-09-09T01:41:12',
    reported: '2026-09-09T02:28:47',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Benalla',
    postcode: '3672',
    lastSignal: '2026-09-12T11:27:46',
    reported: '2026-09-12T13:02:19',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Castlemaine',
    postcode: '3450',
    lastSignal: '2026-09-10T19:33:08',
    reported: '2026-09-11T14:26:51',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Kyneton',
    postcode: '3444',
    lastSignal: '2026-09-17T04:18:55',
    reported: '2026-09-17T05:03:27',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Seymour',
    postcode: '3660',
    lastSignal: '2026-09-14T08:41:30',
    reported: '2026-09-14T09:15:02',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Ararat',
    postcode: '3377',
    lastSignal: '2026-09-26T01:04:27',
    reported: '2026-09-26T01:52:13',
  },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'flood',
    suburb: 'Kerang',
    postcode: '3579',
    lastSignal: '2026-09-23T05:47:03',
    reported: '2026-09-23T06:29:15',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Maryborough',
    postcode: '3465',
    lastSignal: '2026-09-16T20:04:13',
    reported: '2026-09-16T22:16:49',
  },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Morwell',
    postcode: '3840',
    lastSignal: '2026-09-19T22:37:19',
    reported: '2026-09-19T23:05:46',
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Healesville',
    postcode: '3777',
    lastSignal: '2026-10-18T14:09:58',
    reported: '2026-10-18T15:31:27',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Moe',
    postcode: '3825',
    lastSignal: '2026-09-23T23:49:58',
    reported: '2026-09-24T17:31:06',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Warragul',
    postcode: '3820',
    lastSignal: '2026-09-28T12:16:39',
    reported: '2026-09-28T13:05:24',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Leongatha',
    postcode: '3953',
    lastSignal: '2026-10-14T02:49:05',
    reported: '2026-10-14T03:20:41',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Wonthaggi',
    postcode: '3995',
    lastSignal: '2026-09-29T19:22:47',
    reported: '2026-09-29T19:58:31',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Stawell',
    postcode: '3380',
    lastSignal: '2026-10-01T10:44:02',
    reported: '2026-10-01T13:29:40',
  },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Bacchus Marsh',
    postcode: '3340',
    lastSignal: '2026-10-03T11:51:24',
    reported: '2026-10-03T12:43:07',
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Orbost',
    postcode: '3888',
    lastSignal: '2026-10-16T13:41:09',
    reported: '2026-10-16T17:56:44',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Daylesford',
    postcode: '3460',
    lastSignal: '2026-10-04T01:47:10',
    reported: '2026-10-04T03:09:22',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Torquay',
    postcode: '3228',
    lastSignal: '2026-10-10T14:48:11',
    reported: '2026-10-10T15:16:39',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Mansfield',
    postcode: '3722',
    lastSignal: '2026-10-10T16:05:33',
    reported: '2026-10-11T11:19:47',
  },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'storm',
    suburb: 'Lorne',
    postcode: '3232',
    lastSignal: '2026-10-02T18:26:33',
    reported: '2026-10-02T18:47:10',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Frankston',
    postcode: '3199',
    lastSignal: '2026-10-05T07:08:19',
    reported: '2026-10-05T07:31:55',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Dandenong',
    postcode: '3175',
    lastSignal: '2026-10-08T11:03:28',
    reported: '2026-10-08T11:30:16',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Werribee',
    postcode: '3030',
    lastSignal: '2026-09-15T03:06:31',
    reported: '2026-09-15T03:21:58',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Sunbury',
    postcode: '3429',
    lastSignal: '2026-10-14T18:57:36',
    reported: '2026-10-14T20:24:12',
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'flood',
    suburb: 'Cobram',
    postcode: '3644',
    lastSignal: '2026-09-25T02:11:37',
    reported: '2026-09-25T05:58:22',
  },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Melton',
    postcode: '3337',
    lastSignal: '2026-10-15T08:14:52',
    reported: '2026-10-15T08:45:30',
  },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Pakenham',
    postcode: '3810',
    lastSignal: '2026-10-16T20:38:21',
    reported: '2026-10-17T09:02:56',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Cranbourne',
    postcode: '3977',
    lastSignal: '2026-10-12T00:27:44',
    reported: '2026-10-12T00:51:09',
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Mornington',
    postcode: '3931',
    lastSignal: '2026-10-19T09:11:40',
    reported: '2026-10-19T09:39:05',
  },
  {
    kind: 'OUTAGE_OFFLINE',
    suburb: 'Ocean Grove',
    postcode: '3226',
    lastSignal: '2026-10-20T19:44:51',
    reported: '2026-10-20T20:12:07',
  },
  {
    kind: 'MAINTENANCE_OFFLINE',
    suburb: 'Camperdown',
    postcode: '3260',
    lastSignal: '2026-09-10T00:14:55',
    reported: '2026-09-10T00:39:20',
  },
]
