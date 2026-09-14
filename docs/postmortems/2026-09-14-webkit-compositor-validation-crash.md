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

## Retained artifacts and rule

Raw logs remain under `.context/subagents-continuation/`: `merged-e2e.log`, `webkit-kernel-first.log`, `webkit-diagnostic-matched.log`, `webkit-probe-*.log` and `webkit-probes.txt`. Sanitized full-suite/kernel/probe-result copies are in `scripts/subagent-liveness/evidence/`, indexed by `continuation-2026-09-14.md`.

The passing subagent/Docker/PostgreSQL cases establish their own coverage, not a clean combined release gate. Native browser crashes must retain process/kernel evidence; an isolated passing rerun cannot substitute for a cause and deterministic repair or a justified platform remedy. The invariant remains the no-flake rule in `docs/testing.md`.
