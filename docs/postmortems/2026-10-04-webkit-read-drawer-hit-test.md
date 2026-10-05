# WebKit read-drawer hit test — 2026-10-04

## Evidence

Original full process E2E log: `/tmp/remove-composer-validation/e2e.log`, lines 414–448. WebKit case `uses call arguments only when a completed read's result has no displayable body` failed at `e2e/tool-images-frontend.e2e.test.ts:351:48`: `normal.locator(":scope > summary").click()` timed out after 30,000 ms.

The locator resolved the `docs/web-ui.md` read-call summary within the `HistoryView.tsx` / `docs/web-ui.md` category. Playwright reported visible, enabled, stable and completed scrolling, but `<p>Before receipt.</p>` from the `response-markdown` subtree intercepted pointer events across 59 attempts (2 + 2 + 55). The click was never admitted; this is not a fallback-result rendering failure or a `waitForResponse` race.

Small sanitized summary: `test-failures/2026-10-04-webkit-read-drawer-hit-test.json` (**NON-REPLAYABLE**, not a determined trace). On the investigation compute, the original `/tmp` log is absent; the summary is preserved unchanged.

## Bounded investigation — 2026-10-04

`e2e/testkit/read-drawer-hit-observer.ts` records content-free node/parent identities, ancestor geometry and scroll positions, disclosure state, viewport-center hit stacks, actual admitted pointer coordinates, native pointerdown/up/click/toggle order, detail requests/responses and cache admission diagnostics. Failure capture is automatic; `PI_ORB_READ_HIT_EVIDENCE=1` also preserves passing observations as gzipped JSON.

The fallback test retains the original normal-first order and explores explicit response gates: empty result held, fallback arguments held, and arguments released immediately before the normal summary's native locator click. The last gate controls response release, **not** its rendering time relative to pointer admission. Assertions and ordinary locator clicks remain intact; no forced clicks, programmatic disclosure opening, sleeps or timeout changes.

Evidence inventory and limitations: `test-failures/2026-10-04-read-drawer-exploration.json`. Its 20 `.json.gz` artifacts contain raw observations, readable with `gzip -dc <path>`. All are **NON-REPLAYABLE**.

- Initial instrumented baseline: Chromium/WebKit passed once (2 cases). A final two-case observer smoke test verified gzip output and hit rectangles; it is not qualification.
- Current working tree: complete owned file passed 24 cases across both engines, including all four schedules.
- Isolated `git archive 116eb54` restored the old UI, protocol and fixture; the old test has the failing click at line 351. With only the instrumented test/helper substituted, all eight schedule/engine combinations passed. This reconstructs code, not the historical environment or schedule.

In the initial WebKit observation, the category summary moved from y=-107 through y=-1544 to y=407 while the transcript scrolled; Chromium also moved. In the current release-at-click observation, fallback rendering moved the normal summary from y=469 to y=519 before pointerdown. Its actual native pointerdown/up hit the summary's code child, followed by a disclosure toggle. Neither observation reproduced the paragraph interceptor; neither establishes scroll anchoring or unchanged drawer code as the cause.

Probes read layout/style/hit testing and therefore perturb scheduling. Sampled centers are diagnostic candidates, not Playwright's internal retry coordinates. Actual pointer coordinates exist only for admitted clicks. Cache diagnostics expose record/detail identity and admission outcome, not private owner identity. No failed causal schedule was recovered, so no claimed failing regression or production fix was added. Preview ports 7100/5173 remained untouched; tests used their own ephemeral listeners/caches and the process backend.

## Limits and disposition

Root cause is **unproved**. Indirect layout, compositor or native-scroll interaction is possible, not established. ToolActivity, this test and seeded calls were unchanged; transcript layout shifted, so unchanged drawer code does not establish unrelatedness.

Locator visibility/stability does not establish actual WebKit hit testing. Qualification remains blocked; no deployment. Qualification is recorded in `docs/testing.md`; follow-up lives only in `TODO.md`.
