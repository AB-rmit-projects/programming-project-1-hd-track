# Phase 5 — Browser Verification (CP7)

Verification of the incident detail page, decision form and decision history (`/dashboard/incidents/[incidentId]`) in a real browser, 25 October 2026. Earlier evidence: unit and component tests (mocked SDK) and the CP6 emulator tests (real SDK and rules) — see [TESTING.md](TESTING.md).

**Not covered here:** the live Firebase project. No live data was read or written, the composite index was not deployed, and a production save has not been attempted. Those belong to CP8 and need separate approval.

## What this evidence does and doesn't show

| Kind of evidence | Used here | What it shows |
|---|---|---|
| Real browser | Yes: headless Chrome via the DevTools protocol | Real layout, input, focus, live regions and network behaviour of the app's own components |
| Real Firestore SDK and rules | Yes: the web SDK against the local `demo-safecall` emulator with the repository's rules | Real listeners, metadata, writes, refusals and offline/reconnection behaviour |
| Mocked services | Auth (`useAuth`), Next.js `Link` / navigation, the Firestore client module (swapped for an emulator-only instance) | — |
| Not tested | The normal Next.js app: server session cookie, `proxy.ts`, the `(dashboard)` layout's Admin SDK check, Next's router, `next/font` | Needs live Firebase (CP8) |
| Not tested | Screen readers (axe-core and semantic checks only) | — |
| Not tested | The live Firebase project: no live reads, writes, rules or index | CP8, separately approved |

## How the browser was isolated

The real Next.js app can't run a signed-in session without live Firebase:
- `lib/firebase/client.ts` always uses the `NEXT_PUBLIC_FIREBASE_*` config;
- the `(dashboard)` layout verifies the session cookie with the Admin SDK, which needs the service-account key and checks revocation against live Auth;
- there is no Auth emulator.

Changing that would mean production code or config changes, so instead a **test-only harness** outside the repository rendered the app's real components.

- **What it renders:** the real route module (`page.tsx`, so its ID check runs as in the app), `DashboardShell`, `IncidentDashboard` and `IncidentDetail`, styled by the real `globals.css` through Tailwind.
- **What it replaces:**
  - `lib/firebase/client.ts`, matched by its resolved file path so the relative `./client` import is caught too. The real module never loads.
  - `hooks/useAuth` (a signed-in, verified operator chosen by the test).
  - `next/link` and `next/navigation` (History API).
  - The one environment value used, `NEXT_PUBLIC_APP_NAME`, set to a fixed label.
- **Data:** the real Firestore web SDK, initialised for `demo-safecall` and connected **only** to the local emulator (`127.0.0.1:8080`), with the emulator's mock user token (`email_verified: true`). The real rules were loaded by `firebase emulators:start`. Incidents were seeded with the Phase 3 seed tool (emulator-only), plus fictional edge-case records written with the emulator's admin token.
- **Browser:** Chrome (headless), driven over the DevTools protocol by a small Node script. Every page request was logged. Apart from the SDK probe below, only `127.0.0.1:5199` (harness) and `127.0.0.1:8080` (emulator) were contacted.
  - On network errors, the Firebase SDK's bundled WebChannel requests `www.google.com/images/cleardot.gif` to test connectivity. It carries no Firestore data, it also happens in production, and here it fired only while offline (and failed).

Not covered by the harness: the Next.js server (session cookie, proxy, layout), Next's own router and `next/font`.

## Results (final run, every scenario from a fresh emulator)

| Scenario | Checks |
|---|---|
| Journey: dashboard 50/50/0 → open a row → facts → ACKNOWLEDGE, ESCALATE, REVIEWED → history newest first → back → dashboard 50/49/1; browser back/forward; full reload keeps the history (AC-05) | 38/38 |
| Responsive: dashboard, a detail page, a long-text stress incident (128-character ID, long unbroken tokens, long multi-line rationale) and a missing-fields incident at 320 / 375 / 768 / 1280 px, light and dark — no horizontal page scroll, screenshots reviewed | 35/35 |
| Keyboard and accessibility: Tab / Shift+Tab order, visible focus, radio arrows and Space, keyboard submit, focus to the first invalid field, `aria-invalid` / `aria-describedby`, headings, labels, live regions; axe-core 4.12.1: **0 violations** in 7 states | 35/35 |
| Saving: a genuine server-side rule refusal keeps the exact choice and rationale, no automatic retry, explicit retry saves once; slow network → "Saving…" → waiting notice at 10 s → saved; a double click and three Enter presses store one log; a later decision; the repeat-REVIEWED notice | 19/19 |
| Real offline (Chrome network off): stale incident, saving paused with the reason linked, draft kept, nothing written; a write cut off in flight waits, stays locked and is confirmed **once** after reconnecting; dashboard counts it once | 14/14 |
| Navigation during a pending write: not counted on the dashboard while unresolved; on return still shown as saving and locked; saved once | 9/9 |
| Privacy: invalid links make no Firestore request; another operator's incident and a missing one show the identical neutral message and no details ever render; a non-simulated incident fails closed; incident and account switches never show earlier drafts or details (every page state recorded); nothing is stored in local/session storage | 15/15 |

