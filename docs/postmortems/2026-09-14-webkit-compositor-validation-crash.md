# WebKit compositor crash during local validation — 2026-09-14

**Status: cause not established; release qualification blocked. No deployment occurred.** Actionable investigation is tracked in `TODO.md`.

## Evidence

After merging `origin/main` at `c9ed87f` into the subagent integration branch, the full Docker/PostgreSQL/browser E2E run finished **105 passed / 1 failed**. The failure was the first WebKit phone case in `e2e/frontend-mobile.e2e.test.ts`, at width 320: `page.goto` reported `Page crashed`. The frontend-only fixture does not start Pi or the subagent adapter.

At the matching time, **03:14:09 UTC**, the kernel reported:

```text
eadedCompositor[89191]: segfault at 7f7bc07fe000 ip 00007f7c1c170d8a
sp 00007f7ba4dfe728 error 6 in libc.so.6[7f7c1c044000+156000]
```

This is evidence of a native compositor-thread fault, not a selector timeout. It does not establish the underlying allocation/lifetime defect or whether application rendering triggers it. No core was collected on the initial run: the inherited core limit was zero. The sampled machine subsequently had about 29 GiB available memory and a 16 GiB `/dev/shm`; no matching OOM-kill evidence was found. Those samples do not explain the crash.

Environment: Linux amd64 guest, Playwright **1.62.1**, installed WebKit **26.5 / build 2336**. Browser binaries and native dependencies were installed with `npx playwright install --with-deps chromium webkit` before the run.

## Diagnostic reproduction attempts

The rest of the WebKit cases in the same suite passed. A targeted attempt with `DEBUG=pw:browser` and core dumps enabled passed, followed by **20 explicitly diagnostic isolated probes**, all passing:

```sh
ulimit -c unlimited
DEBUG=pw:browser npm run test:e2e -- e2e/frontend-mobile.e2e.test.ts -t 'webkit.*320px'
```

The probes were intended to capture a fault/core, not obtain a green release result. They did not reproduce the crash and **do not clear the first failure**. An earlier diagnostic name filter matched zero tests and is not counted as evidence. No renderer flags, browser-version change, retry policy, weakened assertion, screenshot warm-up or timeout increase was applied.

## Stable browser upgrade experiment — 2026-09-14

At the user's request, updated the exact `@playwright/test` pin and lockfile from **1.62.1 to 1.63.0**, the current stable release. The managed WebKit changes from **26.5 / build 2336** to **26.6 / build 2359**; managed Chromium is now **153.0.8010.12 / build 1243**. `npm ci` and `playwright install --with-deps --no-remove chromium webkit` completed; the latter preserves older browser installations for diagnosis.

With core dumps enabled and `DEBUG=pw:browser`, `npm run test:e2e:frontend` passes **41/41 tests** (27 session/desktop and 14 phone cases across Chromium/WebKit), including the original WebKit 320px case. Typecheck and lint pass. No test assertions, retries, renderer flags or timeouts changed. The subsequent complete PR rerun also passes **10 files / 106 tests** on Playwright 1.63.0; provenance is in `scripts/subagent-liveness/evidence/final-qualification-2026-09-14.md`. Neither passing run establishes the original crash's cause.

The [1.63.0 release notes](https://github.com/microsoft/playwright/releases/tag/v1.63.0) announce WebKit 26.6 but do not identify a fix matching this fault. Since the old build also passed subsequent probes, this result establishes compatibility with the newer stable build, **not a demonstrated crash fix**. Release-blocking status remains unchanged. Upgrade/install/browser logs are retained locally under `.context/webkit-upgrade/`.

## Post-upgrade recurrence audit — 2026-09-15

**No recurrence is recorded in the inspected post-upgrade runs.** Eight completed
GitHub E2E logs (`34891462327`, `34895955247`, `34999422115`, `34999422305`,
`35013933184`, `35021851799`, `35025810795`, `35027406866`) explicitly downloaded
WebKit **26.6 / build 2359** and passed the original 320px phone case.
Five runs completed successfully;
two failed Find assertions and one failed PostgreSQL port setup, not a browser
crash. Deploy run `35004543252` also installed build 2359 and passed that case
before its unrelated native-image fixture failure. Full logs were inspected for
`Page crashed`, compositor segfault and SIGSEGV evidence; none was found.
Local copies of the eight E2E logs are in `.context/port-investigation/` named by
run ID; GitHub retains the originals.

This complements the already recorded successful local post-upgrade suite. The
only documented WebKit compositor crash remains the pre-upgrade 26.5 incident.
The remaining uncertainty is whether the upgrade repaired its cause, not an
observed continuing failure on 26.6.

## Prior production versus the upgrade (verified 2026-09-15)

The last successful production run at this investigation,
[34896870065](https://github.com/schani/pi-orb/actions/runs/34896870065), deployed
`d11099083cbcf9b11fd3e09f53165472be9f1c36` on 2026-09-14. Its `package.json`
still pins Playwright 1.62.1. The later merged integration includes upgrade commit
`3922155`; neither that upgrade's passing tests nor the older successful release
records an established fix or waiver for this crash. Do not describe the prior
deployment as proof that the compositor failure was resolved.

## Interrupted full PR rerun — separate Chromium shutdown evidence

A later full-suite rerun was interrupted by a host reboot. At **19:36:07 UTC**, system Chromium PID 5765 logged `FATAL:dbus/bus.cc:1245 D-Bus connection was disconnected. Aborting.` and left a core at **19:36:08**. The resumed host's PID 1 started at **19:37:02**; neither test driver survived and neither suite had written its completion/exit record. This is not a reproduction of the original WebKit compositor fault. The host reboot's cause is not established by these artifacts.

The Chromium core is retained privately with mode 0600 under `.context/pr-qualification/chromium-host-shutdown.core`, alongside incomplete test logs; it is not exported because process memory can contain credentials. Docker was inactive on the new boot. After confirming process absence, Docker/browser prerequisites were restored and only the interrupted qualification was restarted under `.context/pr-qualification-after-reboot/`. The interrupted run is not counted as a pass.

## Retained artifacts and rule

Raw logs remain under `.context/subagents-continuation/`: `merged-e2e.log`, `webkit-kernel-first.log`, `webkit-diagnostic-matched.log`, `webkit-probe-*.log` and `webkit-probes.txt`. Sanitized full-suite/kernel/probe-result copies are in the downloadable archive indexed by `scripts/subagent-liveness/evidence/README.md`; the historical ledger is `scripts/subagent-liveness/evidence/continuation-2026-09-14.md`.

The passing subagent/Docker/PostgreSQL cases establish their own coverage, not a clean combined release gate. Native browser crashes must retain process/kernel evidence; an isolated passing rerun cannot substitute for a cause and deterministic repair or a justified platform remedy. The invariant remains the no-flake rule in `docs/testing.md`.
