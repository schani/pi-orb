# Image-test CPU contention (2026-10-19; historical attribution unresolved)

## First failure

At `6cd6d79b5f67a0717ccefd0d2c0694e450eb4b29` plus prompt-review WIP,
“bounds deterministic output images” timed out at 30,007 ms and the full
20 MiB callback at 30,033 ms. Retained `tools-focused.log` SHA-256:
`2147a9679e6ddb57cf6f464d1f628eda0fd62ca03d354e93ab6c70c620040193`.
It also contains two metadata assertion failures and no final summary. Its exact
CLI, exit status, termination reason and failure-window CPU schedule are unavailable.
`docs/testing.md` retains source seals and overlapping E2E/Chromium log windows;
those windows do not establish the failed cases’ intervals or cause. PR 137’s
historical timeout exception does not cover these failures.

## Controlled investigation

Private receipts: `/workspace/image-timeout-evidence/`. Runs began at
06:49 America/Los_Angeles on October 19. `00-environment.log`: Linux, two logical
CPUs, Node 24.22.0, npm 11.19.1, source `5b94881a76327cabd98b94d9c27da979af31586c`;
both test files and Vitest config match the first-source seals in `docs/testing.md`.
`01-npm-ci.{log,exit}` records a successful clean install; Vitest is 5.0.5.
No E2E/browser workload ran beside the controlled tests.

- `02` first failed before execution: `/usr/bin/time` was absent (exit127).
  The shell-timed `03` ran the command in `02-command.txt`; all 21 unchanged
  tests passed, with images at 9,828 ms and the full callback at 8,398 ms.
  Its JSON reporter reused `02-unchanged.json`; that JSON belongs to `03`,
  not the failed launcher.
- `04` adds diagnostic-only Worker message/shared-CPU-counter sampling without
  changing test fixtures or deadlines. Both selected cases pass (10,011/8,335 ms).
  Worker CPU totals are about 9.06/6.94 s; guard parking about 0.89/0.97 s.
- `05` separates helper phases over a 27,962,028-character image string.
  Event gaps are about 8.65 s for the interpreted per-character base64 scan,
  0.56 s for an equivalent invalid-character search, and 5.78 s for `image()`.
  These are phase measurements, not final-source qualification. Together with
  the `validBase64` loop in the Pi Codemode patch, they identify avoidable
  interpreted validation work, not a proven historical scheduler cause.
- `06` is an incomplete experiment: the diagnostic driver split `/proc/PID/stat`
  on whitespace and failed on process names containing spaces. Its `finally`
  terminated/waited for its three hogs; owned test process group2051 was explicitly
  terminated (`06-controller-failure.txt`). Its partial passing case is not a
  completed contention result.
- `07` corrects that parser and pins the test process and three ready CPU hogs
  to logical CPU1. Both unchanged selected tests fail at the unchanged 30 s
  deadline: images 30,015 ms, full callback 30,013 ms (exit1; 19 filtered cases).
  `07-phases.jsonl` shows sustained progress near 250 ms worker CPU per wall
  second, with little guard parking (last samples: about 0.44/0.72 s).
  `07-os.jsonl` independently records hog CPU progress and CPU pressure, without
  memory pressure. The driver terminates and joins its owned hogs in `finally`.

## Reproduction

From `/workspace/repo`, after `npm ci`, the unchanged isolated command is:

```sh
npx vitest run apps/control-plane/src/adapters/durable/tools/codemode-sandbox.test.ts apps/control-plane/src/adapters/durable/tools/image-validation.test.ts --maxWorkers=1 --reporter=verbose
```

The controlled contention driver is:

```sh
python3 /workspace/image-timeout-evidence/07-contention.py
```

