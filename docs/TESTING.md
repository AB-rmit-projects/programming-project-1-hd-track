# Testing

## Test Layers

| Layer | Command | Tool | Firebase | Description |
|-------|---------|------|----------|-------------|
| Frontend unit | `pnpm run test:component` | Vitest + Testing Library | Mocked | Utils, hooks, components |
| Backend unit | `pnpm run test` | Vitest + supertest | Mocked | Route handlers, middleware |
| Security rules | `pnpm run test:rules` | Vitest + `@firebase/rules-unit-testing` | Local Firestore emulator (`demo-safecall`) | `firebase/firestore.rules`, query shapes, SDK round trips |
| All | `pnpm run test:all` | — | — | Runs all layers |

Unit tests mock Firebase and never make network calls. The **security-rules tests** are the one exception: they run against a local Firestore emulator under a `demo-` project ID, which can never reach a real Firebase project. The app itself never uses the emulator — it always talks to your real project.

## Running Tests

```bash
# Run all tests
pnpm run test:all

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
- Use `assertSucceeds` / `assertFails` around the same modular SDK calls the app makes, and reuse the app's query constraints (`ownIncidentsConstraints`, `actionHistoryConstraints`, `reviewedActionsConstraints`) so the tested query is the shipped query.
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
