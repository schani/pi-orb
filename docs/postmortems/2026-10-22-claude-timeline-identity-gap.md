# Claude timeline identity gap

2026-10-22, America/Los_Angeles (PDT). Orb `a1eea905-5bae-477f-b8e8-bc4730690210`, incarnation 0; GCE instance `6166242124207975524`, `us-central1-a`. No target restart, replay or deployment.

## Evidence

| Time (PDT) | Observation |
| --- | --- |
| 21:01:31.054 | `running` → `stopping`, `idle_for_900s`; `idle_stop_prepared=true`. |
| 21:01:49.726 | Host stopped. |
| 21:37:52.163 | Queued message requested wake; `starting`. Idle-stop wake, not evidence of preemption. |
| 21:38:56.463 | `running`, `runtime_ready`; `turn-resume outcome=notified_restart`. |
| 21:38:58.863 | Queued message dispatched as steering. |
| 21:39:06.760–10.124 | Five hosting POSTs returned 201: four fonts and `transcript-timeline/index.html`. HTML catalog commit: 21:39:10.711, 75,018 bytes. |
| 21:39:10.019 | Reconciler retry: `Claude session is not accepting work.` |
| 21:39:16.141–.144 | Ops GET: `failed`, `lastError=runtime_failed: claude_stream_identity_gap`; durable `runtime-failed` edge retained the diagnostic below. |
| 21:39:16.836 | Guest `runtime_health_failed`, `healthFailure=failed`; not a timeout. |
| 21:39:17.167 | Control-plane service account requested instance deletion. |
| 21:39:19.178 | Guest `runtime_child_exited`, exit 0, `requestedStop=true`; shutdown followed failure detection. |
| 21:39:33.536 | `compute-discard outcome=ok`; last boot evidence was `runtime ready`. |

```json
{"liveBlocks":1,"published":342,"nativeLength":342,"blocks":[{"id":"1f23ddac-9fb0-42dd-a3dc-2deaefc3a83a:0","ownerCount":0,"owners":[]}],"omittedBlocks":0,"firstUnpublished":null}
```

One streamed block lacked a native assistant owner; no indexed native records remained unpublished. Terminal drain requires both stream correlation and complete history publication. Only exact durable assistant UUIDs own/retire streamed blocks; this invariant is unchanged. The initiating SDK/event sequence and deleted VM's exact implementation remain unknown; data loss, failed uploads and a VM crash are not established. The VM is absent; no retained-disk/guest recovery was attempted.

Authenticated hosted-file GET confirms all five entries and `cleanupIssues: []`. The HTML was published despite the missing conversational tool result/link:
https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/a1eea905-5bae-477f-b8e8-bc4730690210/transcript-timeline/index.html

## Read-only evidence queries

```sh
PI_ORB_APP_ORIGIN=https://pi-orb-issuer-1077475695242.us-central1.run.app infra/api.sh /api/v1/orbs/a1eea905-5bae-477f-b8e8-bc4730690210
PI_ORB_APP_ORIGIN=https://pi-orb-issuer-1077475695242.us-central1.run.app infra/api.sh /api/v1/orbs/a1eea905-5bae-477f-b8e8-bc4730690210/hosted-files
gcloud logging read 'textPayload:"a1eea905" AND timestamp>="2026-10-23T04:00:00Z" AND timestamp<="2026-10-23T04:40:00Z"' --project=playground-dev-6ae7 --order=asc --limit=200 --format='value(timestamp,textPayload)'
gcloud logging read 'resource.labels.instance_id="6166242124207975524" AND logName="projects/playground-dev-6ae7/logs/pi-orb-boot" AND timestamp>="2026-10-23T04:38:00Z" AND timestamp<="2026-10-23T04:40:00Z"' --project=playground-dev-6ae7 --order=asc --limit=100 --format=json
gcloud logging read 'httpRequest.requestUrl:"/runtime/v1/hosting/files" AND timestamp>="2026-10-23T04:39:06Z" AND timestamp<="2026-10-23T04:39:12Z"' --project=playground-dev-6ae7 --order=asc --limit=100 --format='value(timestamp,httpRequest.requestMethod,httpRequest.requestUrl,httpRequest.status)'
```

Hosting logs correlate time/path, not orb authentication; the per-orb catalog supplies that confirmation.

## Experiments and decision (2026-10-23 PDT; local, undeployed)

Pinned SDK 0.3.300 / CLI 2.1.300 steering stops unfinished thinking with `content_block_stop` → `message_stop`, no assistant, then `terminal_reason=aborted_streaming`; both error and success results occur. Production-adapter replay reproduced the gap before correction. Text interruption emits an aborted assistant with ordinary UUID retirement. This establishes a sufficient mechanism, not the incident's sequence. Original native/RED evidence: `.context/claude-stream-identity/`. Boot probes showed identity-based involuntary wording and unsolicited settled inference; `shouldQuery:false` + `isSynthetic` produced zero calls through append/reopen, then one human call containing context. Evidence: `.context/boot-notice-investigation/`.

The simplified decision captures current unowned, nonredacted reasoning IDs in one volatile set on exact `aborted_streaming`. After supervised native exit/stdout/iteration/hook drain, remove only still-unowned reasoning candidates before final history flush; `operation_finished` clears browser state. Older orphans, text, redacted/owned output and unpublished history remain fail closed. Native journal lag is covered by final drain, not per-response/input/predecessor proof or event ownership/republication; that larger design was rejected as unnecessary for ephemeral UI state. Approved neutral restart wording and passive settled context use existing marker/receipt FIFO. Zero-turn success is skipped only for nonempty IDs entirely in the volatile set of contexts actually enqueued in this query; ACK classification does not wait for lagging receipts. Interrupted work and sleep behavior are unchanged. Details: `docs/claude-agent-sdk.md`.

## Local qualification of the simplification

`npx vitest run apps/orb-runtime/src/claude packages/native-image/src/claude-workload.test.ts --maxWorkers=1`: 478 tests / 54 files pass; full-project typecheck and changed-file lint pass. Evidence: `.context/pr177-simplify/final-tests.log`, `final-typecheck.log`, `lint-changed.log`. The existing sealed native acceptance verifies passive restart, next-input context, receipt retention and automatic interrupted-work recovery; no separate passive probe is needed.

[Prior-head CI 39963865119](https://github.com/schani/pi-orb/actions/runs/39963865119) failed deterministically because acceptance still expected settled-restart inference. Its two failures were reproduced before updating that expectation, retaining cleanup and recovery assertions (`.context/pr177-original/ci-checks-failed.log`, `.context/pr177-simplify/native-acceptance-first-red.log`). Full CI/release qualification remains pending; no deployment or target restart.

## Historical qualification only

Commit `d8c2f198` records the superseded proof implementation and its 521-test local pass, not qualification of this simplification. First failures, journal-lag evidence, mutation and replayed DST traces remain in `.context/timeline-fixes/stream-summary.md` and its linked logs; trace files are retained. The original process full-slice assertions passed 4/4, but the caller cancelled its supervisor at 300s; detached Vitest completed fixture cleanup, the residual owned provider group was stopped and ports verified clear. No final supervisor receipt exists (`.context/timeline-fixes/e2e-local/supervision.txt`, `provider.log`); this does not qualify local-fake supervision. Remaining release qualification lives in `TODO.md`.