`07-command.json` preserves exact argv: `taskset -c 1 npx vitest run` with
`--config .context/image-timeout.vitest.mjs`, those same two files,
`--maxWorkers=1`, `--testNamePattern="bounds deterministic output images|preserves every byte"`
and `--reporter=verbose`. The driver launches three Python busy loops pinned
to CPU1, gates on each ready line, and records OS/shared-counter telemetry.
The diagnostic config/setup and microbenchmark are preserved under
`/workspace/image-timeout-evidence/diagnostics/.context/`; copy them back to the
repository’s `.context/` before invoking a diagnostic driver. `04-command.txt`,
`05-command.txt` and `04-vitest.config.mjs` retain their invocation/config.
`07` used the original installed prelude (`09-before-prelude.js`); `12` used the
candidate (`11-candidate-prelude.js`). A current clean install applies the candidate,
not the original scan. The first two named cases retain their fixtures/assertions.

## Disposition

CPU contention is sufficient to reproduce both failures; the original schedule
and CLI remain unknown. Isolation or a green optimized run cannot establish
original attribution or clear the deployment blocker in `TODO.md`.
Preserve full fixtures, 30 s deadlines, byte/store assertions and single-owner
execution with descendant exit before browser/E2E work.

## Causal correction and qualification

The existing Pi Codemode patch now uses `data.search(/[^A-Za-z0-9+/]/)`.
Nonempty/divisible-by-four checks and the original one/two-terminal-padding rule
remain: the first invalid character must be absent or exactly at the known padding
boundary. The search has no quantifier, per-character JavaScript loop or prefix
slice. Whitespace normalization, unused pad bits, signatures, limits, callback
accounting and cancellation are unchanged. This is not a fix for every image OOM.

Tests precede the correction. The ASCII-position/Unicode/NUL/whitespace differential
corpus passes on both implementations. The initial work assertion was wrong:
`08-work-bound-red.log` records 22,376 polls against 1,000; `10-fixed-images.log`
still fails at 11,190. Native regexp scans themselves poll the interrupt handler.
The corrected regression measures the same full-size whitespace/alphabet passes,
allowing only fixed VM overhead above that control, not a wall-time allowance.
An overescaped control in `11`/`16` was corrected; `17-native-work-control-red.log`
then reproduces the final test's RED on the restored original scan:
22,376 versus control 11,190 plus 100. Original malformed-suffix, empty-output and
no-store-write assertions remain.

`12-contention.py` repeats the same CPU1/three-ready-hog experiment: full 20 MiB
callback 14,341 ms, output images 12,341 ms, both passing the original 30 s deadline.
Image-output worker CPU drops from the isolated original's 9.06 s to 2.94 s despite
the contended wall time; its parked total is 0.58 s. This intervention establishes
the scan's causal contribution to the controlled timeouts, not the historical
scheduler conditions.

Final receipts (all commands serialized, no E2E/browser execution):

- `15-npm-ci.{log,exit}`: fresh install applies all four sealed patches; zero
  audit findings.
- `18-command.txt`, `18-focused-guards.{log,exit}`: 60/60 tests in ten files;
  full bytes/MIME/store, media overflow, callback limits, native replay, bounded
  worker, CPU budget/DST, abort/timeout/close and memory contracts.
- `19-installer-tests.{log,exit}`: `node --test scripts/apply-dependency-patches.test.mjs`,
  18/18; `20-idempotence.{log,exit}`: `node scripts/apply-dependency-patches.mjs`,
  all four already applied.
- `21-typecheck.{log,exit}`: `npm run typecheck`, pass.
- `22-lint.{log,exit}`: `npm run lint`, pass (411 warnings, 83 infos).
- `18-source-before.sha256` equals `23-source-after.sha256`; `23-final-environment.log`
  records no owned test/hog descendants, 44 GiB free, no cgroup OOM or quota
  throttling. Temporary diagnostics are archived, not production instrumentation.

Patch SHA-256:
`c365898bfca4c5d111a4739131fcd068c3727863690acc7f97d781310b13a66a`.
Installed prelude SHA-256:
`5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06`.
No persisted-state change, full-suite/E2E/image release qualification, commit,
push or deployment occurred. The complete original hashed log was not recovered
in this workspace; archived transcript excerpts cannot replace its bytes.
