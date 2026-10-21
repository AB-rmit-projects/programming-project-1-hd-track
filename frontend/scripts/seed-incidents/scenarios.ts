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
   * How long before seed time the simulated last signal was received:
   * OFFLINE — when the heartbeat stopped; SILENT — the most recent heartbeat
   * (at most SILENT_MAX_HEARTBEAT_AGE_MINUTES ago).
   */
  signalOffsetMinutes: number
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
 * (`lastSignalAt`). A demonstration assumption for this fictional dataset,
 * not a verified SafeCall operational threshold.
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
 */
export const SCENARIOS: readonly Scenario[] = [
  { kind: 'OUTAGE_OFFLINE', suburb: 'Ballarat', postcode: '3350', signalOffsetMinutes: 95 },
  { kind: 'DEVICE_BATTERY_OFFLINE', suburb: 'Bendigo', postcode: '3550', signalOffsetMinutes: 410 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Geelong', postcode: '3220', signalOffsetMinutes: 45 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Shepparton', postcode: '3630', signalOffsetMinutes: 180 },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Bright',
    postcode: '3741',
    signalOffsetMinutes: 260,
  },
  {
    kind: 'DEVICE_FAULT_SILENT',
    suburb: 'Warrnambool',
    postcode: '3280',
    signalOffsetMinutes: 22,
  },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Mildura', postcode: '3500', signalOffsetMinutes: 30 },
  { kind: 'INCONCLUSIVE_SILENT', suburb: 'Traralgon', postcode: '3844', signalOffsetMinutes: 41 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Wodonga', postcode: '3690', signalOffsetMinutes: 120 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Sale', postcode: '3850', signalOffsetMinutes: 1440 },
  { kind: 'DEVICE_BATTERY_OFFLINE', suburb: 'Horsham', postcode: '3400', signalOffsetMinutes: 960 },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'flood',
    suburb: 'Echuca',
    postcode: '3564',
    signalOffsetMinutes: 18,
  },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Bairnsdale', postcode: '3875', signalOffsetMinutes: 15 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Wangaratta', postcode: '3677', signalOffsetMinutes: 75 },
  { kind: 'DEVICE_FAULT_SILENT', suburb: 'Swan Hill', postcode: '3585', signalOffsetMinutes: 47 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Hamilton', postcode: '3300', signalOffsetMinutes: 230 },
  { kind: 'INCONCLUSIVE_SILENT', suburb: 'Portland', postcode: '3305', signalOffsetMinutes: 33 },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'storm',
    suburb: 'Lakes Entrance',
    postcode: '3909',
    signalOffsetMinutes: 150,
  },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Colac', postcode: '3250', signalOffsetMinutes: 200 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Benalla', postcode: '3672', signalOffsetMinutes: 60 },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Castlemaine',
    postcode: '3450',
    signalOffsetMinutes: 2160,
  },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Kyneton', postcode: '3444', signalOffsetMinutes: 400 },
  { kind: 'DEVICE_FAULT_SILENT', suburb: 'Seymour', postcode: '3660', signalOffsetMinutes: 12 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Ararat', postcode: '3377', signalOffsetMinutes: 35 },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'flood',
    suburb: 'Kerang',
    postcode: '3579',
    signalOffsetMinutes: 55,
  },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Maryborough', postcode: '3465', signalOffsetMinutes: 125 },
  { kind: 'INCONCLUSIVE_SILENT', suburb: 'Morwell', postcode: '3840', signalOffsetMinutes: 28 },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Healesville',
    postcode: '3777',
    signalOffsetMinutes: 85,
  },
  { kind: 'DEVICE_BATTERY_OFFLINE', suburb: 'Moe', postcode: '3825', signalOffsetMinutes: 1200 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Warragul', postcode: '3820', signalOffsetMinutes: 20 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Leongatha', postcode: '3953', signalOffsetMinutes: 160 },
  { kind: 'DEVICE_FAULT_SILENT', suburb: 'Wonthaggi', postcode: '3995', signalOffsetMinutes: 38 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Stawell', postcode: '3380', signalOffsetMinutes: 1980 },
  {
    kind: 'INCONCLUSIVE_SILENT',
    suburb: 'Bacchus Marsh',
    postcode: '3340',
    signalOffsetMinutes: 50,
  },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'bushfire',
    suburb: 'Orbost',
    postcode: '3888',
    signalOffsetMinutes: 3600,
  },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Daylesford', postcode: '3460', signalOffsetMinutes: 55 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Torquay', postcode: '3228', signalOffsetMinutes: 110 },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Mansfield',
    postcode: '3722',
    signalOffsetMinutes: 4320,
  },
  {
    kind: 'HAZARD_SILENT',
    hazard: 'storm',
    suburb: 'Lorne',
    postcode: '3232',
    signalOffsetMinutes: 26,
  },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Frankston', postcode: '3199', signalOffsetMinutes: 10 },
  { kind: 'DEVICE_FAULT_SILENT', suburb: 'Dandenong', postcode: '3175', signalOffsetMinutes: 58 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Werribee', postcode: '3030', signalOffsetMinutes: 140 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Sunbury', postcode: '3429', signalOffsetMinutes: 315 },
  {
    kind: 'HAZARD_OFFLINE',
    hazard: 'flood',
    suburb: 'Cobram',
    postcode: '3644',
    signalOffsetMinutes: 2880,
  },
  { kind: 'INCONCLUSIVE_SILENT', suburb: 'Melton', postcode: '3337', signalOffsetMinutes: 44 },
  {
    kind: 'DEVICE_BATTERY_OFFLINE',
    suburb: 'Pakenham',
    postcode: '3810',
    signalOffsetMinutes: 1800,
  },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Cranbourne', postcode: '3977', signalOffsetMinutes: 90 },
  { kind: 'DEVICE_FAULT_SILENT', suburb: 'Mornington', postcode: '3931', signalOffsetMinutes: 15 },
  { kind: 'OUTAGE_OFFLINE', suburb: 'Ocean Grove', postcode: '3226', signalOffsetMinutes: 240 },
  { kind: 'MAINTENANCE_OFFLINE', suburb: 'Camperdown', postcode: '3260', signalOffsetMinutes: 25 },
]
