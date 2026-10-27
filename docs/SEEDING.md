# Incident Seeding (SafeCall)

The SafeCall dashboard reads 50 fictional incidents per demo operator from the `incidents` collection. Operators can never create incidents (rules deny every client write), so an administrator populates them with a terminal-only seed script that uses the Firebase Admin SDK.

> **Status**
> - **Implemented:** the seed script (`frontend/scripts/seed-incidents/`) is implemented and verified against the **local Firestore emulator** only. It remains emulator-only and must never target live Firestore.
> - **Live demo data (23 October 2026):** the live project was populated once, separately, by a controlled one-off tool outside this repository — **not** by this script. See [Live demo data](#live-demo-data-23-october-2026).

---

## The dataset

`frontend/scripts/seed-incidents/scenarios.ts` (data) and `dataset.ts` (builder) define **exactly 50 deterministic incidents** for one owner UID:

| Property | Value |
|---|---|
| Document ID | `{ownerUid}_{incidentCode}`, e.g. `abc123_INC-001` |
| Incident codes | `INC-001` … `INC-050` |
| Device IDs | 50 unique fictional pendant IDs, `SC-####` (the same 50 for every demo owner) |
| Locations | 50 real Victorian suburbs with their correct postcodes, `state: 'VIC'`. The incidents themselves are fictional. |
| `reportedAt` | **simulated**, fixed per scenario: when the fictional monitoring platform raised the incident, 1 Jul – 27 Oct 2026 Melbourne time (see Timeline) |
| `lastSignalAt` | **simulated**, fixed per scenario: the last heartbeat before `reportedAt`. For `OFFLINE` it is when the heartbeat stopped; for `SILENT` it is the most recent heartbeat, always 60 minutes or less before the report (see below) |
| `createdAt` | **real**: the seed time (when the documents are written). Independent of the simulated times: it can be earlier or later than `reportedAt` |
| `isSimulated` / `_schemaVersion` | always `true` / `2` |

All 16 `Incident` fields are always present (`frontend/src/types/firestore.ts`). Because the builder is type-checked against that interface, schema drift fails `pnpm run typecheck`. The simulated times never depend on the clock; only `createdAt` does. `buildSeedIncidents(ownerUid, createdAt)` is pure and does not compare the two: a fixture written on 23 October can describe an incident reported on 27 October. The "nothing in the future" rule is checked against the **real clock** by `assertTimelineInPast(now)`, which the seed CLI and the timeline migration call before doing anything. It refuses while the current time is before the latest report time (`LATEST_REPORTED_AT`, 27 Oct 2026 8:36:17 am AEDT).

### Timeline (schema v2)

The incidents are **historical, fictional scenarios**, not live alerts. Each scenario in `scenarios.ts` carries two Melbourne wall-clock times, `lastSignal` and `reported`, converted to instants by `melbourneLocalToUtc` (`frontend/src/lib/melbourneTime.ts`). That uses the runtime's time-zone database and refuses the hour skipped when daylight saving starts (and the repeated hour when it ends).

- **12 incidents in July, 12 in August, 12 in September and 14 in October** (1 Jul – 27 Oct 2026). The first is INC-007 (Mildura), reported Wed 1 Jul at 7:22 am AEST; the last is INC-049 (Ocean Grove), reported Tue 27 Oct at 8:36 am AEDT. Both are fixed times, never derived from the clock.
- **Reported at all hours:** 12 between midnight and 6 am, 15 in the morning, 15 in the afternoon, 8 in the evening, with 50 different clock times and non-zero seconds. Nothing repeats the old 4:33 pm seed time.
- **Busy days and quiet spells**, not an even spacing: for example, two western-district outages on 22 Jul (Stawell, Hamilton), maintenance on consecutive nights (7–8 Jul, 4–5 Aug), six incidents in 13–18 Oct, and several five-day spells with no report. Every month mixes at least four cause categories and both connectivity states.
- **Gaps fit the evidence:** maintenance losses fall in overnight windows (last signal before 4 am, reported within 90 minutes); battery losses build up over 6–20 hours (reported the next morning or day); SILENT heartbeats are 10–60 minutes before the report; outages are reported between 15 minutes and a few hours after the loss. No fixed offset or round-number pattern remains.
- **Fictional advisory periods** group the hazard incidents in seasons that suit them: a winter coastal storm 14–15 Jul (Lorne, Lakes Entrance), a late-winter Murray flood 20–24 Aug (Echuca, Kerang, Cobram) and early-season bushfires 13–18 Oct (Bright, Orbost, Healesville). They give the date-range filter meaningful groups.
- **Daylight saving:** INC-036 (Daylesford) loses its signal at 1:47 am AEST and is reported at 3:09 am AEDT on Sun 4 Oct, only 22 minutes later.
- **Incident codes are dataset references, not chronological.** The scenario text, IDs, devices and locations are unchanged from version 1, so the live migration only has to change the timeline fields.
- **History:** Phase 6 used 1 Sep – 20 Oct (25 + 25). CP10C, before any live migration, widened it to July–October: 22 incidents kept their exact Phase 6 times, 24 moved to July or August with the same time of day and gap, and 4 moved to 21–27 Oct (INC-049 also to a morning time, and INC-048 to an evening one, so every part of the day stays represented).

### Cause categories (15 / 12 / 10 / 8 / 5)

A category labels a **simulated assessment or evidence association, never a confirmed root cause**.

| Code | Count | Meaning |
|---|---|---|
| `UNPLANNED_OUTAGE` | 15 | Signal loss consistent with an unplanned network outage in the area; no scheduled maintenance is listed |
| `DEVICE_SIDE` | 12 | A problem with the pendant itself (6 depleted battery, 6 fault or missed self-test) while nearby simulated network telemetry is normal |
| `PLANNED_MAINTENANCE` | 10 | Signal loss falls inside a simulated scheduled maintenance window |
| `EXTERNAL_HAZARD` | 8 | Signal loss or a missed check-in coincides with a simulated storm, flood or bushfire advisory. This is an association only, not proof of cause. |
| `INSUFFICIENT_EVIDENCE` | 5 | Simulated signals are missing or conflict, so no likely cause is suggested |

### Status semantics

| Status | Meaning | Used by |
|---|---|---|
| `OFFLINE` (36) | No network heartbeat from the pendant since its last recorded signal | outage, maintenance, battery, most hazard cases |
| `SILENT` (14) | The pendant still sends a heartbeat (possibly intermittent), but an expected check-in or self-test was missed | device fault, some hazard cases, all insufficient-evidence cases |

**SILENT heartbeat age:** every `SILENT` incident's `lastSignalAt` (its most recent heartbeat) is at most **60 minutes** before its `reportedAt` (`SILENT_MAX_HEARTBEAT_AGE_MINUTES` in `scenarios.ts`). This threshold is a **demonstration assumption for this fictional dataset, not a verified SafeCall operational threshold.** Because both times are historical, the gap never changes after seeding.

Status, cause, evidence and recommended action all come from one *scenario kind* (category + status), so they cannot contradict each other:

| Kind | Category | Status | Count |
|---|---|---|---|
| Outage | `UNPLANNED_OUTAGE` | `OFFLINE` | 15 |
| Maintenance | `PLANNED_MAINTENANCE` | `OFFLINE` | 10 |
| Battery | `DEVICE_SIDE` | `OFFLINE` | 6 |
| Device fault | `DEVICE_SIDE` | `SILENT` | 6 |
| Hazard (no heartbeat) | `EXTERNAL_HAZARD` | `OFFLINE` | 5 |
| Hazard (missed check-in) | `EXTERNAL_HAZARD` | `SILENT` | 3 |
| Inconclusive | `INSUFFICIENT_EVIDENCE` | `SILENT` | 5 |

### Simulated evidence and recommended actions

- `likelyCause` starts with **"Simulated assessment:"** and uses hedged wording ("consistent with", "may be associated with").
- `evidenceSummary` starts with **"Simulated evidence:"**, names the incident's suburb, and ends with **"Fictional data — not a live feed."**
- Supporting telemetry is unquantified: there are no claims about specific numbers of other devices.
- `recommendedAction` is advisory only. It never says anything was dispatched, and escalation is only ever "consider escalation". This matches the app, where recording ESCALATE records intent and nothing more.
- No real carrier, energy company, emergency agency, weather event or person is named.

These rules are enforced by `frontend/tests/unit/scripts/seed-incidents/dataset.test.ts`.

---

## Running the seed (local emulator)

Needs Java 21+. The emulator keeps its data in memory, so stopping it discards everything.

```bash
# Terminal 1 — start the Firestore emulator (demo project, never production)
pnpm dlx firebase-tools@15.34.0 emulators:start --only firestore --project demo-safecall

# Terminal 2 — dry run (default): reads only, reports what would be created
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm seed:incidents --project demo-safecall --owner-uid demo-operator-01

# Create the incidents
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm seed:incidents --project demo-safecall --owner-uid demo-operator-01 --write

# Re-run check: running the same command again creates 0 and skips 50
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm seed:incidents --project demo-safecall --owner-uid demo-operator-01 --write
```

| Option | Meaning |
|---|---|
| `--project <id>` | Required. Must be a `demo-…` project ID |
| `--owner-uid <uid>` | Required. Owner of all 50 incidents; 1–120 characters of `A–Z a–z 0–9 _ -` (keeps `{uid}_INC-NNN` within the rules' incidentId pattern) |
| `--write` | Actually create documents. **Without it the run is a read-only dry run.** |
| `--json` | Print the report as JSON |

Unknown, repeated or positional arguments are rejected. Node prints a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning because the script runs under Node's built-in TypeScript stripping.

### Safety checks (all before Firebase Admin is loaded)

The script refuses to run (exit code `2`, nothing contacted) unless every check passes:

1. It is not running inside a Next.js runtime (`NEXT_RUNTIME` unset). The script lives outside `frontend/src/` and has no route, Server Action or UI.
2. The arguments are valid, and `--allow-production` / `--confirm-project` are absent (both are refused).
3. `--project` is a valid `demo-` project ID.
4. Neither `GOOGLE_APPLICATION_CREDENTIALS` nor `FIREBASE_SERVICE_ACCOUNT_KEY_BASE64` is set. The script never loads credentials.
5. `FIRESTORE_EMULATOR_HOST` is set, is exactly `127.0.0.1`, `localhost` or `[::1]` followed by `:port`, and the port equals `emulators.firestore.port` in `firebase.json` (8080).
6. **Emulator identity probe:** `GET /emulator/v1/projects/{project}:ruleCoverage` must return `200`, `application/json`, and a Firestore rule-coverage report (`rules.files[]` declaring `service cloud.firestore`, plus a `report` array). Any other HTTP server is refused, and redirects are refused.

Only then does the script start a named Admin app with a project ID and **no credential**. Just before doing so it re-checks that `process.env.FIRESTORE_EMULATOR_HOST` still holds the validated address.

---

## Idempotency, conflicts and exit codes

The script uses only `getAll()`, `get()` and `create()` on the `incidents` collection. It never calls `set`, `update` or `delete`, never uses batches or transactions, and never touches `actionLogs`.

1. **Preflight:** a single `getAll()` read of the 50 document IDs.
2. Each existing document is compared on its **identity fields**: `ownerUid`, `incidentCode`, `deviceId`, `isSimulated` and `_schemaVersion`, using strict equality.
   - All match → **skipped** (left untouched). Differences in descriptive fields such as `likelyCause` do not matter and are never rewritten.
   - Any identity field differs, is missing or has the wrong type → **conflict**. The document is left untouched and reported with the mismatched fields.
3. **Dry run** stops here and reports `would create` / `skipped` / `conflicts`.
4. **Write:** a `create()` call for each missing record, one at a time.
   - Success → **created**.
   - `ALREADY_EXISTS` (another writer got there after the preflight) → re-read the document and apply the same identity check (skipped or conflict). If the re-read fails, the record is **failed**.
   - Any other error → **failed**. The remaining records still run.

| Exit code | Meaning |
|---|---|
| `0` | `COMPLETE`: every record was created or skipped |
| `1` | `INCOMPLETE`: at least one conflict or failure (including a dry run that finds a conflict) |
| `2` | Refused: invalid arguments or a failed safety check; nothing was contacted |

Re-running is always safe. A partially populated dataset is completed without touching the records already there.

---

## Production access

Production seeding is **disabled in code**. The `FIRESTORE_EMULATOR_HOST` requirement, the `demo-` project rule, the credential-variable refusal and the production-flag refusal together mean the script cannot read or write a real Firebase project, even in dry-run mode.

This script is not a production tool. Do not point it at live Firestore; enabling that would need a separately reviewed and approved change.

### Live demo data (23 October 2026)

The live demo data was created without changing this script:

- The project owner deployed the tested `firebase/firestore.rules` to `programming-project-1-hd-track`.
- A separately controlled one-off administrative tool, kept outside this repository, created exactly **50** fictional records (`isSimulated: true`) from this dataset for the designated demo operator. It ran a dry run first, created documents only (never updating or deleting), was pinned to that project and operator, and needed separate approval for each live step. Its source, credentials and reports are not part of the repository.
- A read-only verification then confirmed exactly the expected 50 records, the owner identity, no action logs for that operator, and dashboard counts of 50 total / 50 awaiting / 0 reviewed. The real Next.js `/dashboard` was observed rendering the 50 records.
- The temporary service-account key, service account and custom IAM role were then removed.

This records a dated verification milestone, not the current contents of the database: the counts change once operators record decisions (Phase 5). Operators without incidents still see the dashboard's zero-incident empty state. Re-seeding or cleaning up the live data would need a new, separately approved procedure.

Those 50 live documents are **version 1** (seed time 2026-10-23T05:33:44Z). The app reads them safely until they are migrated (see FIRESTORE-SCHEMA.md → Schema versions).

### Timeline migration, version 1 → 2 (not yet run live)

`frontend/scripts/migrate-incident-timeline/` converts the existing documents in place. It never recreates, deletes or re-owns anything, and never touches action logs.

- `legacy.ts` rebuilds the exact version 1 documents from the owner UID and the original seed time (the 50 version 1 signal offsets are pinned). Offline, this reconstruction reproduces the SHA-256 payload fingerprint recorded for the live write on 23 October (`7d4232…`), so "untouched version 1" is defined byte for byte. Version 1 depends only on the seed time and those offsets, never on the scenario timeline, so changing the timeline cannot change it (`plan.test.ts` pins its canonical digest).
- `plan.ts` (pure) classifies each of the 50 allowlisted IDs as untouched v1, already v2, missing or conflicting, using strict, type-tagged comparison (timestamps to the nanosecond, no coercion). It **stops** on any missing or altered document, on any incident the owner has outside the allowlist, or on a read document that is not allowlisted. Otherwise it plans one update per v1 document that sets exactly `reportedAt`, `lastSignalAt` and `_schemaVersion: 2`, preconditioned on that document's last update time. `createdAt` and every other field are left as they are. The plan's SHA-256 digest also covers the owner's action-log IDs.
- `migrate.ts` checks the target's real `currentTime` with `assertTimelineInPast` (no plan while any report time is still in the future), then runs the steps: `dryRun` (read-only, returns the plan and a canonical backup snapshot of the 50 documents with their update times) → `write` (re-plans from fresh reads and refuses unless the digest equals the approved dry run's; then commits **one atomic batch**, so a concurrent change fails the whole batch and writes nothing; then re-reads and verifies all 50 are exactly v2, the owner still has exactly those incidents and the action-log IDs are unchanged) → `rollback` (the inverse, for documents exactly in their v2 form: restore the v1 `lastSignalAt`, remove `reportedAt`, set version 1). A second run is a no-op (`NOTHING_TO_DO`).
- The Admin adapter uses only `getAll`, two owner-scoped ID-only queries (`select()`) and one batch of `update()` calls. Nothing in the repository chooses a project or loads a credential.

**Rehearsed on the emulator only** (`frontend/tests/rules/incidentTimelineMigration.rules.test.ts`): dry run, write, verification, idempotency, a write refused after a concurrent change, the batch precondition blocking a raced write atomically, a tampered document, an extra incident, rollback to the exact v1 documents, reading the migrated documents through the rules, and a decision still saving afterwards. Decoy incidents and action logs belonging to another operator are proved unchanged.

**A live run needs separate approvals:** a temporary credential limited to Firestore document get/list/update (no create or delete), revoked afterwards; a live dry run; review of the plan digest and backup; then the write.

**After the July–October change (CP10C):** the version 1 documents and their fingerprint are unchanged, but the version 2 targets of 28 incidents change, so the plan digest from the 27 October dry run (Sep–Oct timeline) no longer applies and must not be used. The out-of-repository runner pins the SHA-256 of the migration and dataset files and builds its `MigrationTarget` itself, so before a new live dry run it needs: the new file hashes from the merged commit, and `currentTime: new Date()` in its target. The earlier dry-run backup is kept unchanged as historical evidence. A new dry run, backup and digest, each separately approved, come before any write.

---

## Tests

| Suite | Command | Covers |
|---|---|---|
| `frontend/tests/unit/scripts/seed-incidents/dataset.test.ts` | `pnpm run test:component` | 50 records, IDs, distribution, 16-field schema, timeline invariants (12/12/12/14 months, 1 Jul and 27 Oct ends, kinds mixed per month, busy days and quiet spells, spread of times, SILENT and maintenance gaps, advisory periods, DST), `createdAt` independent of the simulated times, the real-clock future check, status/evidence consistency, wording guards |
| `frontend/tests/unit/scripts/seed-incidents/options.test.ts` | `pnpm run test:component` | Every argument and safety refusal, the emulator identity probe, refusal ordering in the CLI |
| `frontend/tests/unit/scripts/seed-incidents/seed.test.ts` | `pnpm run test:component` | Preflight, create-only writes, conflicts, ALREADY_EXISTS paths, failures, exit codes (in-memory fake store) |
| `frontend/tests/rules/seed-incidents.rules.test.ts` | `pnpm run test:rules` | Real emulator: 50 created with real Timestamps, repeat and partial runs, conflicts, a real ALREADY_EXISTS, dry runs, action logs untouched, failure isolation, owner-only reads through the rules, action-log creation, and the real CLI process end to end |
| `frontend/tests/unit/lib/melbourneTime.test.ts` | `pnpm run test:component` | Melbourne local ↔ UTC conversion, every minute of the daylight-saving start day, ambiguous and impossible times, Melbourne calendar dates, display format |
| `frontend/tests/unit/scripts/migrate-incident-timeline/plan.test.ts` | `pnpm run test:component` | v1 reconstruction (canonical digest pinned), reports later than `createdAt`, the real-clock check, strict comparison, PROCEED / NOTHING_TO_DO / STOP cases, digest sensitivity, rollback and verification |
| `frontend/tests/rules/incidentTimelineMigration.rules.test.ts` | `pnpm run test:rules` | The migration rehearsal on the real emulator (see Timeline migration) |
