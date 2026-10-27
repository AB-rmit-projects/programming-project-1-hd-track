/**
 * Melbourne wall-clock time helpers.
 *
 * Every SafeCall time is shown in Australia/Melbourne time (AEST, UTC+10, or
 * AEDT, UTC+11 during daylight saving) regardless of the viewer's own time
 * zone or the server's (Vercel runs in UTC). Offsets come from the runtime's
 * time-zone database through Intl, so no daylight-saving dates are hard-coded.
 *
 * No `@/` imports: the seed scripts (run with plain Node) import this file too.
 */

export const MELBOURNE_TIME_ZONE = 'Australia/Melbourne'

/** `YYYY-MM-DDTHH:MM:SS` — a Melbourne wall-clock time without an offset. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/

/** `YYYY-MM-DD` — a Melbourne calendar date. */
export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

// sv-SE formats as `YYYY-MM-DD HH:MM:SS`, which is easy to read back reliably.
const PARTS = new Intl.DateTimeFormat('sv-SE', {
  timeZone: MELBOURNE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** The Melbourne wall-clock reading of an instant, as `YYYY-MM-DDTHH:MM:SS`. */
export function toMelbourneLocal(date: Date): string {
  return PARTS.format(date).replace(' ', 'T')
}

/** The Melbourne calendar date of an instant, as `YYYY-MM-DD`. */
export function melbourneDateKey(date: Date): string {
  return toMelbourneLocal(date).slice(0, 10)
}

/**
 * The instant at which Melbourne clocks read `local`.
 *
 * Throws for a malformed value and for a wall-clock time that is ambiguous or
 * does not exist: when daylight saving starts (first Sunday in October)
 * 02:00–02:59 is skipped, and when it ends (first Sunday in April)
 * 02:00–02:59 happens twice. Refusing both keeps every generated time exact.
 */
export function melbourneLocalToUtc(local: string): Date {
  const match = LOCAL_DATE_TIME.exec(local)
  if (!match) throw new Error(`Not a local date-time (YYYY-MM-DDTHH:MM:SS): ${local}`)

  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, ...number[]]
  const asUtc = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)
  if (Number.isNaN(asUtc) || new Date(asUtc).toISOString().slice(0, 19) !== local) {
    throw new Error(`Not a valid calendar date-time: ${local}`)
  }

  // Melbourne is UTC+10 or UTC+11, so the instant is one of these two.
  const matches = [10, 11]
    .map((hours) => new Date(asUtc - hours * 3_600_000))
    .filter((candidate) => toMelbourneLocal(candidate) === local)

  if (matches.length === 0) {
    throw new Error(`${local} does not exist in Melbourne (daylight saving starts)`)
  }
  if (matches.length > 1) {
    throw new Error(`${local} is ambiguous in Melbourne (daylight saving ends)`)
  }
  return matches[0]!
}

const DISPLAY = new Intl.DateTimeFormat('en-AU', {
  timeZone: MELBOURNE_TIME_ZONE,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZoneName: 'short',
})

const DISPLAY_DATE = new Intl.DateTimeFormat('en-AU', {
  timeZone: MELBOURNE_TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

/** e.g. "Tue 13 Oct 2026, 4:08 pm AEDT" — always Melbourne time, with its zone. */
export function formatMelbourneDateTime(date: Date): string {
  return DISPLAY.format(date)
}

/** e.g. "13 Oct 2026" — the Melbourne calendar date. */
export function formatMelbourneDate(date: Date): string {
  return DISPLAY_DATE.format(date)
}
