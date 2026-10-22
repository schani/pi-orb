# Name-only project E2E interrupted by Spot preemption

Confirmed 2026-10-22: GCP `compute.instances.preempted`, insert ID `e5n76ud1t3e`.
Guest SIGTERM preceded the WebKit failure marker by **141 ms**; systemd then SIGKILLed the E2E runner.
The original run is **incomplete, not passed**. Its assertion is unavailable; no product fix is claimed.
Historical frozen-source qualification completed separately: **64 files / 460 tests passed**, one PostgreSQL file / two tests skipped. The interrupted case is excluded.

Evidence under `.context/no-repo/`: detailed reproduction in `host-interruption.md`; audit in `host-interruption-cloud.log` (SHA-256 `bc566a4a22b178717ea5c633dca8bdb1bdbbb9cbc57e3c9fd24b2edba4de7af0`); original `e2e-full.log` (`1e90240f738e81360d61eaece1507b98edc5925c975d10472d2fe0a74d18e574`).
Qualification: `project-instructions-first-repro.log`, `e2e-remaining-files.txt`, `e2e-remaining.log`/`.exit`, `source-freeze.sha256`, `source-qualified.log`.
