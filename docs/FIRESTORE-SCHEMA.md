# Firestore Schema

## Overview

All collections use the typed collection pattern — see `frontend/src/lib/firebase/firestore.ts`.
Security rules are in `firebase/firestore.rules`.

When adding a new collection, use the `/firebase-collection` Claude Code skill.

## Schema versioning

Every document in every collection **must** include a `_schemaVersion` field:

```typescript
_schemaVersion: 1  // increment when doing a breaking schema change
```

This enables **lazy migration** — when a document is read, check `_schemaVersion` and migrate on the fly if it's behind current. See the `/evolve-schema` skill for the full migration workflow.

**Rules:**
- `_schemaVersion` is always `1` on creation
- Non-breaking changes (adding optional fields with defaults) keep the same version
- Breaking changes (rename, remove, type change) increment the version and require a migration function
- Never remove `_schemaVersion` from a schema

---

## `users` collection

**Path:** `/users/{userId}`
**Access:** Owner-only (user can read/write their own document; admins can read all)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `uid` | `string` | Yes | Firebase Auth UID (same as document ID) |
| `email` | `string` | Yes | User's email address |
| `displayName` | `string \| null` | Yes | Display name from Auth or profile |
| `photoURL` | `string \| null` | Yes | Profile photo URL |
| `role` | `'user' \| 'admin'` | Yes | User role — immutable by user after creation |
| `createdAt` | `Timestamp` | Yes | When the document was created |
| `updatedAt` | `Timestamp` | Yes | When the document was last updated |
| `_schemaVersion` | `1` | Yes | Schema version for lazy migration |

**Creation:** Auto-created by `AuthProvider` on first sign-in via `syncUserProfile()`.
**Deletion:** Hard-delete is disabled in security rules. Use `deletedAt` field for soft-delete.

---

<!-- Add new collection schemas below using the /firebase-collection skill -->

## `incidents` collection (SafeCall)

