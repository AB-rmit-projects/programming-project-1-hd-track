# Incident Seeding (SafeCall)

The SafeCall dashboard reads 50 fictional incidents per demo operator from the `incidents` collection. Operators can never create incidents (rules deny every client write), so an administrator populates them with a terminal-only seed script that uses the Firebase Admin SDK.

> **Status**
> - **Implemented:** the seed script (`frontend/scripts/seed-incidents/`) is implemented and verified against the **local Firestore emulator** only.
> - **Not done:** **no real Firebase project has been populated.** The script refuses to run against anything except the local emulator. Production seeding is a separate step that needs separate approval and a deliberate code change (see [Production access](#production-access)).

---

## The dataset

`frontend/scripts/seed-incidents/scenarios.ts` (data) and `dataset.ts` (builder) define **exactly 50 deterministic incidents** for one owner UID:

| Property | Value |
|---|---|
| Document ID | `{ownerUid}_{incidentCode}`, e.g. `abc123_INC-001` |
| Incident codes | `INC-001` … `INC-050` |
| Device IDs | 50 unique fictional pendant IDs, `SC-####` (the same 50 for every demo owner) |
| Locations | 50 real Victorian suburbs with their correct postcodes, `state: 'VIC'`. The incidents themselves are fictional. |
| `lastSignalAt` | seed time minus a fixed per-incident offset, 10 minutes to 72 hours overall. For `OFFLINE` it is when the heartbeat stopped, and the long gaps (up to 72 hours) are all `OFFLINE`. For `SILENT` it is the most recent heartbeat, always 60 minutes old or less (see below). |
| `createdAt` | seed time |
| `isSimulated` / `_schemaVersion` | always `true` / `1` |

All 15 `Incident` fields are always present (`frontend/src/types/firestore.ts`). Because the builder is type-checked against that interface, schema drift fails `pnpm run typecheck`. The same owner UID and clock always produce the same records.

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

**SILENT heartbeat age:** every `SILENT` incident's `lastSignalAt` (its most recent heartbeat) is at most **60 minutes** before seed time (`SILENT_MAX_HEARTBEAT_AGE_MINUTES` in `scenarios.ts`). This threshold is a **demonstration assumption for this fictional dataset, not a verified SafeCall operational threshold.** Ages are fixed relative to seed time, so they grow older as time passes after seeding.

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

Seeding a real project for the live demo needs, as separate steps with separate approval:
- a reviewed change that adds an explicit production path (credential handling, project confirmation, owner-UID verification)
- the operator's real Auth UID
- a dry run against that project, then the write

Until then, the dashboard's unseeded-account empty state is what a real project shows.

---

## Tests

| Suite | Command | Covers |
|---|---|---|
| `frontend/tests/unit/scripts/seed-incidents/dataset.test.ts` | `pnpm run test:component` | 50 records, IDs, distribution, 15-field schema, status/evidence consistency, wording guards |
| `frontend/tests/unit/scripts/seed-incidents/options.test.ts` | `pnpm run test:component` | Every argument and safety refusal, the emulator identity probe, refusal ordering in the CLI |
| `frontend/tests/unit/scripts/seed-incidents/seed.test.ts` | `pnpm run test:component` | Preflight, create-only writes, conflicts, ALREADY_EXISTS paths, failures, exit codes (in-memory fake store) |
| `frontend/tests/rules/seed-incidents.rules.test.ts` | `pnpm run test:rules` | Real emulator: 50 created with real Timestamps, repeat and partial runs, conflicts, a real ALREADY_EXISTS, dry runs, action logs untouched, failure isolation, owner-only reads through the rules, action-log creation, and the real CLI process end to end |
