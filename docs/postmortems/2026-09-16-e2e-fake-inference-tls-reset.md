# E2E lost to an undeadlined fake-inference TLS reset — 2026-09-16

GitHub E2E run [35150527628](https://github.com/schani/pi-orb/actions/runs/35150527628)
on PR 47 (`fix/terminal-shade-scrollend`, a test-only change to an unrelated
frontend test, which passed) failed in `e2e/full-slice.e2e.test.ts`, case "runs
login, a scripted tool round trip, replication, and drain". At 21:16:20 UTC the
test's own diagnostic dump printed:

```text
=== original failure === [TypeError: fetch failed] {
  [cause]: Error: read ECONNRESET at TLSWrap.onStreamRead ...
}
```

## Evidence

The stack contains no test frame: the rejection came from `fetch` itself, not
from an assertion. The only TLS endpoint the test process contacts is the hosted
mock inference service `FAKE_ORIGIN` (`https://fake-openai.flingit.run`), reached
through `createFakeSession`, `fakeControl` and `deleteFakeSession` in
`e2e/harness.ts`. Every one of those used bare `fetch`: no deadline, no transport
retry, and an error that named neither the method nor the path — which is why the
failure line identifies nothing but the word `fetch`.

The dump then continued into `fakeControl(fake.sessionKey, "/requests")`, another
undeadlined call to the same host. The log ends after the control-plane tail. The
E2E step ran 21:13:15–21:36:22 UTC and was killed by the job's 30-minute
`timeout-minutes` (`.github/workflows/e2e.yml`). vitest never printed a summary,
so the truncated dump is all the first-failure evidence that exists: how many
cases had passed, and whether the run would otherwise have been green, cannot be
recovered.

The service answered HTTP 200 in 0.38 s when probed afterwards; the reset was
transient. Successful runs of the same workflow that day took 1420–1454 s of
tests plus roughly six minutes of setup, so the job already ran within about a
minute of its budget before anything hung.

Five other E2E failures on `main` that day have different signatures (unrelated
frontend flakes) and are not part of this incident.

## Cause

Harness isolation, not a product defect. A transient transport failure from an
external dependency reached the test as an unretried, unnamed rejection, and the
failure path made a second unbounded call to the same dependency, so the hang
consumed the remaining job budget and destroyed the evidence.

## Fix

`e2e/harness.ts` routes every request to `FAKE_ORIGIN` through one helper,
`fakeRequest(method, path, options)`:

- a 15 s per-request deadline via `AbortSignal.timeout`, applied to every call
  including the swallow-everything `deleteFakeSession`, so no test body and no
  diagnostic dump can wait on that host indefinitely;
- transport failures only — fetch rejecting, including the deadline abort — are
  retried, three attempts with 250/500 ms backoff. A returned HTTP response is
  never retried, whatever its status: only a request that did not arrive is
  transient;
- failure throws an error naming method, path and attempt count, with the
  transport error attached as `cause`.

Retry is enabled per call, by replay safety. `createFakeSession`
(`POST /api/__mock__/sessions`) retries: a lost response leaks one unreferenced
mock session, which costs no more than the per-test sessions already created and
deleted. `fakeControl` retries its GETs (`/requests` and the other reads).
`fakeControl`'s only write, `POST /deviceauth/approve`, does not retry: the mock
service is deployed from outside this repository, so nothing here establishes
that approving a consumed user code succeeds rather than returning 4xx, and a
retry after a lost response could turn a transient reset into a spurious HTTP
failure. It gets the deadline alone.

`e2e/harness.unit.test.ts` covers the helper with a stubbed fetch: two rejections
then success, exhaustion naming the call, an HTTP 500 that is not retried,
retry-off leaving one attempt, and a hung request aborted at an overridden
deadline. It runs in the root unit suite via the `e2e/**/*.unit.test.ts` include
in `vitest.config.ts`; `*.e2e.test.ts` stays in the Docker config.

## What remains

The job still runs within about a minute of its 30-minute `timeout-minutes` on a
good day. Deadlining the mock calls removes the known unbounded wait, but any
other hang — a wedged control plane answering `api()`, a stuck browser fixture —
still exhausts the budget and again costs the vitest summary. Whether to raise
the budget or split the job is tracked in `TODO.md`.
