# Full frontend qualification failure — WebKit missing-resource transition

Command: `npm run test:e2e:frontend`

Result: 85 passed, 1 failed across 9 files. No rerun.

Failing test: `e2e/transcript-cache-missing.e2e.test.ts:63`

```text
webkit: history 404 retires live ownership even when metadata is still running
expect(page.getByText("Orb doesn't exist", { exact: true })).toBeVisible()
Timeout: 5000ms
Error: element(s) not found
```

Observed before the failed assertion: cached history rendered, metadata enabled the composer, and one live socket existed. The held history request was then released with its configured 404. The expected missing-orb text did not appear within five seconds. Cleanup ran. The Chromium parameter passed; this run provides no screenshot or trace. The cause and any relationship to concurrent full-suite execution or crop-mark changes are unestablished.