> **Status:** the schema, rules and types below are implemented (Phase 2). The administrator seed script is implemented (Phase 3) and is emulator-only — see [SEEDING.md](SEEDING.md). **Live milestone (23 October 2026):** the project owner deployed the tested rules to `programming-project-1-hd-track`, and exactly 50 fictional, simulated incidents were created there for the designated demo operator by a separately controlled one-off tool outside this repository — see [SEEDING.md → Live demo data](SEEDING.md#live-demo-data-23-october-2026).

**Path:** `/incidents/{incidentId}` — seed IDs are deterministic: `{ownerUid}_{incidentCode}` (e.g. `abc123_INC-001`)
**Access:** verified owner may **read** only. All client creates/updates/deletes are denied — incidents are written only by administrator tooling via the Admin SDK (which bypasses rules): the Phase 3 seed script against the emulator, and the one-off live-demo tool described in SEEDING.md.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerUid` | `string` | Yes | Firebase Auth UID of the demo operator who owns the incident |
| `incidentCode` | `string` | Yes | Stable human label; the seed script uses `INC-001` … `INC-050` |
| `deviceId` | `string` | Yes | Unique fictional SafeCall pendant ID |
| `status` | `'OFFLINE' \| 'SILENT'` | Yes | Simulated connectivity state: `OFFLINE` = no heartbeat; `SILENT` = heartbeat but a missed check-in (see SEEDING.md) |
| `suburb` / `state` / `postcode` | `string` / `'VIC'` / `string` | Yes | Real Victorian suburb and postcode for a fictional incident; postcode stored as a string |
| `reportedAt` | `Timestamp` | Yes (v2) | **Simulated**: when the fictional monitoring platform raised the incident. Between 1 Jul and 27 Oct 2026 (Melbourne time); the primary time for display, sorting and the date filter. Absent in version 1 documents |
| `lastSignalAt` | `Timestamp` | Yes | **Simulated**: the last pendant heartbeat received before `reportedAt` (OFFLINE: when the heartbeat stopped; SILENT: the latest heartbeat, at most 60 minutes earlier). Not a live feed |
| `causeCategory` | `'UNPLANNED_OUTAGE' \| 'DEVICE_SIDE' \| 'PLANNED_MAINTENANCE' \| 'EXTERNAL_HAZARD' \| 'INSUFFICIENT_EVIDENCE'` | Yes | Scenario label; seed distribution 15/12/10/8/5 — an association, not proof of cause (codes defined in SEEDING.md) |
| `likelyCause` | `string` | Yes | Qualified, fictional explanation |
| `recommendedAction` | `string` | Yes | Simulated, advisory-only recommendation |
| `evidenceSummary` | `string` | Yes | Fictional supporting evidence |
| `isSimulated` | `true` | Yes | Always true; shown as a label in the UI |
| `createdAt` | `Timestamp` | Yes | **Real**: when the document was written (the seed time). Dataset metadata, never changed by the migration; not shown in the operator UI. Independent of the simulated times: a record written on 23 Oct can describe an incident reported on 27 Oct, and that is not a data issue |
| `_schemaVersion` | `2` | Yes | Schema version (`1` before the Phase 6 migration) |

**Queries:** always `where('ownerUid', '==', uid)` — use `ownIncidentsConstraints(uid)`.

**Schema versions (Phase 6).** Version 2 adds `reportedAt` and re-bases `lastSignalAt` onto the fixed July–October 2026 scenario timeline (see [SEEDING.md → Timeline](SEEDING.md#timeline-schema-v2)). Version 1 (Phases 3–5) had no `reportedAt`, and its `lastSignalAt` was the seed time minus a per-scenario offset, which is why every live incident showed the same 4:33 pm creation time. The app reads both: `parseIncident` marks a version 1 record `legacyTimeline: true`, leaves `reportedAt` null (it is never estimated) and does not count that as a data issue. The queue explains such records, the date filter leaves them out, and report-time sorting lists them last. A version 2 record without a valid `reportedAt` *is* a data issue. Live documents move from version 1 to 2 only through the controlled migration in `frontend/scripts/migrate-incident-timeline/` (see SEEDING.md); no rule or index changes are needed.

## `actionLogs` collection (SafeCall)

**Path:** `/actionLogs/{actionLogId}` (auto ID)
**Access:** verified owner may **read** their own logs and **create** new ones — only for an incident they own that is marked `isSimulated: true`. Update and delete are denied for every client — the history is append-only.

> **Deployment status:** the `isSimulated == true` requirement was added to `firebase/firestore.rules` after CP7 (in the repository, tested on the local emulator). It is **not yet deployed** to the live project, whose rules predate it.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerUid` | `string` | Yes | Must equal the signed-in user's UID |
| `incidentId` | `string` | Yes | ID of an existing incident owned by the same user and marked `isSimulated == true` (checked with `exists()` + `get()`; a missing flag counts as false) |
| `actionType` | `'ACKNOWLEDGE' \| 'ESCALATE' \| 'REVIEWED'` | Yes | The operator's decision |
| `note` | `string` | Yes | Rationale; already trimmed (`note == note.trim()`), 10–500 characters as counted by the rules' `size()` (UTF-16 code units) |
| `createdAt` | `Timestamp` | Yes | Must be `serverTimestamp()` (rules require `== request.time`) |
| `_schemaVersion` | `1` | Yes | Schema version |

No other fields are accepted (`keys().hasOnly(...)`).

**Queries:**
- History: `actionHistoryConstraints(uid, incidentId)` → `ownerUid ==`, `incidentId ==`, `orderBy(createdAt, desc)`. Needs composite index `actionLogs (ownerUid ASC, incidentId ASC, createdAt DESC)` in `firebase/firestore.indexes.json`.
- Review counts: `reviewedActionsConstraints(uid)` → `ownerUid ==`, `actionType == 'REVIEWED'` (equality filters only; served by single-field indexes). An incident is *reviewed* when at least one REVIEWED log exists; everything else awaits completion.

### Decision payload and write path (Phase 5 CP1, CP4)

> **Status:** the payload builder (CP1), the write adapter and the submission hook (CP4) are implemented and tested. Since CP5 the detail page's decision form uses them. The rules, schema and index above are unchanged from Phase 2. Writes have been tested only with mocks and against the local emulator: no action log has been created in the live project, and a live decision save has not been tested or authorised yet. The composite index's live deployment is also unverified. The read hook is described under [Detail reads](#detail-reads-safecall-screen-b-phase-5-cp3).

- `buildActionLogData(ownerUid, incidentId, input)` (`frontend/src/features/incidents/decisions.ts`) validates a decision and returns exactly the six fields above, with `createdAt: serverTimestamp()`. That sentinel is a placeholder the server replaces on write, so building a payload makes no Firestore call. Anything else in `input` is dropped.
- `incidentId` must match `incidentIdSchema`, which uses the rule's own pattern `[A-Za-z0-9_-]{1,128}`; a unit test reads `firestore.rules` to keep the two identical.
- `note` goes through `actionLogInputSchema`, which trims it with `trimNote()` and then checks 10–500 characters. Inner text, including line breaks, is kept. `trimNote()` removes both JavaScript whitespace and every character ≤ U+0020, because the rules' `trim()` also strips control characters that JavaScript keeps (U+0000, U+0001 …). With `.trim()` alone, a note ending in U+0001 would pass the client and be refused by the rules.
- These client checks give early, readable feedback only. The security rules still check every field and decide.
- **Evidence (local emulator only, `demo-safecall`):** `frontend/tests/rules/decisionPayload.rules.test.ts` writes builder payloads for all three action types through the unchanged rules and compares 35 rationale cases (length limits, emoji, combining accents, Unicode whitespace, control characters, multi-line) on both sides. It also confirms that the rules' `size()` counts UTF-16 code units, like `String.length`. Run it with `pnpm run test:rules`; it is not in CI and was not checked against the live project.
- **Write adapter** — `startDecisionWrite(ownerUid, incidentId, input)` (`frontend/src/features/incidents/decisionWriter.ts`) is the incident feature's only Firestore write. It builds the payload with `buildActionLogData`; invalid input returns issues and writes nothing. It then calls `addDoc(getActionLogsCollection(), payload)` through the client SDK, so the rules decide. It never creates, updates or deletes an incident, and nothing else is called, including for ESCALATE. Its `confirmed` promise resolves `ok` only when addDoc's promise resolves, meaning the server has accepted the write. A refusal gives a recognised Firestore code (`toSafeFirestoreError`, `firestoreErrors.ts`) with a message written for the write, never the SDK's text.
- **Submission hook** — `useDecisionSubmission({ uid, incidentId, canRecordDecision })` (`hooks/useDecisionSubmission.ts`):
  - **Statuses:** idle, invalid, ineligible, saving, waiting, saved, failed.
  - **Eligibility:** a write starts only when `canRecordDecision` is true. `useIncidentDetail` sets it only while the incident is server-confirmed `ready`, not when stale or offline.
  - **Duplicate lock:** one unresolved write per user and incident, taken synchronously and kept at module level. It holds across double clicks and remounts, and is released only when the server answers.
  - **Slow writes:** after 10 s the status becomes `waiting`, still locked and never failed, retried or cancelled.
  - **Limit:** the SDK queues writes in memory only, so a write that hasn't reached the server is lost on reload, and so is the lock.
- **Write evidence (local emulator only):** `frontend/tests/rules/decisionWriter.rules.test.ts` runs the real adapter through the unchanged rules. All three action types are stored with exactly the six fields and a server `createdAt`. Another operator's incident and an unverified operator are refused with `permission-denied`. Invalid input writes nothing, and the outcome arrives only after the SDK has shown the write as pending.
- History helpers for the future detail page (`frontend/src/features/incidents/actionHistory.ts`): `parseActionLog` rejects a log whose `ownerUid` or `incidentId` differs from the expected values, so it can't affect another incident. `deriveIncidentReviewStatus` uses the dashboard's meaning: only a REVIEWED entry for that incident counts, and several count once.

## Detail reads (SafeCall Screen B, Phase 5 CP3)

> **Status:** the read-only hook `useIncidentDetail(uid, incidentId)` (`frontend/src/features/incidents/hooks/useIncidentDetail.ts`) is unit-tested with a mocked SDK and, since CP5, drives the detail page (`/dashboard/incidents/[incidentId]`). It never writes; the page's decisions go through the write path above.

- **ID check first:** an ID that doesn't match `INCIDENT_ID_PATTERN` (the rules' `[A-Za-z0-9_-]{1,128}`) gives `invalid-id`, and neither `incidentDoc()` nor the history query is ever built.
- **Two listeners, both with `includeMetadataChanges`:** `incidentDoc(incidentId)`, and `query(getActionLogsCollection(), ...actionHistoryConstraints(uid, incidentId))`. The history query returns all action types newest first and needs the composite index above. The emulator ignores indexes, so whether it is deployed can only be checked on the live project.
- **Incident:** nothing is shown until the server confirms it; a cached result, including a cached absence, is never the answer. Not `isSimulated: true` gives `integrity-error` straight away. Missing, owned by someone else, or `permission-denied` all give `unavailable`. The rules refuse a missing incident and another operator's incident in the same way, and the hook doesn't tell them apart either. In those states the history is withheld.
- **History** has its own status, so the incident can be shown while the history loads or fails. A missing index (`failed-precondition`) gives `index-missing`. Each document goes through `parseActionLog` with both the owner and the incident. Documents with `metadata.hasPendingWrites` are counted in `pendingCount` but never listed, and they move into the history through the metadata-only snapshot that follows server acceptance. `reviewStatus` uses `deriveIncidentReviewStatus`, the dashboard's meaning, and is null until the history is confirmed.
- **Errors:** only a recognised Firestore code and a fixed message are kept (`toListenerError`), never the SDK's text.
- **Logs without `createdAt` (privileged data only):** the history query's `orderBy(createdAt)` makes Firestore leave out any log where the field is **missing**. Any present value is kept, even `null` or a non-timestamp, and is listed with "Time not recorded" (checked on the emulator). The dashboard therefore ignores exactly those logs too (see Dashboard reads), so both screens agree. Clients can't create such a log, because the rules require `createdAt == request.time`. Found in CP7 and fixed afterwards.
- **Offline:** the dashboard's 15-second confirmation timeout gives `offline`. Data confirmed earlier and then served from the cache is `stale`.

## Dashboard reads (SafeCall Screen A, Phase 4)

`/dashboard` (`frontend/src/features/incidents/`) reads in the browser through the client SDK, so the security rules decide what the operator sees. It never writes: it doesn't create incidents and doesn't record operator decisions (Phase 5 adds the action-log form).

- **Exactly two live `onSnapshot` listeners**, both owner-scoped before they start: `query(getIncidentsCollection(), ...ownIncidentsConstraints(uid))` and `query(getActionLogsCollection(), ...reviewedActionsConstraints(uid))`. Only REVIEWED logs are downloaded. Both use equality filters only, so no composite index is expected. The emulator ignores indexes, but on 23 October 2026 both queries ran successfully against the live project. That shows these two queries work there as written; any new or changed query (such as Phase 5's history query) still needs its own index check.
- **Counts:** reviewed = number of *distinct* incident IDs with at least one REVIEWED log that refers to an incident in the operator's queue. ACKNOWLEDGE and ESCALATE never count, repeated REVIEWED logs count once, and logs for other incident IDs are ignored. Awaiting review = total − reviewed (`deriveReviewSummary`).
- **Order and filters (Phase 6):** everything happens in the browser over the operator's own rows (50 for a seeded operator), so there's no `orderBy`, no extra query and no index. The All / Awaiting review / Reviewed tabs filter first (`filterByTab`); then `applyQueueView` (`queueView.ts`) applies search (incident code, device ID, suburb, postcode; case-, whitespace- and punctuation-tolerant, every word must match), pendant connectivity (All / Offline / Silent) and an inclusive report-date range on Melbourne calendar dates, and sorts (newest reported by default; also oldest reported, newest/oldest last signal, incident code, location). Missing values sort last and ties fall back to incident code, then document ID, so every order is deterministic. Filters never change the summary counts or the tab counts; a polite live region says how many rows match. The tab, filters and sort are remembered per operator in memory for the browser tab (no storage), so returning from an incident restores them.
- **Readiness:** counts appear only once *both* listeners have had a server-confirmed snapshot (`includeMetadataChanges`, `fromCache === false`). An empty cached result is never shown as "no incidents". There are five other states. *Loading*: still waiting. *Offline*: not confirmed within 15 s, with Retry. *Stale*: confirmed earlier, now cached, so the data stays with a warning. *Error*: either listener failed, so no counts. *Integrity error*: any incident with `isSimulated !== true` hides the whole queue.
- **Live refresh:** a REVIEWED log created later (Phase 5) arrives through the second listener and the counts update without a reload.
- **Only server-accepted logs count (Phase 5 CP2):** the client SDK puts a locally written document into query results before the server has answered, marked `doc.metadata.hasPendingWrites`. The REVIEWED listener drops those documents (`confirmedReviewEvidence` in `reviewSummary.ts`). The check is per document, so a pending log never hides confirmed ones. It is separate from `snapshot.metadata.fromCache`, which only says whether the query result itself is server-current. When the server accepts the write, `includeMetadataChanges` delivers the same document with the flag cleared, and it counts from then on. A rejected write is removed by the SDK and never counts. A confirmed log with no `createdAt` field is also dropped: the detail page's ordered history query can never return it (see Detail reads). Unit tests cover this, and two local emulator tests check it against real SDK metadata (`frontend/tests/rules/dashboard.rules.test.ts`). The incident listener needs no such filter, because clients never write incidents.
- **Zero incidents:** a verified operator with no incidents gets a server-confirmed empty result: 0 / 0 / 0 and an "ask the administrator" empty state, with no create control.
- **Live data:** at the 23 October 2026 milestone, the live project held the 50 fictional incidents for the designated demo operator, and the real dashboard was observed showing them as 50 / 50 / 0 ([SEEDING.md → Live demo data](SEEDING.md#live-demo-data-23-october-2026)). That is a dated observation, not a guarantee: the counts change once decisions are recorded (Phase 5). Any other operator has no incidents and gets the zero-incident state above.
- Each row links to `/dashboard/incidents/{encodeURIComponent(id)}` (the Phase 5 detail page) with `prefetch={false}`.
