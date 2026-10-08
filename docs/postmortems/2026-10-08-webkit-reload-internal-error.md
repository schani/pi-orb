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

## Error mapping and controlled network-process loss (2026-10-08)

Playwright 1.63.0's WebKit patch forwards the provisional load's `ResourceError.localizedDescription()`; the JavaScript adapter forwards it to aborted navigation. The pinned upstream base is [`4d05d732`](https://github.com/WebKit/WebKit/blob/4d05d732e5a84f32675bef4cc135a2e7a9269a87/Source/WebCore/platform/network/ResourceErrorBase.cpp#L97-L105). `internalError` returns `WebKitErrorDomain` code 300 and the exact observed text. Before returning, it **always writes its caller's source file, line and function to stderr**. The new `DEBUG=pw:browser` capture can therefore distinguish callers without a core.

`WebLoaderStrategy::networkProcessCrashed` fails pending resource loaders through `internallyFailedLoadTimerFired`; failed network IPC scheduling uses that path too. Other callers include a missing network session and failure to map a shared resource buffer. The exception alone does not establish a native crash.

Owned local controls held a main-document request, then sent SIGKILL only to that script's `WPENetworkProcess`. They reproduced both the exact `page.reload` and `page.goto` internal errors, waiting for `load`. Both stderr captures identified `WebLoaderStrategy.cpp(704)::internallyFailedLoadTimerFired`; page-crash and browser-disconnect counters both remained zero, and MiniBrowser later closed with exit code zero. This establishes a network-process-loss signature, **not the cause of either historical CI failure**. A clean browser-parent exit and zero observer counters cannot exclude child-process loss.

Twelve unchanged, isolated WebKit delete-active cases passed on Debian, each with fresh browser/Vite ownership, `DEBUG=pw:browser` and private core collection enabled. No internal error or native fault was captured. Debian supplies GLib 2.74.6-2+deb12u9 and libsoup 3.2.3-0+deb12u2, unlike the previously documented Noble experiment. Kernel access is denied on this guest. No Docker daemon or workflow was changed. Evidence: `.context/pr66-webkit-root-cause/` (`probe-results`, `probe-*.log`, `network-loss-{control,goto-control}.log`, pinned source copies).

## Hosted reproduction mode (2026-10-08)

[Dispatch 37733867215](https://github.com/schani/pi-orb/actions/runs/37733867215) passed all 30 independent, isolated WebKit delete-active invocations on Ubuntu. Alongside the twelve passing Debian probes, this failed to reproduce the historical full-frontend-cohort failures; it clears nothing. Evidence: `.context/pr66-webkit-ubuntu-diagnostic/`. The controlled network-process kill reproduced the exact localized error and caller stderr with zero page-crash/browser-disconnect counters, but establishes no historical root cause.

**Next experiment (2026-10-08; prepared, not dispatched):** retain the existing optional `webkit_reload_diagnostic` (default false), but run `npm run test:e2e -- --project frontend --shard=1/4` in ten independent Vitest processes, serially, stopping at the first failed invocation. This preserves the complete frontend shard 1 sequence and ambient native preconditions instead of selecting one case. Only shard 1 runs diagnostic tests; other shards skip tests. Historical shard 1 frontend files total 101.8 seconds of test time (activity headlines 55.0, missing-orb layout 40.8, lazy pairing 6.0); ten cycles plus startup/prerequisites fit the unchanged 40-minute job budget. This is an estimate, not a timeout increase or completion guarantee.

Ubuntu 24.04, Node 24.6.0, npm/engine prerequisites, assertions, reload/load waiting, timeouts, `DEBUG=pw:browser`, failure-only host diagnostics and artifact retention remain unchanged. Each cycle is numbered in the hosted log. PR, main push and default dispatch remain full four-shard runs; release qualification still requires exact-SHA `push`/`main` evidence. Offline contracts reject the previous targeted command and verify the exact cohort invocation, ten-process bound and first/seventh-failure exit propagation.

This deliberately seeks the first native error, not a green rerun or qualification. A passing cohort cannot clear the original failure. Merge/deployment remain blocked until safe corrective stabilization is validated or the user explicitly grants an exception. The caller line decides the next branch: loader IPC/loss requires native child/kernel evidence; session or buffer failures require their own resource-lifetime evidence. No navigation retries or removed reload coverage.
