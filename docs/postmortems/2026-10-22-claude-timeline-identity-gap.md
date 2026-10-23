# Claude timeline identity gap

2026-10-22, America/Los_Angeles (PDT). Historical diagnosis; approved correction implemented locally on 2026-10-23 PDT, with scoped qualification below. No target restart, replay or deployment.

Orb `a1eea905-5bae-477f-b8e8-bc4730690210`, incarnation 0; GCE instance `6166242124207975524`, `us-central1-a`.

## Evidence

| Time (PDT) | Observation |
| --- | --- |
| 21:01:31.054 | `running` → `stopping`, reason `idle_for_900s`; drain reported `idle_stop_prepared=true`. |
| 21:01:49.726 | Host stop completed; orb `stopped`. |
| 21:37:52.163 | Queued message requested wake; `starting` followed. This was an idle-stop wake, not evidence of preemption. |
| 21:38:56.463 | `running`, reason `runtime_ready`; `turn-resume outcome=notified_restart`. |
| 21:38:58.863 | Queued message dispatched as steering. |
| 21:39:06.760–10.124 | Five hosting POSTs returned HTTP 201: four fonts and `transcript-timeline/index.html`. HTML catalog commit: 21:39:10.711, 75,018 bytes. |
| 21:39:10.019 | Reconciler retry: `Claude session is not accepting work.` |
| 21:39:16.141 | Ops GET `stateChangedAt`; `state=failed`, `lastError=runtime_failed: claude_stream_identity_gap`. |
| 21:39:16.144 | Durable `runtime-failed` lifecycle edge retained the correlation diagnostic below. |
| 21:39:16.836 | Guest `runtime_health_failed`; `healthFailure=failed`, not a health timeout. |
| 21:39:17.167 | Control-plane service account requested instance deletion. |
| 21:39:19.178 | Guest `runtime_child_exited`, exit 0, `requestedStop=true`: shutdown after failure detection. |
| 21:39:33.536 | `compute-discard outcome=ok`; last boot evidence was `runtime ready`. |

Failure diagnostic:

```json
{"liveBlocks":1,"published":342,"nativeLength":342,"blocks":[{"id":"1f23ddac-9fb0-42dd-a3dc-2deaefc3a83a:0","ownerCount":0,"owners":[]}],"omittedBlocks":0,"firstUnpublished":null}
```

One streamed block had no native assistant-message owner. No indexed native records remained unpublished at this check. Current `apps/orb-runtime/src/claude/agent.ts` fails `drainOperationOwned` when blocks remain or published/native counts differ after extension close and history flush. Assistant UUIDs assign streamed blocks to `messageBlocks`; native assistant IDs retire them during publication. This identifies the failed invariant, not the initiating SDK/event interleaving or the deleted VM's exact implementation. Data loss, failed uploads and a VM crash are not established.

Authenticated hosted-file GET confirms all five catalog entries and `cleanupIssues: []`. The HTML is published despite the missing tool result/link in the conversation:

https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/a1eea905-5bae-477f-b8e8-bc4730690210/transcript-timeline/index.html

## Read-only evidence queries

```sh
PI_ORB_APP_ORIGIN=https://pi-orb-issuer-1077475695242.us-central1.run.app infra/api.sh /api/v1/orbs/a1eea905-5bae-477f-b8e8-bc4730690210
PI_ORB_APP_ORIGIN=https://pi-orb-issuer-1077475695242.us-central1.run.app infra/api.sh /api/v1/orbs/a1eea905-5bae-477f-b8e8-bc4730690210/hosted-files
gcloud logging read 'textPayload:"a1eea905" AND timestamp>="2026-10-23T04:00:00Z" AND timestamp<="2026-10-23T04:40:00Z"' --project=playground-dev-6ae7 --order=asc --limit=200 --format='value(timestamp,textPayload)'
gcloud logging read 'resource.labels.instance_id="6166242124207975524" AND logName="projects/playground-dev-6ae7/logs/pi-orb-boot" AND timestamp>="2026-10-23T04:38:00Z" AND timestamp<="2026-10-23T04:40:00Z"' --project=playground-dev-6ae7 --order=asc --limit=100 --format=json
gcloud logging read 'httpRequest.requestUrl:"/runtime/v1/hosting/files" AND timestamp>="2026-10-23T04:39:06Z" AND timestamp<="2026-10-23T04:39:12Z"' --project=playground-dev-6ae7 --order=asc --limit=100 --format='value(timestamp,httpRequest.requestMethod,httpRequest.requestUrl,httpRequest.status)'
```

The hosting request query is time/path correlation, not orb authentication attribution; the per-orb catalog supplies that confirmation. The VM is absent; no retained-disk attachment or guest forensic recovery was attempted.

## Experiments (2026-10-23 PDT)

Pinned SDK 0.3.300 / CLI 2.1.300, isolated deterministic native probe: `priority:now` interrupts unfinished thinking with `content_block_stop` → `message_stop`, no assistant, then `result` with `terminal_reason=aborted_streaming`, `subtype=error_during_execution`, `is_error=true`. The queued steer subsequently succeeds. Before correction, production-adapter replay of genuine native output deterministically fails `claude_stream_identity_gap`; this alone is not live native/production composition qualification. Text interruption instead emits an aborted assistant with ordinary UUID correlation, needing no special clearing. A later native tool→thinking probe also returns explicit `terminal_reason=aborted_streaming` with `success` / `is_error=false`; the error triple is therefore not a necessary condition.

