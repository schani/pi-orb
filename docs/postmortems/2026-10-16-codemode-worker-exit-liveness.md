# Codemode termination lost physical-exit liveness

## Evidence (2026-10-16)

The offline-image CI failure (job `117277011009`) and unchanged bare-Node full proof `219` exited 13 before final PASS. The earlier `218` stdin setup failure is a different failure, not evidence of this cause. Diagnostic `220` localized the pending second native execution; it did not identify the producer.

`221` ran on Node 24.22.0 at 19:21:09–20 PDT. Its 45 ordered observations have zero drops/observation failures and no shadows. Admission22 succeeded for Run2/task25/call `image-proof-2`, conversation1:

1. Worker2/thread2 started, emitted output, then done (seq35–36).
2. SDK `host.js:60` requested termination through `Execution.finish` (seq37).
3. Node automatically referenced that terminating Worker (seq38).
4. SDK `host.js:62` explicitly unreferenced it (seq39).
5. Original close entered and returned; mandatory physical-exit drain entered (seq40–43). A returned Promise handle does not mean drain settled.
6. At beforeExit, `run.finished` was true, Worker2 had no physical-exit event, outer execute25/wait22 remained pending, and `activeResources` was empty (seq45). Node exited 13 on the store-readback run's top-level await.

Control Run1/task12/Worker1 took the same terminate/ref/unref path but physically exited at seq22; original execute returned and the first full 20 MiB image/equality/MIME assertions passed. Native done and a termination request do not establish physical exit. This is worker-reference ownership, not failed admission, model activation, resume, or an unfinished script.

First evidence: `/tmp/pi13-image-proof-lifetime221-result.md`, `/tmp/pi-upgrade-logs/221-first-public-lifetime-image-proof-diagnostic.log` and `.exit`, plus `/tmp/pi13-image-proof-lifetime221-evidence/` (`stderr.log`, `stdout.log`, `exit-code.txt`, input and archived diagnostic). Source inventories matched before/after the diagnostic; source/SDK files were untouched. Preserve `219`/`220` and CI evidence independently. No new DST trace was produced.

## Decision and source correction (2026-10-16)

Retain the native Worker's termination reference until physical exit. In the existing sealed codemode 1.3.0 patch, delete only the post-terminate `worker.unref()` and its comment. Keep terminate/catch, shared interrupt, asynchronous request-only stop, actual-exit hooks, admission and resource release intact. First-party close and drained remain awaited. No timer, artificial keepalive, ref monkeypatch, retry, new configuration, cleanup bypass or limit increase substitutes for ownership.

Apply one revised patch directly from pristine upstream to the final bytes; no seventh patch, overlapping-stage projection or acceptance of the old installed intermediate state. The existing installer algorithm and root/control-plane/standalone scopes remain six/five/four. The other five patches, subagents archive, manifests, locks, versions and control-plane Docker COPY inputs are unchanged. That correction changed no persisted state/schema or saved-value policy; Q81 was then human-open and PR 140 Draft. The later user-approved no-carryover decision is recorded in `docs/open-questions.md`, question 81; PR 140 remains Draft.

Existing durable `codemode.resource_failed` identity/peak edges and user-visible terminal errors remain authoritative; required drain errors must not be suppressed. Retained proof logs, task identities, actual process status and release seals diagnose this failure. No healthy-worker log stream or persisted diagnostic schema is added.

## Qualification boundary

Owner seal preparation reversed the exact old patch from a copied installed package, verified all four pristine upstream file seals, and applied the revised whole patch. Patch SHA-256 is `d4d7e968a23054b75e25603cc66906492ba8a2d2710a0cbbb5896bd56f0fa42a`; host output SHA-256 is `e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076`. Other codemode output seals and the other five patches are unchanged. Fresh candidate-root `npm ci` (222) applied all six patches, added 604 packages and audited 612 packages with zero vulnerabilities, and verified the seals. Old installed intermediate bytes deliberately fail closed; reinstall rather than accepting them.

At 19:44:50–19:45:00 PDT, FIRST post-fix proof `223` executed the unchanged full script (SHA-256 `af83430d07f1b48e1ba207dfc9902fbb90b5b2ff06a9f7a5298bfc59df296256`) as a Node 24.22.0 FILE with empty CLI flags and no observer/keepalive. All four distinct native tasks completed: full 20 MiB image equality/MIME, saved-value readback, callback8/overflow9 with exact error, failed-store rollback, final `status:PASS` and exit0. Image SHA-256: `92950fcaa13b820712e50c8f942135234edd97812c50c23df7ccf724c78cdb85`. Evidence: `/tmp/pi13-worker-exit-full-proof223-result.md` and its first raw/exit artifacts. Run2 done alone was not accepted; no regex, fake worker or test-runner lifetime substituted for this real regression.

Local full-proof success does not qualify the control-plane-only image graph. A newly built future-head Docker image must also execute the unchanged proof with `--network none`, with normal exact-head CI/E2E gates. Future-head image/CI qualification remains pending; Bun shutdown behavior is unqualified. No all-green, ready, merge, deployment, historical OOM/CPU/429 fix or historical-failure waiver is claimed.
