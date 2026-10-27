// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  formatMelbourneDate,
  formatMelbourneDateTime,
  melbourneDateKey,
  melbourneLocalToUtc,
  toMelbourneLocal,
} from '@/lib/melbourneTime'

describe('melbourneLocalToUtc', () => {
  it.each([
    // AEST (UTC+10) before daylight saving starts on Sun 4 Oct 2026, 02:00
    ['2026-09-01T07:22:05', '2026-08-31T21:22:05.000Z'],
    ['2026-10-04T01:59:59', '2026-10-03T15:59:59.000Z'],
    // AEDT (UTC+11) from 03:00 that morning
    ['2026-10-04T03:00:00', '2026-10-03T16:00:00.000Z'],
    ['2026-10-13T16:08:53', '2026-10-13T05:08:53.000Z'],
    ['2026-10-20T20:12:07', '2026-10-20T09:12:07.000Z'],
    // A date where Melbourne is already a day ahead of UTC
    ['2026-09-08T01:19:03', '2026-09-07T15:19:03.000Z'],
  ])('%s Melbourne → %s', (local, iso) => {
    expect(melbourneLocalToUtc(local).toISOString()).toBe(iso)
  })

  it('round-trips every minute of the daylight-saving start day except the skipped hour', () => {
    let checked = 0
    for (let minutes = 0; minutes < 24 * 60; minutes++) {
      const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
      const mm = String(minutes % 60).padStart(2, '0')
      const local = `2026-10-04T${hh}:${mm}:00`
      if (hh === '02') {
        expect(() => melbourneLocalToUtc(local)).toThrow(/does not exist/)
        continue
      }
      expect(toMelbourneLocal(melbourneLocalToUtc(local))).toBe(local)
      checked++
    }
    expect(checked).toBe(23 * 60)
  })

  it('refuses an ambiguous time when daylight saving ends (02:00–02:59 happens twice)', () => {
    expect(() => melbourneLocalToUtc('2027-04-04T02:30:00')).toThrow(/ambiguous/)
    expect(melbourneLocalToUtc('2027-04-04T03:00:00').toISOString()).toBe(
      '2027-04-03T17:00:00.000Z'
    )
  })

  it.each(['2026-02-30T10:00:00', '2026-09-01 07:22:05', '2026-09-01T7:22:05', '', 'not a date'])(
    'refuses a malformed or impossible value: %j',
    (value) => {
      expect(() => melbourneLocalToUtc(value)).toThrow()
    }
  )
})

describe('Melbourne dates and display', () => {
  it('uses the Melbourne calendar date, not the UTC one', () => {
    // 20 Oct, 8:12 pm AEDT is 09:12 UTC on the same date; 4 Oct 3:09 am AEDT is 3 Oct in UTC.
    expect(melbourneDateKey(new Date('2026-10-20T09:12:07Z'))).toBe('2026-10-20')
    expect(melbourneDateKey(new Date('2026-10-03T16:09:22Z'))).toBe('2026-10-04')
    expect(melbourneDateKey(new Date('2026-10-20T13:00:00Z'))).toBe('2026-10-21') // midnight AEDT
    expect(melbourneDateKey(new Date('2026-10-20T12:59:59Z'))).toBe('2026-10-20')
  })

  it('formats with the weekday, the 12-hour time and the zone abbreviation', () => {
    expect(formatMelbourneDateTime(new Date('2026-10-13T05:08:53Z'))).toBe(
      'Tue, 13 Oct 2026, 4:08 pm AEDT'
    )
    expect(formatMelbourneDateTime(new Date('2026-09-07T15:19:03Z'))).toBe(
      'Tue, 8 Sept 2026, 1:19 am AEST'
    )
    expect(formatMelbourneDate(new Date('2026-10-03T16:09:22Z'))).toBe('4 Oct 2026')
  })

  it('formats the same regardless of the process time zone', () => {
    // The formatter pins Australia/Melbourne; TZ set for the test run has no effect.
    const at = new Date('2026-10-20T09:12:07Z')
    expect(formatMelbourneDateTime(at)).toBe('Tue, 20 Oct 2026, 8:12 pm AEDT')
    expect(toMelbourneLocal(at)).toBe('2026-10-20T20:12:07')
  })
})