Evidence under `.context/claude-stream-identity/`: `thinking.json`, `response.json`, `probe-events.log`, `boot-thinking-events.log`, `regression.patch`, `red-publication.log`, `red-native-precise.log`, `pinned-source.json`, `public-contract.txt`, `baseline-focused.log` (11 restored-baseline tests pass). This establishes a sufficient mechanism, not the deleted VM's sequence; the original attribution limit stands.

Boot-policy probes separately show execution identity alone selects involuntary wording, and settled restart triggers unsolicited inference. Pinned `shouldQuery:false` + `isSynthetic` appends context with zero provider calls; metadata reopen remains at zero, then a later human input makes one call with context and the same boot UUID retained. Its zero-turn success is not inference. A standalone same-query FIFO probe qualifies the zero-turn acknowledgement before the human result; subsequent adapter integration and DST pass within the local scope below.

Evidence under `.context/boot-notice-investigation/`: `boot-policy-red.patch`, `boot-policy-red.log`, `boot-context-probe.log`, `should-query-probe.mjs`, `baseline.log` (25 pass after restoring tests).

## Decision (2026-10-23 PDT; implemented locally, undeployed)

Reuse an existing result-error or steering-result event plus volatile proof for interrupted-thinking `history.record.retiredBlockIds` publication after commit. Require explicit `aborted_streaming`: `error_during_execution` / `is_error=true`, or `success` / `is_error=false` with an accepted pending steer. Proof binds query, accepted input, response, block/message stops and native predecessor; response input echoes are immutable. Authoritative scans validate the accepted input's durable receipt, prior assistant owners and absence of a current native owner. Unknown, text, redacted or owned output and missing/conflicting proof remain fail closed.

Native journal writes can lag SDK stdout, even result-event publication. Stage proof in memory; after scan validation, the existing late-binding loop can re-emit the existing `claude.result_error` or `claude.steering_result` with retirement IDs. Blocks remain live until publication. Durable result errors retain visible interruption. Proof is not persisted. Extra persisted `terminalReason` / `retiredBlockIds` overflow metadata was rejected as unnecessary; schemas and record types are unchanged.

Approved neutral wording and passive settled-restart behavior use existing markers/boot receipt provenance, with all unreceived contexts FIFO as `shouldQuery:false`, `isSynthetic` before the next legitimate input. Existing input correlation links native receipt to marker; no new persisted fields. Passive context is metadata, not resume authority; its zero-turn acknowledgement must not retire an active human operation. Missing passive receipts and mixed acknowledgements fail closed. Settled restart starts no unsolicited inference; interrupted human/tool resumes and scheduled `sleep_wake` remain triggering.

Decision details: `docs/claude-agent-sdk.md`; remaining qualification: `TODO.md`.

## Local qualification (2026-10-23 PDT)

Final local source:

- `npx vitest run apps/orb-runtime/src/claude --maxWorkers=1`: 521 tests / 56 files pass, including native contracts, admitted replay/live composition and DST (`.context/timeline-fixes/claude-suite-final.log`). Live composition feeds genuine native output/journal increments through the injected SDK queue, not the production subprocess spawner.
- `npm run typecheck`: all pass (`.context/timeline-fixes/typecheck-all-final.log`).
- `npm run lint`: exit 0, existing repository warnings (447) and infos (84); changed-file scoped lint clean (`.context/timeline-fixes/lint-all.log`).

The original process full-slice run passed 4/4 in 527.40s; it was not rerun:

```sh
PI_ORB_E2E_BACKEND=process PI_ORB_LOCAL_FAKE_EVIDENCE=.context/timeline-fixes/e2e-local node scripts/local-fake-provider.mjs -- npm run test:e2e -- --project=lifecycle e2e/full-slice.e2e.test.ts
```

Log: `.context/timeline-fixes/e2e-full-slice.log`. The code-mode caller hit its 300s deadline and cancelled the supervisor; detached original Vitest and fake-provider processes remained. That same Vitest completed all assertions and cleaned control-plane fixtures in `afterAll`. The residual exact-owned fake-provider process group `10800` was explicitly stopped; ports `3210`, `5173` and `7144` were verified clear. Supervisor final manifest/exit receipt is unavailable. This is neither an assertion failure nor a passing rerun, and does not establish completed local-fake supervision qualification. Evidence: `.context/timeline-fixes/e2e-local/supervision.txt` and `provider.log` in that directory.

First failures, journal-lag diagnosis, negative regressions and mutation evidence remain in `.context/timeline-fixes/stream-summary.md` and its linked logs/traces. The eager-only mutation trace `test-failures/claude-interrupted-thinking-error-late-true-1792761553860-0.json` was replayed before restoring the implementation; restored replay passes. Scenario-assumption traces were replayed before correction. No passing rerun substitutes for those corrections.

The entire E2E suite, CI, Docker and live subscription qualification were not run. No commit, deployment or target restart/replay. These local results establish neither the deleted VM's exact source nor its initiating sequence; both remain unknown.
