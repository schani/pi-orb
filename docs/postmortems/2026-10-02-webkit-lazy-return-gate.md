# WebKit lazy-return deployment gate

## Status (2026-10-02)

Lost activation reproduced and localized to split pointer targets. Desktop rail positioning and redundant document-scroll writes are corrected locally, with red-before/green-after browser regressions. The exact asynchronous layout/compositor ordering and equivalence to the original CI failure remain unproved. No commit, push or deployment occurred during this investigation.

[E2E 37059284127](https://github.com/schani/pi-orb/actions/runs/37059284127) failed the lazy-transcript cached-return sync counter. CI retained no browser/transport trace, so its initiating cause cannot be assigned to either local finding below. Holding A's metadata response in an earlier diagnostic experiment kept B visible and delayed A's reconnect until release; this does not establish the CI cause. The final regression keeps the original zero-delay `locator.click()` path and its cache/leak/retry assertions, alongside a separate controlled scroll sequence. Neither passing isolated tests nor this correction alone clears deployment.

## Original local failure

Preserved, unchanged: `test-failures/lazy-return-webkit-first/{failure.json,failure.png,trace.zip}` (ignored local artifacts).

After A→B, B rendered and synchronized. Playwright resolved A's sidebar anchor, passed actionability, and reported a completed click at `(117.5, 99)`. Trace call `call@113` started at 9403.592 ms, dispatched input at approximately 9655.553 ms and returned at 9706.901 ms. The browser recorded no A-anchor click or hashchange, remained on B, and issued neither A metadata nor A's reconnect hello. The first trace lacks pointer-down/up targets and DOM identity. Alone, it does not distinguish suppressed activation, target replacement, or undelivered input.

Source inspection finds stable keyed sidebar rows, a persistent `OrbIndex`, and no sidebar click cancellation for selecting another orb. These facts do not prove that a particular node survived the failed input sequence. B's lazy image/detail rendering overlapped the click; overlap alone is not causation.

## Bounded pointer experiments

Dependencies were clean-installed before validation. Each experiment stopped at its first failure or its fixed attempt bound:

- Ten WebKit attempts with pointer/focus targets, node identities and index geometry/mutations: no failure. The probe read layout during mutation callbacks, so it could alter the schedule.
- A passive probe removed geometry reads and console emission, recording identities and mutations in memory. Attempt 12 of at most 15 failed at an added diagnostic assertion, not navigation.
- After correcting that diagnostic's synchronization, fifteen passive-probe attempts had no failure. These passes do not clear the original failure.

Logs: `test-failures/lazy-pointer-experiment/`, `test-failures/lazy-pointer-passive/`, `test-failures/lazy-pointer-passive2/`. The latter two retain probe/test source; `lazy-pointer-passive/first-failure/` retains JSON, screenshot and trace. The temporary probe dependency was removed from the working test after the experiment.

## Captured lost activation (2026-10-02)

Preserved: `test-failures/lazy-pointer-third/first-failure/{failure.json,failure.png,trace.zip}`, `test-failures/lazy-pointer-third/protocol-31.log`, probe and test source alongside them. A bounded run stopped on its first failure after thirty passive-probe passes. The WebKit protocol logged `Input.dispatchMouseEvent` move/down/up at `(117.5, 99)` (IDs 1369–1371), each acknowledged successfully; Playwright's zero-delay click submits all three concurrently and its actionability interceptor checks only the first trusted pointer/mouse event. An ACK does not certify DOM activation.

The browser observed the move on A's child span (node 51, anchor 45). **Down and mousedown hit the archive `<summary>` (node 52) instead; up and mouseup hit A's child span (node 51).** The resulting trusted click targeted their common project `<section>` (node 16), not the anchor. No index mutation was recorded between down and up. The URL remained on B; there was no A metadata or reconnect. The mouse coordinates did not change. This establishes why the click returned successfully without navigation: WebKit hit-tested different elements during one input sequence, and their lowest common ancestor has no navigation action. It rules out a React click cancellation and, for this reproduction, a missing protocol dispatch. It does **not** establish why the hit target changed: layout/scroll movement or asynchronous WebKit hit-test state remain possible. Both failed traces recorded root `scrollTop` changing **1135→1103** across the action. A separate static WebKit geometry sample at B's initial scroll limit (409) put A at y=89–109 and the archive summary at y=130–150. Thus a 31–32px transient sidebar displacement would explain the observed down/up targets, but neither failed trace measured geometry or scroll at each event; this is a candidate trigger, not a proved cause.

A further bounded 80-attempt probe read sidebar geometry inside event listeners without reproducing the failure. Those reads can flush layout and change the schedule; the passes neither disprove the split-target mechanism nor establish a fix. An isolated sticky-sidebar WebKit stress probe also did not drop clicks under repeated root scroll writes. We did not change the product or add a green-only regression around an unverified trigger.

## Separate diagnostic race

In the captured passive-probe failure, A's anchor remained node 23. Pointer-down at 7141 ms and pointer-up/click at 7144–7145 ms targeted the same child span (node 61), with no intervening index mutation. Hashchange, metadata, cache return and reconnect all succeeded.

The diagnostic then observed raw Playwright `framereceived` for `sync.completed` at 10729.5 ms, but the WebSocket route's `server.onMessage` callback ran at 10755.7 ms. The immediate assertion of that callback's counter ran between them. Failure evidence eventually contains both syncs because capture continued asynchronously.

Thus raw WebSocket instrumentation is not a barrier for route-callback execution or application delivery. The temporary probe was corrected to poll its own route counter; the final regression does not install a WebSocket proxy or assert on its callbacks. This was a diagnostic race, not the lost activation.

## Root-scroll coupling and correction (2026-10-02)

The fixed mouse coordinate hit A on move (7151 ms), archive summary on down (7184 ms), then A on up (7243 ms), producing the common section as the trusted click target. The root scroll changed 1135→1103 (32px) across the same action; the index was `position: sticky` inside the document-scrolling grid, with the archive summary 41px below A in the stable layout. The observed split targets explain the lost activation. A transient ~32px displacement of the sticky rail under changing root-scroll/layout state would put the summary at A's click coordinate at press time, but the trace did not measure intermediate bounds, so this displacement is a mechanism consistent with the evidence, not a measured fact. WebKit's native click target is the common inclusive ancestor of press and release targets, not the anchor. No handler canceled the click. The traces do **not** identify which content update or browser scroll phase moved the rail, nor do they prove that the CI failure followed the same interleaving.

A controlled synchronous `scrollTo` of -32px at stable B geometry kept sticky A at y=89 and the rail at y=0. In a separate experiment, a pointermove listener changed root scroll by 32px before a native down and restored it before up; sticky hit targets remained on A. These negative experiments rule out a simple steady-state 32px scroll as a reproducer: the failure requires a transient layout/hit-test schedule. Replaying an arbitrary root scroll and claiming that it reproduces the original WebKit compositor phase would be false.

The correction removes the dependency: the desktop 236px index is viewport-fixed, with the conversation explicitly assigned the second grid column; the session ribbon offsets the index and phone layout still hides it. Document height changes cannot shift the fixed rail's containing-block boundary. Desktop tail-following also skips same-position `window.scrollTo` calls during polling, as the phone path already does; this removes unnecessary programmatic scroll transitions but is not independently proved to have initiated the recorded split target.

The WebKit/Chromium cached-return E2E now checks rail positioning, anchor/archive bounds and hit-testing around a measured nonzero 32px document scroll, then confirms another measured 32px movement **between native mouse down and up**, an anchor-owned click and destination URL. The original A→B→A concurrent `locator.click()` cached-return path and raw-frame sync assertion run **first, unchanged**; the controlled scroll sequence runs in a later round trip. The fixed-position assertion fails on the original sticky CSS. A separate metadata-poll native-scroll-call assertion fails without the desktop scroll guard (two redundant calls in WebKit), then passes with it. These establish the correction's structural and scroll-ownership invariants, **not** deterministic reproduction of the transient sticky/compositor defect. The original first failure and protocol log remain preserved.

The first controlled-scroll regression attempted +32px after down while B's transcript was still expanding; WebKit had reached the new document bottom, so the measured movement was zero. The browser trace and run log are preserved at `test-failures/lazy-return-controlled-first/`. The test now measures -32px, matching the observed failure direction; it does not assume spare space below the reader.

Validation: 23 style contracts, both cached-return browser tests (Chromium/WebKit), 41 selected mobile/index/session browser cases, repository typecheck, and changed-file lint passed. The full `npm run test:e2e:frontend` gate initially failed 7/120 solely because Playwright-managed Chromium headless shell was absent; its first log is preserved at `test-failures/lazy-return-full-frontend-first/run.log`. After installing that missing browser prerequisite, the complete frontend gate passed 120/120. The frontend script does not include the separate cached-return file, which passed independently. No runtime/full-slice E2E or deployment was run. The original CI failure cannot be retrospectively assigned to this local failure.

## Rebased path-routing gate (2026-10-03)

The rebased frontend run passed 176/177: WebKit's stopped-cache A→B→A stayed on B after `locator.click()` despite A's stored-cache checkpoint (`.context/path-routing/final-integration-frontend-fixed.log`). That checkpoint does not establish that the return click navigated; the first failure has no click, URL or transport trace. Three isolated instrumented WebKit attempts passed, then one instrumented full frontend run passed 177/177 (`.context/path-routing/stopped-attempt-{1,2,3}.log`, `stopped-diagnostic-full-frontend.log`). No new failure trace was produced. The exploratory instrumentation is preserved as `transcript-cache-stopped.diagnostic.e2e.test.ts` and `transcript-cache-stopped.diagnostic.patch` in that directory; the committed test remains unchanged. These passes do not resolve the original failure or clear the deployment gate. Pushing code is not deployment; deployment remains blocked.
