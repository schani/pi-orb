# GitHub skills: two independent CI failures

On 2026-10-28, feature head `f1df6b84` passed eight of ten hosted gates.
[PR 225](https://github.com/schani/pi-orb/pull/225) tracks exact-head qualification; the feature remains undeployed.
[Private evidence archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/f80c5983-861b-49b6-9bb1-6683386edf7c/evidence/github-skills-ci-qualification-f1df6b84.tgz) retains first failures, source comparisons, native probes and local receipts.

## Recovery fixture

[Checks job 123040662790](https://github.com/schani/pi-orb/actions/runs/40751942992/job/123040662790) failed three `.resume-ran` assertions.
The fixture made the managed Claude config directory a symlink. Owner-skill materialization intentionally rejects that parent before resume.
Local RED captured boot health `owner_skills_unavailable`: `Owner skills directory has a symlink or non-directory parent`.
This was not timing or schema drift. Move retained config into the real managed directory; reverse the external observer alias to preserve transcript paths.
All assertions remain unchanged. `ci/recovery-fixture-green.log` records four recovery and four related environment cases passing; root typecheck passed.

## Chromium native crash

[E2E (2/4), job 123040663268](https://github.com/schani/pi-orb/actions/runs/40751943067/job/123040663268) failed with `Target crashed`.
Native evidence identifies SIGABRT at `window_performance.cc:1051`: `CHECK_GE(info.processing_start_time, render_start_time)`,
through `ReportAnimationFrameTimingHistograms` / `TryFlushEventTimingQueue` and the compositor stack.
[Chromium change 02dc6ad8](https://github.com/chromium/chromium/commit/02dc6ad8e710c68e0c5b7517a1d3066065ece04d) contains that exact line;
[revert 158b9c16](https://github.com/chromium/chromium/commit/158b9c164108cdbef03a3e21db318cee80800d42) removed it the next day for crashes ([bug 567391980](https://issues.chromium.org/issues/567391980)).
The original CI binary version was not logged. No precise version, OOM or test-ownership attribution is claimed.
A passing unchanged local `156.0.8078.47` run does not clear the original failure.

**Decision (2026-10-28):** both functional CI workflows select their already-installed lock-bundled Chromium and log its executable path/version.
Export existing `PLAYWRIGHT_CHROMIUM_EXECUTABLE`; alias `/usr/bin/chromium` only on the ephemeral CI runner for hardcoded callers. WebKit is unchanged.
Bundled `156.0.8078.4` source lacks the crashing function/CHECK. A temporary local alias confirmed CDP revision `f842f52ef39fd97b449eb27cff414bf05a98ddce` and intact Event Timing APIs.
Reject `--disable-blink-features=EventTiming`: native probing showed it was ineffective. No launcher helper or dependency changes remain.
`browser-crash-investigation/ci-env-focused-seven.log` / `.exit` record the original failed case plus six owner-settings cases passing (7/7, exit 0).

## Qualification limits

These are focused local receipts, not a hosted pass. First-head failures remain preserved; no rerun cleared them.
Production source, manifests and all E2E helpers remain byte-identical to `f1df6b84`; only the recovery test changes under `apps/` or `packages/`.
