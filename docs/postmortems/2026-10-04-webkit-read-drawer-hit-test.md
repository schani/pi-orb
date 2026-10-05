# WebKit read-drawer hit test — 2026-10-04

## Evidence

Original full process E2E log: `/tmp/remove-composer-validation/e2e.log`, lines 414–448. WebKit case `uses call arguments only when a completed read's result has no displayable body` failed at `e2e/tool-images-frontend.e2e.test.ts:351:48`: `normal.locator(":scope > summary").click()` timed out after 30,000 ms.

The locator resolved the `docs/web-ui.md` read-call summary within the `HistoryView.tsx` / `docs/web-ui.md` category. Playwright reported visible, enabled, stable and completed scrolling, but `<p>Before receipt.</p>` from the `response-markdown` subtree intercepted pointer events across 59 attempts (2 + 2 + 55). The click was never admitted; this is not a fallback-result rendering failure or a `waitForResponse` race.

Small sanitized summary: `test-failures/2026-10-04-webkit-read-drawer-hit-test.json` (**NON-REPLAYABLE**, not a determined trace). The original log remains at its path above.

## Limits and disposition

Root cause is **unproved**. Indirect layout, compositor or native-scroll interaction is possible, not established. ToolActivity, this test and seeded calls were unchanged; transcript layout shifted, so unchanged drawer code does not establish unrelatedness.

Locator visibility/stability does not establish actual WebKit hit testing. Qualification remains blocked; no deployment. Qualification is recorded in `docs/testing.md`; follow-up lives only in `TODO.md`.
