# WebKit reload internal error — PR 66

**Status: unresolved; merge/deployment blocked. Diagnostics only, not a corrective stabilization.**

## First failure

[E2E 37729016278](https://github.com/schani/pi-orb/actions/runs/37729016278), shard 1, qualified PR head `24321b177facf1379bb1351a58334797cd49b808`. WebKit failed `missing-orb-layout-frontend.e2e.test.ts:115` at `page.reload`, waiting for `load`. Desktop geometry, preserved URL, DELETE 202 and deleting-state assertions had passed; Chromium's equivalent case passed. The original logs and downloaded artifact inventory remain in `.context/pr66-qualification/`.

No browser trace, WebSocket failure, process fault, kernel fault or resource sample accompanies this occurrence. The test retained geometry and screenshot under a runner-local `/tmp` directory, outside artifact upload paths. The available DST artifacts do not diagnose this browser navigation failure.

The earlier headline `page.goto` internal error occurred in the same shard, but shard identity alone does not establish a shared native cause. Its independently proven same-document ownership defect is recorded in `docs/postmortems/2026-10-08-headline-spa-cancellation-fixture.md`; that repair cannot replace reload coverage here.

## Investigation (2026-10-08)

- Frontend files execute serially (`maxWorkers: 1`). This test creates and closes its own browser and Vite server per case, with an OS-assigned port and independent optimizer cache. No shared browser or fixed-port collision was found in this path.
- Reload runs after deleting-state rendering and switches metadata to 404. No deliberately held response remains. Existing response waits are owned and settled after browser closure.
- The dev server injects an HMR WebSocket in addition to application sockets. Their existence does not prove a navigation dependency, cancellation defect or native lifetime bug.
- One unchanged targeted diagnostic passed on the local Debian host with Node 24.6.0, Playwright 1.63.0 and WebKit 2359/26.6. Browser/protocol logs are in `.context/pr66-webkit-navigation/baseline-diagnostic.log`. No native fault was reported; kernel access was denied. This is not reproduction or Ubuntu CI qualification.

Rejected without causal evidence: navigation retries, timeout changes, engine substitution, replacing reload with SPA navigation, disabling HMR, or serializing an unidentified request. The earlier Debian network-process/libgobject fault recorded in `docs/testing.md` is not evidence that this Ubuntu occurrence has the same cause.

## Diagnostic correction

Tests first reproduced two missing-observability assertions and missing workflow retention. The shared frontend observer now retains browser disconnect/page-crash counters, WebSocket open/close/error counters and bounded sanitized socket URLs/errors. It removes its listeners on completion or explicit disposal. The reload test observes from before initial navigation, so faults on old-document sockets are not missed.

Missing-orb failure metadata, pre-reload desktop PNG and geometry now live under an explicitly allowlisted `test-failures/missing-orb-*` directory; successful cases delete those files. CI retains browser launch/exit/stderr logs through `DEBUG=pw:browser`. Its failure-only host step records filtered kernel faults/OOMs, process names/RSS without arguments, disk/memory and GLib/libsoup package versions. Resource samples occur after failure, not at its onset; absence of a fault report is not proof of browser health. No protocol payloads, native cores or optimizer caches are uploaded.

Reload, its default load wait, 404 recovery, URL, geometry and phone assertions are unchanged. No product correction or crash fix is claimed. Remaining work is tracked in `TODO.md`.

## Validation

Evidence: `.context/pr66-webkit-navigation/`.

- `telemetry-red.log`, `retention-red.log`, `native-retention-red.log`: expected tests-first failures.
- `telemetry-final.log`: two controlled fault/redaction/listener-ownership unit cases pass.
- `retention-final.log`: four workflow evidence contracts pass.
- `instrumented-browser.log`: eight browser cases pass before extending observation to initial sockets. `final-browser.log`: all eight missing-layout/listener browser cases pass with final instrumentation. Neither run establishes crash stabilization.
- Root typecheck/lint and E2E typecheck pass. No CI rerun, commit, push, merge or deployment.

Neither passing diagnostic nor instrumentation validation resolves the original navigation failure. A safe corrective fix is not established.
