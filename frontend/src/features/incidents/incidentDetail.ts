import { isRecord, parseIncident, readText, toStoredDate } from './incidentRow'
import type { IncidentDetail, ParsedIncidentDetail } from './types'

type EvidenceField = 'likelyCause' | 'evidenceSummary' | 'recommendedAction'

/**
 * Turns one incident document into what the detail page may show.
 *
 * Builds on parseIncident, so the queue fields are checked exactly as on the
 * dashboard and a record without `isSimulated: true` is rejected the same way.
 * On top of that:
 *
 * - `ownerUid` must equal the operator who asked for it. The security rules
 *   already refuse anyone else's incident; this is a second check, not a
 *   replacement for them.
 * - The evidence fields, `state`, `createdAt` and `_schemaVersion` are checked;
 *   anything missing or unexpected becomes null (or, for `_schemaVersion`, is
 *   only reported) and its field name is added to `dataIssues`.
 *
 * Nothing is ever filled in: a missing value stays missing.
 */
export function parseIncidentDetail(
  id: string,
  data: unknown,
  expected: { ownerUid: string }
): ParsedIncidentDetail {
  const parsed = parseIncident(id, data)
  if (!parsed.ok) return parsed

  const record = isRecord(data) ? data : {}
  if (record.ownerUid !== expected.ownerUid) return { ok: false, id, reason: 'OWNER_MISMATCH' }

  const dataIssues: IncidentDetail['dataIssues'] = [...parsed.row.dataIssues]
  const text = (field: EvidenceField) => readText(record, field, dataIssues)

  const state = record.state === 'VIC' ? record.state : null
  if (state === null) dataIssues.push('state')

  const likelyCause = text('likelyCause')
  const evidenceSummary = text('evidenceSummary')
  const recommendedAction = text('recommendedAction')

  const createdAt = toStoredDate(record.createdAt)
  if (createdAt === null) dataIssues.push('createdAt')

  // A different version may mean different field meanings; the values above
  // were each checked, so they are still shown, but the mismatch is reported.
  if (record._schemaVersion !== 1) dataIssues.push('_schemaVersion')

  return {
    ok: true,
    detail: {
      ...parsed.row,
      state,
      likelyCause,
      evidenceSummary,
      recommendedAction,
      createdAt,
      dataIssues,
    },
  }
}
