# Phase 6 verification — timeline, queue search/filters and UI polish

Branch `feature/safecall-phase6-ui-timeline` from `main` @ `5d04a3b` (27 October 2026). Live Firebase was **not** read or changed for this phase: no incident was migrated and no decision was recorded.

## What changed

| Area | Change |
|---|---|
| **6A — data model** | Incident schema **version 2**: new simulated `reportedAt`; `lastSignalAt` re-based onto a fixed 1 Sep – 20 Oct 2026 timeline; `createdAt` stays the real document-creation time. Version 1 records still load (`legacyTimeline`, no invented report time). See [FIRESTORE-SCHEMA.md](FIRESTORE-SCHEMA.md#incidents-collection-safecall) and [SEEDING.md → Timeline](SEEDING.md#timeline-schema-v2-phase-6). |
| **Time display** | `frontend/src/lib/melbourneTime.ts`: every time is shown in Australia/Melbourne time with AEST/AEDT, whatever the viewer's or server's time zone. Decision-history times use it too. |
| **6B — queue** | Search (code, device, suburb, postcode), pendant connectivity filter, inclusive report-date range (Melbourne dates), six sort orders with deterministic tie-breaks, Clear filters, "N of M match" live region, zero-results state. All client-side over the existing owner-scoped listener — no new query, rule or index. Review counts unchanged. |
| **6C — UI/UX** | Whole-row/card click target with a visible "Review ›" cue (still one named link per incident); table from xl, two-up cards below; tabs fit a 320 px phone; mobile navigation row; breadcrumb + bottom back link on the detail page; "Pendant offline / silent" wording and legend, separate from app-connection messages; real `createdAt` moved to a secondary "Dataset record" box; empty Settings page and template copy removed; SafeCall branding (mark, metadata, landing page, auth pages). |
| **Migration (local only)** | `frontend/scripts/migrate-incident-timeline/`: exact v1 reconstruction, pure planner (allowlist, strict comparison, digest), atomic preconditioned batch, verification, rollback. Rehearsed on the emulator only. |

## Automated results (27 October 2026)

| Check | Command | Result |
|---|---|---|
| Placeholders | `pnpm run validate` | pass |
| Typecheck | `pnpm run typecheck` | pass (backend + frontend) |
| Lint | `pnpm run lint` | pass, 0 problems |
| Formatting | Prettier `--check` on every changed file | pass (two files that were already unformatted on `main` and only partly edited were left as they were) |
| Backend unit | `pnpm run test` | 23 / 23 |
| Frontend unit + component | `pnpm run test:component` | **961 / 961** (838 before Phase 6) |
| Firestore rules + emulator | `pnpm run test:rules` | **231 / 231** (222 before; +9 migration rehearsal) |
| Production build | `pnpm --filter frontend build` (no server key) | pass — 8 routes, `/settings` gone |
| Dependency audit | `pnpm audit --audit-level=high` | 0 high / critical (3 moderate, unchanged lockfile) |
| Case-insensitive filename collisions | `git ls-files … \| uniq -d` | none |

New or extended tests: `tests/unit/lib/melbourneTime.test.ts` (every minute of 4 Oct 2026, ambiguous April times), `tests/unit/features/incidents/queueView.test.ts`, the timeline block of `dataset.test.ts`, v1/v2 cases in `incidentRow.test.ts` / `incidentDetail.test.ts`, Phase 6 blocks in `IncidentDashboard.test.tsx` (search, connectivity, date groups, combined filters, inverted range, sorts, remembered view, legacy records) and `IncidentDetailUI.test.tsx` (breadcrumb, DST display, legacy record), navigation tests in `Navbar.test.tsx`, `tests/unit/scripts/migrate-incident-timeline/plan.test.ts`, `tests/rules/incidentTimelineMigration.rules.test.ts`.

## Dataset evidence

- 25 incidents in September, 25 in October; reported 12 × 00–06, 15 × 06–12, 15 × 12–18, 8 × 18–24; 50 distinct clock times; no 4:33 pm.
- Examples: INC-007 reported Tue 1 Sep 7:22 am AEST (signal lost 6:41 am) · INC-001 Fri 4 Sep 6:23 pm AEST · INC-036 Sun 4 Oct 3:09 am **AEDT**, signal lost 1:47 am **AEST** (22 minutes, across the daylight-saving change) · INC-005 Tue 13 Oct 4:08 pm AEDT · INC-049 Tue 20 Oct 8:12 pm AEDT (latest).
- Date filter groups (tested): Sep 1–30 → 25; Oct 1–20 → 25; flood advisory 21–25 Sep → INC-044, 029, 025, 004, 012; one day 4 Oct → INC-036 only; silent pendants in October → INC-006, 048, 045, 008, 041, 034, 039.

## Migration evidence (emulator / offline only)

- The v1 reconstruction reproduces, offline, the SHA-256 payload fingerprint recorded for the live write on 23 October (`7d423223…c6f0`), so the planner's "untouched version 1" matches the live documents exactly. No live data was read to check this.
- Emulator rehearsal: dry run plans 50 three-field updates and writes nothing; write converts all 50 atomically and verifies them; `createdAt`, owner and text unchanged; another operator's incidents and all action logs unchanged; second run `NOTHING_TO_DO`; write refused after a concurrent change; batch precondition blocks a raced write with nothing written; tampered document and extra incident both STOP; rollback restores the exact v1 documents; migrated documents read through the rules show the new timeline and a decision still saves.

## Screenshots (`docs/evidence/phase6/`)

Captured with headless Chrome from a scratchpad harness that renders the real components with the real seed dataset, parser, summary and queue logic. Auth and Next routing are stubbed and **no Firebase call is made**. The two history entries on the detail screenshots are labelled "Harness example only" and are not real decisions.

| File | Shows |
|---|---|
| `01-dashboard-desktop-1280.png` | Queue, counts 50/47/3, controls, newest-reported order, combined time column |
| `02-filter-flood-21-25-sep-1280.png` | Date range isolating the five flood-advisory incidents |
| `03-filter-silent-october-1280.png` | Connectivity + October range: seven silent pendants |
| `04-no-results-clear-filters-1280.png` | Zero-results state with Clear filters |
| `05-dashboard-tablet-768.png` | Two-up cards, mobile navigation row |
| `06-dashboard-mobile-375.png` / `07-dashboard-mobile-320-nav-tabs.png` | Phone layout: nav row, compact filters, tabs without sideways scrolling, clickable cards |
| `08-detail-desktop-1440.png` / `09-detail-mobile-375.png` | Breadcrumb, Reported / Last signal (simulated), Dataset record box, decision form and history unchanged |
| `10-detail-dst-inc036-1280.png` | AEST → AEDT across 4 October |
| `11-legacy-v1-before-migration-1280.png` | Version 1 records before migration: explained, nothing estimated |
| `12-landing-desktop-1280.png` / `13-landing-mobile-375.png` | Branded landing page |
| `14-dashboard-dark-1280.png` | Dark mode |

## Not verified here

- The real Next.js app with live Firebase: Phase 6 has not been deployed or exercised live. A Vercel Preview of the PR uses the live project; **no decision may be submitted there**.
- The live migration (dry run, write, verification) — needs its own approval and a temporary, update-only credential.
- Screen-reader testing with real assistive technology (only role/name/aria assertions in tests).
