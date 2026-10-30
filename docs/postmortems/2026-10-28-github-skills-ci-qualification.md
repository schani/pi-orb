# GitHub skills CI qualification

[PR 225](https://github.com/schani/pi-orb/pull/225) tracks pending rebased exact-head qualification; the feature is undeployed. The [private first-failure archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/f80c5983-861b-49b6-9bb1-6683386edf7c/evidence/github-skills-ci-qualification-f1df6b84.tgz) preserves `f1df6b84` logs, source comparisons, probes and receipts.

## Recovery fixture

[Checks 123040662790 / run 40751942992](https://github.com/schani/pi-orb/actions/runs/40751942992/job/123040662790) failed three `.resume-ran` assertions: the fixture symlinked managed Claude config. Strict owner-skill policy correctly blocked resume; local RED reported typed `owner_skills_unavailable`: `Owner skills directory has a symlink or non-directory parent`.

Correction: real managed config, reversed external observer alias preserving transcript paths; assertions unchanged. Archive receipt `ci/recovery-fixture-green.log`: four recovery + four environment cases and root typecheck passed.

## Chromium native crash

[E2E 123040663268 / run 40751943067](https://github.com/schani/pi-orb/actions/runs/40751943067/job/123040663268) reported `Target crashed`: SIGABRT, `window_performance.cc:1051`, `CHECK_GE(info.processing_start_time, render_start_time)` through `ReportAnimationFrameTimingHistograms` / `TryFlushEventTimingQueue` and compositor frames.

[Introduction 02dc6ad8](https://github.com/chromium/chromium/commit/02dc6ad8e710c68e0c5b7517a1d3066065ece04d) contains the exact line; [revert 158b9c16](https://github.com/chromium/chromium/commit/158b9c164108cdbef03a3e21db318cee80800d42) cites crashes ([bug 567391980](https://issues.chromium.org/issues/567391980)). Original binary version is **unknown**; no precise-version, OOM or test-ownership attribution. An unchanged local `156.0.8078.47` pass does not clear it.

**Decision (2026-10-28; now on main):** functional CI selects lock-pinned managed Chromium, logs executable/version and exports `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; ephemeral runner `/usr/bin/chromium` aliases support hardcoded callers. WebKit and Event Timing APIs remain unchanged. Reject `--disable-blink-features=EventTiming`: native probing found it ineffective. Bundled `156.0.8078.4` lacks the CHECK; local CDP revision `f842f52ef39fd97b449eb27cff414bf05a98ddce` retained APIs. Archive `browser-crash-investigation/ci-env-focused-seven.log` / `.exit`: original case + six Settings cases passed, exit 0—not hosted qualification.

## Later first failures and receipt limits

At `8e7b1a28`, [Checks 123058693881 / run 40757059364](https://github.com/schani/pi-orb/actions/runs/40757059364/job/123058693881) failed a stale browser-install Python assertion. [E2E 123058694592 / run 40757059371](https://github.com/schani/pi-orb/actions/runs/40757059371/job/123058694592) hit Node 24 `jit_page.has_value()`. Raw receipts: `.context/pr225-failures-8e7/RECEIPT.md`. Browser correction and Node 26 are on main via PR 227; Node source-family evidence, unproven exact-race attribution and archived first failure remain in `docs/postmortems/2026-10-28-node-wasm-wrapper-lifetime.md`.

Local first failures/manifests remain in `.context/github-skills-minimal/qualification/` and its parent, including the exact missing-ref 422 body. A host-interrupted run is neither pass nor assertion failure; no cause/fix is claimed. Read-only NASA acquisition pinned `d14a8e525c6708b5f481661f483aab52b06def02`: 22 files, 2,423,810 decoded bytes, 3,230,256 snapshot JSON bytes; no owner-store writes. Local suite totals: `docs/testing.md`.
