# Token usage — first-failure evidence

Full studies, logs and diagnostics are preserved at [37126d2](https://github.com/schani/pi-orb/tree/37126d231f22304ec8c7adb127161f925a5cf80a/test-failures), retained by `archive/token-usage-evidence-2026-10-13`. Design alternatives remain linked in `docs/model-usage.md`.

Tests failed before implementation: missing protocol/service/read exports, unrecognized `/usage`, and missing Trend access.

Corrections, without weakened assertions or larger timeouts:

- SQL `uuid = text`: cast the owner-scoped project join to text. No migration.
- Missing clock-fixture buckets: recording stamps inside the asynchronous transaction; await `ledger.drain()` before advancing the mocked clock.
- Calendar expectation: Dec 1 → Nov 1, 2026 at 10am Pacific spans 720 hours, yielding 120 six-hour buckets, not 121. The recorded calendar replay is preserved. Civil-day tests cover 23/25-hour transitions; no determined simulation failed.
- WebKit label targeting: saved DOM bounds/hits showed the target center correctly hits Cache read. Move to that center; retain exact isolation/tooltip assertions.
- Failed canvas: explicitly hide `[hidden]` despite the base `display: block`, retaining its mount target for recovery.
- Large counters: compact summaries; exact shared chart tooltip values remain unchanged.
- Filters reset on period replacement: lift selection state out of the keyed request child.
- Icon style test: match the new button/anchor selector list; retain the 20px assertion.
- Mock frontend: correct an undefined fixture-origin variable, then provide validated seeded data instead of the missing route.
- Phone key: correct presence-only attribute decoding. This exposed a stale Output highlight after six-line replacement; reset shared highlight state per mount. Require one current selected key and matching plot isolation.
- Cached input: rename the presentation label, retaining counts and API fields.
- Rebase onto `1a5ce96`: inherited image-viewer tests used undeclared ambient `getComputedStyle`. Use the evaluated element's window; keep both outline assertions. The same base failed [CI](https://github.com/schani/pi-orb/actions/runs/38439785390).

Local validation: focused web/protocol/control-plane tests; PGlite and real PostgreSQL ledger contracts; Chromium/WebKit usage/transcript charts; live mocked frontend; root typecheck/lint. Hosted CI qualification is recorded on the PR. No deployment is claimed.
