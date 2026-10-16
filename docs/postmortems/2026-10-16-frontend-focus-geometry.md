# Frontend focus geometry readiness (2026-10-16)

## First failure and limits

The unfiltered frontend project selected all 47 files, serially, with the current E2E configuration and `DEBUG=pw:browser`. Its listeners were audited first: owned loopback ephemeral ports, frontend mock mode, isolated auth origins and in-memory hosting storage; no shared provider or database.

`frontend-session.e2e.test.ts` passed all 100 cases in 629.482s. `frontend-mobile.e2e.test.ts` completed 96 cases in 528.920s with one Chromium failure: `preserves reader position after focus intent and content growth` (12.031s). WebKit's corresponding case passed. The first run is **not green** and did not finish the other 45 files.

At the parent's explicit instruction, only Vitest PID 31801 received SIGINT. It exited 130 at 07:36:08 America/Los_Angeles. The installed Vitest 4.1.11 raw-signal handler schedules process exit after 1ms; unlike its stdin Ctrl-C handler, it does not call `cancelCurrentRun`. The deferred assertion stack was lost. The failed page had already closed without a screenshot or trace. Neither its assertion values nor historical DOM geometry can be recovered.

Original evidence remains under `.context/ci-speed-implementation/`: `frontend-first.log`, its pre-signal copy `frontend-at-first-failure.log`, `frontend-first.exit`, `frontend-first-failure-state.txt`, `frontend-first-inventory.json`, `frontend-vitest-signal-handler.txt`, and `frontend-audit.txt`. Original log SHA-256: `59e2c0d1c1c000133f7b8f54af0e8a62f9d088e5908e5618a63698ecb65aacaf`.

## Controlled evidence

Only the existing focus case was selected, in both engines. An instrumented normal schedule passed, which did not clear the failure. Its first record was 150px tall and entirely above the viewport: record top -2167px, viewport top 45px, viewport height 754px. Both engines revealed it natively. An oversized target was not observed in this fixture.

A controlled schedule appended 140px of actual content immediately before native focus, in the same task. Both engines failed the unchanged `distance > 48` assertion: received 0 after the existing 5s predicate deadline. Font and image loads were complete. Native focus revealed the record, moving scrollTop from 2212 to 0; the following ResizeObserver wrote the new tail, 2352. No released-pin edge occurred. Changed geometry intentionally preserved the existing pin.

The counterfactual used the same content growth, target and assertions, but acknowledged the tail follower's resize handling before native focus. Both engines passed. The observer confirmed the new tail before a rendering-frame boundary; focus then produced `released:scroll`, and the subsequent 800px growth preserved the reader's position.

Evidence: `frontend-focus-diagnostic.{log,json}`, `frontend-focus-controlled-red.{log,json,exit}`, `frontend-focus-controlled-barrier.{log,json,exit}`, their `*-source.ts` captures, and the controlled-red Chromium/WebKit screenshots. These controlled schedules establish a fixture-readiness defect, not equivalence to the lost historical assertion or a CPU-pressure explanation.

## Correction and contract

The existing contract in `docs/web-ui.md` guarantees focus-driven reveal with **settled geometry**; `docs/postmortems/2026-10-02-webkit-lazy-return-gate.md` explains why changed geometry retains pinning. This task does not expand that contract or change production scrolling.

The focus variant now waits for fonts, deliberately adds the controlled growth, and acknowledges the actual tail-following resize before a rendering-frame boundary. It asserts the native target is wholly offscreen and waits for the released-pin edge before further growth. All seven input intents and all original distance/pin assertions remain. Failure-only diagnostics retain viewport/target geometry, active element, font readiness and pin edges in the test log. No timeout or tolerance increased.

The corrected focused Chromium/WebKit pair passed once (`frontend-focus-corrected.log`, exit 0). The complete mobile file then passed once: 96/96 cases, both engines, 416.791s, exit 0 (`frontend-mobile-corrected-full.log` and its durable `.exit` file). No retries, sharding, filtering, timeout changes or production edits. Tested source SHA-256: `416ec906d991b43e1caca5c361d7e4b6746d5a1c186e2f0f1fb95901066e5c4f` (`frontend-mobile-corrected-input.sha256`).

After that frozen run, the failure-only diagnostic capture gained a narrow typed `ResultAsync` boundary: an unavailable/crashed page logs capture failure instead of replacing the original assertion. E2E typecheck and changed-file Biome passed after this diagnostic-only edit; the 96-case result predates it (`frontend-mobile-diagnostic-final.sha256`). This is corrective stabilization under the approved UI exception, not proof of the original assertion's cause or full frontend qualification. The other 45 files remain separately unqualified.
