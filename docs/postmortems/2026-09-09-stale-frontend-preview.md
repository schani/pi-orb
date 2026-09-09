# Stale frontend preview after protocol changes (2026-09-09)

## User-visible failure

The shared frontend-only preview on port 5173 rejected a three-file selection with `invalid_request: invalid file metadata`. The filenames (including spaces and image extensions) were valid. Fresh-instance browser tests and the real-agent upload scenario had passed, but neither exercised that already-running preview process.

## Evidence and cause

The Vite process started at 17:55. Browser HMR subsequently loaded the new batch-upload client. Backend reloads at 18:02 and 18:06 failed with:

```text
The requested module 'file:///workspace/repo/packages/protocol/src/index.ts'
does not provide an export named 'UploadBatchSchema'
server restart failed
```

Vite's internal config reload reused Node's cached external protocol module, which predated that export. The old fixture middleware remained available and expected the earlier single-file request body. Thus the page returned HTTP 200 while its browser and fixture backend spoke different contracts. A batch POST against the live port reproduced the same rejection.

The agent inspected neither these reload failures nor the served upload operation before claiming the preview was updated. An HTTP-root check and tests on fresh, test-owned ports were insufficient evidence.

## Recovery and verification

A full process restart loaded the current protocol exports and fixture middleware. Fixture resources/history were exported before stopping the process. The user's affected orb had no conversation records; it was recreated with the same UUID so their requested URL continued to work. This was not restoration of arbitrary in-memory fixture state.

Chromium then exercised the actual shared service using the tailnet hostname (mapped to localhost inside the validation browser), preserving its insecure HTTP-origin behavior. One picker selection used the reported filenames and sizes with synthetic bytes: a 30,205-byte JPEG name and GIF names of 2,111,762 and 396,423 bytes. All three transfers completed, exactly one inbox notification listed the files, and there were no page errors. The temporary validation orb was deleted afterwards. This verified the served application contract, not network reachability from the user's device or actual image decoding.

Local evidence is retained in `.context/stale-upload-preview/`: pre-restart server log and fixture snapshots, the served-preview smoke script, and its result. No production deployment was involved.

## Resulting rule

After fixture-backend or shared-protocol changes, restart the **whole frontend process**, not merely Vite's internal server. Account for the documented loss of in-memory fixture data. Before sharing or declaring an updated preview ready, inspect startup/reload logs and exercise the changed feature on that exact service; HTTP 200 and fresh-instance E2E results are not substitutes.

Automatic dev-runner restart/fail-closed behavior and its regression coverage are tracked in `TODO.md`. The operational guidance lives in `docs/web-ui.md` and `docs/testing.md`.
