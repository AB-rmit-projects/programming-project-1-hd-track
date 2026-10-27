import { Timestamp } from 'firebase/firestore'
import type { CauseCategory, Incident } from '@/types/firestore'
import { CAUSE_CATEGORY_LABELS, INCIDENT_STATUS_LABELS } from './labels'
import type { IncidentRow, ParsedIncident } from './types'

type TextField = 'incidentCode' | 'deviceId' | 'suburb' | 'postcode'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Object.hasOwn, not `in`: inherited keys such as 'toString' are not codes.
function isStatus(value: unknown): value is Incident['status'] {
  return typeof value === 'string' && Object.hasOwn(INCIDENT_STATUS_LABELS, value)
}

function isCauseCategory(value: unknown): value is CauseCategory {
  return typeof value === 'string' && Object.hasOwn(CAUSE_CATEGORY_LABELS, value)
}

/**
 * The client SDK returns stored timestamps as Firestore Timestamp instances;
 * anything else (missing, string, number, plain Date) is unexpected.
 * A Timestamp built from NaN passes the SDK's range checks, so the resulting
 * Date is checked too.
 */
export function toStoredDate(value: unknown): Date | null {
  if (!(value instanceof Timestamp)) return null
  const date = value.toDate()
  return Number.isNaN(date.getTime()) ? null : date
}

/** A non-blank string, or null with `field` recorded in `dataIssues`. */
export function readText<Field extends string>(
  record: Record<string, unknown>,
  field: Field,
  dataIssues: Field[]
): string | null {
  const value = record[field]
  if (typeof value === 'string' && value.trim() !== '') return value
  dataIssues.push(field)
  return null
}

/**
 * Turns one incident document into a display-safe row.
 *
 * - `isSimulated` must be exactly `true`. Otherwise the record is rejected as a
 *   data-integrity error: it might not be demonstration data, so it must never
 *   be shown under the dashboard's "simulated" label.
 * - Any other missing or unexpected field becomes null and is recorded in
 *   `dataIssues`, so the row can still be listed with a fallback label.
 * - A version 1 record (`_schemaVersion: 1`) predates `reportedAt`: it is
 *   marked `legacyTimeline` and its report time stays null. That is the
 *   record's real state, not a data issue, and no time is ever made up for it.
 */
export function parseIncident(id: string, data: unknown): ParsedIncident {
  const record = isRecord(data) ? data : {}

  if (record.isSimulated !== true) {
    return { ok: false, id, reason: 'NOT_SIMULATED' }
  }

  const dataIssues: IncidentRow['dataIssues'] = []
  const text = (field: TextField) => readText(record, field, dataIssues)

  const incidentCode = text('incidentCode')
  const deviceId = text('deviceId')
  const suburb = text('suburb')
  const postcode = text('postcode')

  const status = isStatus(record.status) ? record.status : null
  if (status === null) dataIssues.push('status')

  const causeCategory = isCauseCategory(record.causeCategory) ? record.causeCategory : null
  if (causeCategory === null) dataIssues.push('causeCategory')

  const legacyTimeline = record._schemaVersion === 1
  const reportedAt = legacyTimeline ? null : toStoredDate(record.reportedAt)
  if (reportedAt === null && !legacyTimeline) dataIssues.push('reportedAt')

  const lastSignalAt = toStoredDate(record.lastSignalAt)
  if (lastSignalAt === null) dataIssues.push('lastSignalAt')

  return {
    ok: true,
    row: {
      id,
      incidentCode,
      deviceId,
      suburb,
      postcode,
      status,
      causeCategory,
      reportedAt,
      lastSignalAt,
      legacyTimeline,
      dataIssues,
    },
  }
}
