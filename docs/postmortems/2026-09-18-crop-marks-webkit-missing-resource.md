# Crop-mark frontend qualification: WebKit missing-resource first failure (2026-09-18)

First-failure record, moved from the former `test-failures/` ledger. Investigation and correction: `docs/postmortems/2026-09-18-webkit-missing-resource-race.md`.

Command: `npm run test:e2e:frontend`. Result: 85 passed, 1 failed across 9 files. No rerun.

Failing test: `e2e/transcript-cache-missing.e2e.test.ts:63`

```text
webkit: history 404 retires live ownership even when metadata is still running
expect(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible()
Timeout: 5000ms
Error: element(s) not found
```

Before the failed assertion: cached history rendered, metadata enabled the composer, and one live socket existed. The held history request was then released with its configured 404. The missing-orb text did not appear within five seconds. Cleanup ran. The Chromium parameter passed; the run has no screenshot or trace.

The run did not establish route entry or browser receipt of the 404, so its exact cause is unknowable from this evidence. Investigation found and fixed a compatible stale-poll resurrection race with deterministic reducer coverage; nothing links the failure to crop-mark rendering.
