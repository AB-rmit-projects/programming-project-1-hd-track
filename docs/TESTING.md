# Testing

## Test Layers

| Layer | Command | Tool | Firebase | Description |
|-------|---------|------|----------|-------------|
| Frontend unit | `pnpm run test:component` | Vitest + Testing Library | Mocked | Utils, hooks, components |
| Backend unit | `pnpm run test` | Vitest + supertest | Mocked | Route handlers, middleware |
| Security rules | `pnpm run test:rules` | Vitest + `@firebase/rules-unit-testing` | Local Firestore emulator (`demo-safecall`) | `firebase/firestore.rules`, query shapes, SDK round trips — **run separately; local-only, not yet in GitHub CI** |
| All unit | `pnpm run test:all` | — | Mocked | Backend + frontend unit/component tests only — does **not** run `test:rules` |

Unit tests mock Firebase and never make network calls. The **security-rules tests** are the one exception: they are configured to run against the local Firestore emulator (started by `firebase emulators:exec`) using the demo project ID `demo-safecall`. For `demo-` project IDs the Firebase CLI uses a demo configuration, and requests to services that are not emulated fail instead of going to a real project. The app itself does not use the emulator — it talks to your real project.

## Running Tests

```bash
# Run all unit/component tests (backend + frontend) — mocked Firebase
pnpm run test:all

# Firestore security-rules tests — separate command, local emulator, Java 21+
pnpm run test:rules

# Watch mode (frontend)
pnpm --filter frontend run test:watch

# Watch mode (backend)
pnpm --filter backend run test:watch

# Coverage
pnpm --filter frontend run test:coverage
pnpm --filter backend run test:coverage
```

## What to Test

### Frontend

- **Always test:** utility functions in `src/lib/`, Zod validation schemas, custom hooks
- **Skip:** shadcn `src/components/ui/` components (not hand-authored)
- **Skip:** `src/app/` page files (test via integration or E2E)
- Firebase is always mocked via `tests/setup.ts` — never call real Firebase in unit tests
- SafeCall dashboard (`tests/unit/features/incidents/`): `incidentRow` and `reviewSummary` test the parsing and counting with the Phase 3 fixtures (50 / 50 / 0, 50 / 49 / 1). `useIncidentDashboard` mocks `firebase/firestore` and `@/lib/firebase/client` itself (the setup mock is too thin for it) and covers readiness, offline/stale, errors, integrity, owner isolation and listener/timer cleanup. `IncidentDashboard` mocks `useAuth` and the hook and covers every UI state, the tabs and keyboard, and the links

### Backend

- **Unit tests:** Each route handler tested with supertest; Firebase Admin is mocked
- Every new route created via `/add-route` skill must have at minimum: 200/201 happy path + 401 without token

## Security rules tests

```bash
pnpm run test:rules   # needs Java 21+; starts the Firestore emulator, runs, stops it
```

- Lives in `frontend/tests/rules/*.rules.test.ts` (config: `frontend/vitest.rules.config.ts`); excluded from `pnpm run test:component`.
- `firebase-tools` is run via `pnpm dlx` at a pinned version, so it isn't in the lockfile.
- Each test seeds data with `withSecurityRulesDisabled` and calls `clearFirestore()` between tests.
- `seed-incidents.rules.test.ts` exercises the Phase 3 seed script against the real emulator with the Admin SDK (real `getAll()`/`create()`, ALREADY_EXISTS and stored Timestamps), reads the seeded data back through the rules with the client SDK, and runs the real CLI process end to end. The seed script's pure logic is unit-tested in `frontend/tests/unit/scripts/seed-incidents/` (part of `pnpm run test:component`). See [SEEDING.md](SEEDING.md).
- `dashboard.rules.test.ts` seeds 50 incidents with the real Phase 3 seed runner, runs the dashboard's two queries as a verified operator, and checks the real parsing and counting. It covers 50 / 50 / 0, then 50 / 49 / 1 after a REVIEWED log created through the rules, with ACKNOWLEDGE/ESCALATE and duplicates. It also checks that another operator's data is never returned, that anonymous and unverified operators are denied, the zero-incident case, the `isSimulated` rejection, and a live `onSnapshot` update. It does not run the React hook itself. Passing locally does **not** show that these rules are deployed to a real project.
- Use `assertSucceeds` / `assertFails` around the same modular SDK calls the app makes, and reuse the app's query constraints (`ownIncidentsConstraints`, `actionHistoryConstraints`, `reviewedActionsConstraints`) so the tested query is the shipped query.
- **Local-only for now:** GitHub CI (`ci.yml`) does not run these tests yet — run `pnpm run test:rules` yourself before pushing rules or query changes. Adding a CI job (Java 21 + `pnpm run test:rules`) is planned for Phase 7, because it requires a workflow change.
- `pnpm run test:all` does **not** include these tests.
- The emulator does **not** enforce composite indexes — `tests/unit/lib/firebase/indexes.test.ts` guards the index definitions instead; real index coverage is only proven against production after `firestore:indexes` is deployed.

## Mocking Firebase

**Frontend** (`frontend/tests/setup.ts`):
```typescript
vi.mock('@/lib/firebase/client', () => ({ auth: ..., db: {} }))
vi.mock('@/lib/firebase/admin', () => ({ adminAuth: { verifySessionCookie: vi.fn() }, ... }))
```

**Backend** (`backend/tests/setup.ts`) mocks `src/lib/firebase` so the Admin SDK never initializes, and exports reusable auth mocks. Auth is injected per-app, not patched globally:

```typescript
import { createApp } from '../../../src/app'
import { mockVerifyToken, mockUser } from '../../setup'

const app = createApp({ verifyToken: mockVerifyToken })

// Authenticated request:
vi.mocked(mockVerifyToken).mockResolvedValue(mockUser)

// Unauthenticated request:
vi.mocked(mockVerifyToken).mockRejectedValue(new Error('invalid'))
```