No `INTERNAL ASSERTION FAILED` (`ca9` / `b815`) and no uncaught exception appeared in any run. Screen readers were **not** used; the accessibility evidence is axe-core plus the semantic checks above.

## Defects found and fixed

1. **Invalid HTML while saving.** React warned "`<div>` cannot be a descendant of `<p>`". The shared `LoadingSpinner` (a `<div role="status">`) was inside a `<p>` and inside the Save `<button>`, adding a second "Loading" status to the live region. `DecisionForm` now uses a decorative `<span aria-hidden>` spinner; the shared component is unchanged. A regression test is in `IncidentDetailUI.test.tsx`.
2. **An unresolved save shown without context.** After leaving and returning while a save was pending, a bare "Saving your decision…" line appeared below the loading spinner. That panel (`IncidentDetailView`) now has a heading ("Your decision") and says the decision is still being saved and no other can be recorded until it is confirmed. UI only; the CP4 lock is unchanged. Two regression tests.

## Findings not fixed (for review)

- **Fixed after CP7 (see below):** the dashboard and the detail page could disagree on a privileged REVIEWED log without `createdAt`.
- **The emulator speaks HTTP/1.1, and Chrome allows 6 connections per host.** With the back/forward cache on, pages kept from earlier full loads hold their Firestore long-polls, so the 7th full load in a tab stalled and correctly showed the offline state. Turning the cache off made it disappear (24/24 loads). The long scripted runs therefore used `--disable-features=BackForwardCache`. Production Firestore uses HTTP/2, and the app navigates client-side, so this is a test-environment effect.
- **Pre-existing, outside Phase 5:** below `md` the shell has no navigation menu (the sidebar is hidden), and the Phase 4 queue tabs scroll sideways at 320 px.
- **Verbose radio names:** each radio's accessible name includes its description, because the `<label>` wraps both. Valid, but verbose for screen-reader users.

## Not verified here

- The composite history index on the live project; the emulator ignores indexes.
- The `index-missing` history state in a browser: the emulator can't produce it. It is covered by component tests.
- Real screen-reader use.
- Firestore's live HTTP/2 transport and the Next.js server path, both of which need the live project (CP8).

## Screenshots

A small curated set, saved from the final run, in [`evidence/phase5/`](evidence/phase5/). The full set of about 160 captures was not kept in the repository.

| File | Shows |
|---|---|
| `01-dashboard-desktop-1280-counts.png` | Dashboard, 50 / 50 / 0, desktop table |
| `02-dashboard-mobile-320.png` | Dashboard at 320 px (stacked cards) |
| `03-detail-tablet-768.png` | Detail page at 768 px (single column) |
| `04-detail-mobile-320-long-text.png` | 320 px with a 40-character code, long device ID and long location |
| `05-decision-form-mobile-320.png` | Decision form and history at 320 px |
| `06-detail-desktop-1280-dark.png` | Desktop two-column layout, dark mode, long evidence text |
| `07-history-confirmed-after-three-decisions.png` | After ACKNOWLEDGE, ESCALATE and REVIEWED: success message, toast, cleared form, history newest first (page heading out of frame) |
| `08-feedback-waiting-for-confirmation.png` | Slow network: waiting notice, locked button, the pending decision not listed |
| `09-feedback-refused-input-kept.png` | A server-refused save: alert, decision and exact rationale kept |
| `10-offline-stale-saving-paused.png` | Offline: cached-data warnings, saving paused with the reason, draft kept |

The red "Offline" badge in these screenshots is the pendant's simulated connectivity status (Phase 4 wording), not the app's network state.

## Post-CP7 hardening (25 October 2026)

Two corrections were made after the browser run. Both are **local to the repository** and tested on the local emulator only.

1. **The rules now require simulated incidents.** The `actionLogs` create rule now accepts a log only for an incident that exists, belongs to the signed-in verified operator, **and** has `isSimulated == true` (`isOwnSimulatedIncident` in `firebase/firestore.rules`; a missing flag counts as false). Before, only the app enforced this. This rule is **not yet deployed** to the live project.
2. **Dashboard and detail agree on logs without `createdAt`.** Checked on the emulator: the ordered history query leaves out a log only when `createdAt` is *missing*, and keeps it for any present value, even `null`. The dashboard now ignores exactly those missing-field logs (`confirmedReviewEvidence`), so neither screen counts or lists them. Legitimate decisions, duplicates and ACKNOWLEDGE/ESCALATE semantics are unchanged.

The screenshots predate these corrections but aren't affected by them: they show only simulated incidents and well-formed logs.
