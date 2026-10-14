# Orb nesting evidence

Retained red logs and first-failure screenshots precede the corrections; none were deleted.

- `unit-red.log`, `presentation-red.log`, `browser-red.log`: missing tree implementation, flat index/search ordering, and absent nested rows.
- `browser-first-implementation.log`: corrected harness assumptions. Index link names include state and age, so archive selection uses its stable href. Dashboard delete actions remain 20px on phones, not 44px; the phone index remains hidden.
- Find uses `Meta+k`, including Playwright on Linux (`apps/web/src/components/AppSearch.tsx`); not `Alt+F`. `browser-qualified.log` exposes the empty-query assumption: Find shows no results until queried. Tests now search for `r` and assert matching traversal order.
- `ancestor-rail-red.log`: a single zero-width guide did not show ancestor rails. Tests require full-row repeating rails spanning 10px at depth 1 and 28px at depth 2; `browser-with-rails.log` records all three nesting tests passing.
- `browser-final.log`: eight browser tests passed across `e2e/orb-nesting-frontend.e2e.test.ts` (three) and `e2e/frontend-web-shell.e2e.test.ts` (five). Screenshots cover nesting, promotion, and 32-level containment at 1280/768/390/320px.

The launch harness follows environment override → existing `/usr/bin/chromium` → Playwright's downloaded engine. The retained `browser-final.log` predates this fallback correction. Final-source qualification after the correction passed all eight Chromium cases (2026-10-14): `npm run test:e2e -- --project=frontend e2e/orb-nesting-frontend.e2e.test.ts e2e/frontend-web-shell.e2e.test.ts`. Log: `test-failures/orb-pad-nesting/browser-final-source.log`. No full E2E or real-PostgreSQL/native-image acceptance.
