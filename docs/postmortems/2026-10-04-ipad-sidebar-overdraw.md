# iPad sidebar title overdraw

[Evidence archive](https://files---pi-orb-1077475695242.us-central1.run.app/s/c0e78117-a302-456b-a600-47b1d4dd7c22/diagnostics/sidebar-overdraw-evidence.tgz) preserves the referenced browser probes, screenshots and validation logs.

## Status (2026-10-05 PDT)

Confirmed layout defect; implemented, not deployed. The user reproduced it in Firefox and identified the extra text as `Back to dashboard` after deleting the active orb. The earlier Safari stale-paint hypothesis was wrong for this incident.

## Confirmed cause and correction

`OrbConversation` returned `NotFoundPage` directly when the orb was missing or deleting. That `.page.simple-page` became a direct child of the `.orb-page` grid without the normal `.orb-main` wrapper. The fixed `.orb-index` is out of flow, so the missing view auto-placed into column one beneath the 236px rail. Its heading was covered by sticky sidebar chrome; its dashboard link overlapped the first orb row. This is overlapping DOM, not stale Safari pixels.

The fix retains `.orb-main` around the missing view, using the existing desktop column-two and phone column-one rules. No sidebar paint workaround, redirect, API change or extra product instrumentation is needed. The resource-specific message, requested URL and dashboard link remain intact. Existing visible not-found state diagnoses the outcome; test geometry, screenshots and response checkpoints diagnose this presentation defect without lifecycle noise.

`e2e/missing-orb-layout-frontend.e2e.test.ts` tests the real frontend in Chromium and WebKit at 820×1080, then 390×844. Both direct missing navigation and the active orb's Delete control reproduced red before the fix: heading and link x=12 inside the sidebar's x=0…236, with covered center hit tests. After the wrapper, both start at x=248 and hit-test correctly. Active deletion uses a controlled DELETE→`deleting` response, then reloads against a controlled metadata 404; the URL never changes until the dashboard link is clicked on phone. This qualifies frontend behavior, not backend deletion cleanup.

Evidence: `.context/missing-orb-layout/{red.log,red-browsers.log,green.log,green-synchronized.log}` and copied red `pi-orb-missing-layout-*/{geometry.json,desktop.png}`. Initial WebKit launch lacked `libgstreamer`; installing browser OS dependencies allowed all four intended red assertions. The first green run exposed a test synchronization defect: WebKit's click returned before the DELETE route completed, so a synchronous boolean assertion raced the request. An explicit DELETE-response barrier fixes that harness defect; no assertion or timeout was weakened. All four synchronized browser cases pass. Final logs: `final-geometry.log` (four geometry cases), `final-browser.log` (five cases including the built-shell regression), `review-browser.log` (four cases with the controlled DELETE returning the contract's 202), `unit.log` (37 unit tests), `typecheck-final.log` and `lint-focused.log`. Repository lint passes with 20 existing warnings and six infos (`lint.log`); changed source/test files have none. The first typecheck caught the test's direct DOM global in the Node-only E2E config; acquiring `ownerDocument` from a locator fixes that test boundary. No full runtime E2E gate or physical-device qualification is claimed.

**Final review verification (2026-10-05 PDT):** deleting metadata stays HTTP 200/`deleting` until missing-view geometry passes, with zero metadata 404s at that checkpoint. Only then does the test switch to 404 and reload. Response waits attach rejection handlers immediately and are joined after browser closure, including failure cleanup. All four cases pass (`review-owned-checkpoints.log`); repository typecheck and focused source/test lint pass (`review-typecheck.log`, `review-lint.log`).

**Main integration (2026-10-05 PDT):** rebased onto `d67de4c`; all four browser regressions, repository typecheck and focused lint pass (`rebased-browser.log`, `rebased-typecheck.log`, `rebased-lint.log`). The user approved the buggy/fixed fixture comparison. No deployment performed.

## Earlier investigation (2026-10-04 PDT)

The following negative probes and hypotheses are retained as investigation history. They did not exercise the missing/deleting view and therefore could not reproduce this defect.

## Evidence

