# Subagent headline E2E observer order (2026-10-13)

`'chromium': activity headlines 'subagent headers'` (added in #86) failed with `held roster-one` in [E2E 38408174503](https://github.com/schani/pi-orb/actions/runs/38408174503), [E2E 38421014601](https://github.com/schani/pi-orb/actions/runs/38421014601) (blocking deployment of `eda7170`) and [E2E 38430183818](https://github.com/schani/pi-orb/actions/runs/38430183818). First-failure log: `.context/e2e-38421014601/shard1.log`.

**Cause:** each roster row owns an `IntersectionObserver`; opening the rail makes all three intersect in one frame, and `HeadlineLimiter` queues them in callback order. Chromium delivers separate observers in no fixed order. The test assumed `roster-one`, `roster-two`, `roster-three`. Instrumented local reproduction: 6 of 12 runs requested `roster-two`/`roster-three` before `roster-one`. WebKit never failed.

**Fix:** the test releases rows in observed request order and asserts the set, the two-request cap and that Retry re-requests the failed row. Product order among simultaneously visible rows carries no user-visible meaning, so it stays unconstrained. Validation: 20/20 Chromium reruns; the whole file passed 12/12 on Chromium and WebKit.
