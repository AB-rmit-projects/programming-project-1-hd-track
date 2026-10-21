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

> **Status:** the schema, rules and types below are implemented (Phase 2). The administrator seed script is implemented (Phase 3) and verified against the local Firestore emulator only — see [SEEDING.md](SEEDING.md). **No real Firebase project has been populated with incidents yet**; production seeding is a separate, approved step.

**Path:** `/incidents/{incidentId}` — seed IDs are deterministic: `{ownerUid}_{incidentCode}` (e.g. `abc123_INC-001`)
**Access:** verified owner may **read** only. All client creates/updates/deletes are denied — incidents are written only by the administrator seed script via the Admin SDK (which bypasses rules).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerUid` | `string` | Yes | Firebase Auth UID of the demo operator who owns the incident |
| `incidentCode` | `string` | Yes | Stable human label; the seed script uses `INC-001` … `INC-050` |
| `deviceId` | `string` | Yes | Unique fictional SafeCall pendant ID |
| `status` | `'OFFLINE' \| 'SILENT'` | Yes | Simulated connectivity state: `OFFLINE` = no heartbeat; `SILENT` = heartbeat but a missed check-in (see SEEDING.md) |
| `suburb` / `state` / `postcode` | `string` / `'VIC'` / `string` | Yes | Real Victorian suburb and postcode for a fictional incident; postcode stored as a string |
| `lastSignalAt` | `Timestamp` | Yes | Simulated last contact (not a live feed) |
| `causeCategory` | `'UNPLANNED_OUTAGE' \| 'DEVICE_SIDE' \| 'PLANNED_MAINTENANCE' \| 'EXTERNAL_HAZARD' \| 'INSUFFICIENT_EVIDENCE'` | Yes | Scenario label; seed distribution 15/12/10/8/5 — an association, not proof of cause (codes defined in SEEDING.md) |
| `likelyCause` | `string` | Yes | Qualified, fictional explanation |
| `recommendedAction` | `string` | Yes | Simulated, advisory-only recommendation |
| `evidenceSummary` | `string` | Yes | Fictional supporting evidence |
| `isSimulated` | `true` | Yes | Always true; shown as a label in the UI |
| `createdAt` | `Timestamp` | Yes | Seed time |
| `_schemaVersion` | `1` | Yes | Schema version |

**Queries:** always `where('ownerUid', '==', uid)` — use `ownIncidentsConstraints(uid)`.

## `actionLogs` collection (SafeCall)

**Path:** `/actionLogs/{actionLogId}` (auto ID)
**Access:** verified owner may **read** their own logs and **create** new ones. Update and delete are denied for every client — the history is append-only.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ownerUid` | `string` | Yes | Must equal the signed-in user's UID |
| `incidentId` | `string` | Yes | ID of an existing incident owned by the same user (checked with `exists()` + `get()`) |
| `actionType` | `'ACKNOWLEDGE' \| 'ESCALATE' \| 'REVIEWED'` | Yes | The operator's decision |
| `note` | `string` | Yes | Rationale; already trimmed, 10–500 characters |
| `createdAt` | `Timestamp` | Yes | Must be `serverTimestamp()` (rules require `== request.time`) |
| `_schemaVersion` | `1` | Yes | Schema version |

No other fields are accepted (`keys().hasOnly(...)`).

**Queries:**
- History: `actionHistoryConstraints(uid, incidentId)` → `ownerUid ==`, `incidentId ==`, `orderBy(createdAt, desc)`. Needs composite index `actionLogs (ownerUid ASC, incidentId ASC, createdAt DESC)` in `firebase/firestore.indexes.json`.
- Review counts: `reviewedActionsConstraints(uid)` → `ownerUid ==`, `actionType == 'REVIEWED'` (equality filters only; served by single-field indexes). An incident is *reviewed* when at least one REVIEWED log exists; everything else awaits completion.
