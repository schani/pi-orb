# Token usage implementation — 2026-10-13

## Tests first

Protocol/service/HTTP/ledger/web tests failed before implementation: missing usage exports/read methods and the unrecognized `/usage` route. Browser entry failed before the Trend link existed. Original output is retained in `test-failures/token-usage-implementation/usage-tests-first-red.log` and `usage-browser-tests-first-red.log`.

## Corrections

- **SQL:** `operator does not exist: uuid = text`. Ledger owner is text, project owner UUID; cast the owned-project join to text. No migration. Original: `usage-core-first-green.log`.
- **Clock fixture:** expected buckets were absent. Recording stamps time inside the asynchronous transaction, not at `record()` entry. Await `ledger.drain()` before advancing its mocked clock. Original: `usage-core-after-uuid-fix.log`.
- **Calendar fixture:** expected 121 month ticks, received 120. Dec 1, 2026 10am Pacific → Nov 1 10am is 720 hours; Nov 1 10am is already after fall-back. The recorded calendar replay is retained as `usage-calendar-replay.txt`. Six months has 183 daily intervals, including one 25-hour interval; spring coverage independently requires a 23-hour interval. This was a calendar expectation error, not a determined simulation failure.
- **WebKit pointer targeting:** Playwright `label.hover()` reported Cache write intercepting Cache read. Saved actual text bounds/hits in `usage-label-bounds-webkit.json`; moving to the target's bounding-box center hits Cache read. Assertions still require three dimmed lines and exact tooltip values. No chart behavior was changed to satisfy the test. Original: `usage-webkit-label-diagnosis.log`.
- **Retained error canvas:** CSS `display: block` can override `hidden`. A new failing style contract required `.chart-canvas[hidden] {display: none}` while retaining the mount target for recovery. Original: `usage-chart-error-canvas-red.log`.
- **Large counters:** compact-summary tests failed before `formatUsageCount` existed. Shared chart tooltips remain exact; summary counters stay bounded on phones. Original: `usage-compact-counts-red.log`; the browser now also checks 10B volume at 320px.
- **Filter ownership:** expected Output after period replacement, received Total. Filters lived in the keyed request child. Lift the existing selection state to the page; replacement/retry now preserve it, without adding requests. Original: `usage-filter-preservation-red.log`.
- **Style contract selector:** the icon style now groups buttons and anchors. The test's substring lookup hit the later mobile 44px rule instead of the desktop group. Match the full selector list; retain the same 20px assertion. Original: `usage-qualified-unit.log`.
- **Frontend fixture:** the first new request check used an undefined `server` variable; use the owned Vite listener's origin. Corrected baseline then returned 404. Add the mock's validated, no-store empty ledger response, not production sample data. Both first outputs are retained.

A final phone-key invariant first misread presence-only `data-highlighted=""` as the string `"true"`. Fixing that DOM decoding exposed a real replacement bug in Chromium: the new six-line chart had no dimming, but the key retained Output, which was no longer a series. Saved key/opacity diagnostics distinguish this from WebKit legitimately hovering the new Headline label. Clear shared highlight state when a chart mount is replaced; retain the invariant that any active key selects exactly one current series and dims five lines. First failures, diagnostic JSON and corrected both-browser results are retained. No assertion was removed or timeout increased.

Saved logs have ANSI escapes and trailing whitespace normalized; original `/tmp` outputs remain.

Typecheck initially caught browser DOM/exact-optional fixture typing; those errors were corrected. Formatting diagnostics are retained. No failed assertion was weakened or timeout increased.

## Final validation

- 1,005 tests across 132 files: all web/protocol tests and relevant control-plane service, HTTP, writer, composition and ledger tests.
- Five real PostgreSQL ledger contract tests in a private throwaway Unix-socket cluster; the cluster was stopped and removed. PGlite runs the same contract.
- Four Chromium/WebKit usage/transcript-chart E2E tests: tooltip/isolation, actual dense tick counts, owner-shaped data, 320/390px containment, large counts, held obsolete reads, preserved filters, failure/Retry/empty and both civil DST transitions.
- Full workspace typecheck and rebuilt shared-renderer study smoke passed. Changed-source Biome has no errors; existing stylesheet specificity warnings remain.

Final outputs are retained beside the originals. This is scoped local validation, not deployment or full repository/process E2E release qualification. No commit or deployment occurred.