The user's iPad screenshot shows overlapping text in the first orb row of the PI-ORB sidebar, around screenshot y=120; subsequent rows appear intact. Fragments initially read as “Dashboard” and “Input …” are not reliable transcriptions of the extra text. The screenshot alone cannot identify its source or distinguish overlapping DOM from stale pixels.

A production CLI read identifies the first orb as `b44c15ef`, titled `Match Prompt Input Font to Transcript Size and Ligatures`, followed by `Evaluate Pi Durable…` and `Research How Conductor…`. That read is not a simultaneous browser DOM capture and does not establish what the browser had rendered when the screenshot was taken.

## Source findings

- `apps/web/src/components/OrbIndex.tsx` renders one plain-text name span per row, keyed by orb ID. No alternate title layer or title transition exists. Polling replaces each project's orb list every two seconds and retains mounted rows across navigation.
- `apps/web/src/lib/project-orbs.ts` sorts rows by descending `updatedAt`, then `createdAt`. A poll can rename a retained node or move another node into first position; no such update has been captured for this incident.
- `apps/web/src/styles.css` gives rows a 20px grid with a 16px tile, clipped single-line title, and age. The shared face is 13px monospace. There is no title transform, shadow, or absolute positioning. Only the selected row becomes bold/inverted.
- The desktop-width sidebar is fixed and independently scrolling, with sticky brand/project headers. `fd37eff` changed the rail from sticky to fixed; `ca9ffb1` bounded document/transcript scrolling. These are relevant layout changes, not demonstrated causes.
- The initial search found the phone-home `Dashboard` accessible label but missed the visible `Back to dashboard` in `NotFoundPage.tsx`. That omission led the investigation toward the wrong trigger.

## Earlier competing hypotheses (superseded)

Stale paint after a title update or row move is plausible if the DOM contains one correct title while pixels retain another. Fixed overflow and nearby sticky headers are candidate boundaries, not proof of a Safari bug. Actual overlapping DOM, unexpected title data, or device-specific typography remain alternatives. Ordinary font/ligature differences alone do not explain two distinct titles occupying one row.

Earlier Safari paint and WebKit hit-test investigations concern different symptoms; they do not establish this incident's cause: `docs/postmortems/2026-09-12-mobile-safari-scroll-ownership.md`, `docs/postmortems/2026-10-02-webkit-lazy-return-gate.md`.

## Earlier diagnostic contract (superseded)

Capture a screenshot before scrolling, resizing, or reloading could clear the artifact. Alongside it, capture actual row title strings, orb IDs/hrefs and source list IDs/order, title/row rectangles, computed font/line-height, sidebar scroll position, viewport/zoom, and device/browser version. This separates data/layout overlap from a DOM/pixel mismatch without guessing the extra words.

Physical-device capture is tracked in the existing device QA item in `TODO.md`. Prefer bounded diagnostic capture; invasive product instrumentation is not justified by the screenshot alone.

## Bounded browser probe

After `npm ci`, Playwright Linux WebKit 26.6 exercised an 820×1080 iPad preset at DPR 2: same-ID title replacement, poll-driven reorder, actual sidebar scrolling beneath the sticky header, touch/focus/Tab, and a held creation POST followed by placeholder removal/new-row insertion. Screenshots showed no overdraw; no page errors occurred. The initial undersized fixture did not scroll and is not sticky-edge evidence. A later probe corrected that with 80 rows. Its first invocation stopped on an incorrect fixture locator before creation; that harness failure is preserved, not a product failure.

Local evidence: `.context/ipad-overdraw/{README.md,repro.mjs,evidence.json,run.log}` and screenshots, especially `04-reorder-sticky-edge.png` and `08-creation-placeholder.png` / `09-created-row.png`. Earlier non-scrolling evidence remains in `.context/ipad-repro/`. Geometry and screenshots were inspected; this is bounded negative evidence, not regression qualification or proof that physical Safari is correct. Linux WebKit reported coarse pointer/no hover but `maxTouchPoints=0`; it does not reproduce the physical iPad input/compositor environment. The trigger was not identified by these probes; the later missing/deleting-view regression establishes it.
