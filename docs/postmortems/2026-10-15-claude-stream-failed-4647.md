# Claude stream failure: 4647f261

2026-10-15, America/Los_Angeles (PDT). Read-only investigation; **initiating exception remains unknown**. No target restart, disk attachment/mount, replay or code fix occurred.

Orb `4647f261-2126-4f20-a61c-51095d222a47`; incarnation 3; VM ID `3743171564653111472`; native session `72e576bd-05f2-4410-a58e-2909afa7c8a6`.

## Evidence

| Time (PDT) | Observed evidence |
| --- | --- |
| 10:13:24.691 | History pull exceeded its 10-second deadline. |
| 10:13:55.722 | Controller initiated `unreachable-restart`, `health_no_answer`, `silent_ms=30899`. Host stop/start followed. This predates the investigation. |
| 10:15:28.571 | Runtime returned to `running`; controller resumed an unanswered user message. |
| 10:35:33.144 | Replicated native tool result acknowledges background Bash task `bkdatc98p`, watching PR 120 checks. Its eventual completion is not in the exported tail. |
| 10:35:36.894 | Last exported record: `claude.handoff_result`, `success`, `isError=false`, `numTurns=4`, `queuedTurns=0`, `stopReason=end_turn`, no pending handoffs. Query `02846c6a-c9dc-4933-a910-d78eed4febea`, operation `88e2d7a7-f5a8-4a83-8c7a-affe7211390a`, result `89500662-fba1-47af-8be0-811db03a21cf`. This is not proof of process exit or absence of later work. |
| 10:56:11.825 | Ops GET reports `stateChangedAt`, `state=failed`, `lastError="runtime_failed: claude_stream_failed: Claude SDK stream failed; retained native state requires inspection."` |
| 10:56:11.827355 | Poller logs `runtime-failed reason=claude_stream_failed incarnation=3`; insert ID `6ad113bb000c9fdba878675b`. This is detection time, not the exception's known occurrence time. |
| 10:56:12.695671 | Compute audit records instance deletion by `pi-orb-control-plane`, after the runtime failure report. |
| 10:56:34.905928 | `compute-discard ... outcome=ok`; insert ID `6ad113d2000dd2c8b382268a`. |

Sources: committed transcript, authenticated GET `/api/v1/orbs/4647f261-2126-4f20-a61c-51095d222a47`, Cloud Logging in `playground-dev-6ae7`, Compute instance/disk/image descriptions. VM logs in the failure window contain shutdown records, not an SDK exception or process-exit diagnosis. No OOM cause is established; absent cloud evidence does not exclude one. The earlier reachability restart's cause and relationship to the later failure are unproven.

## Failure boundary and attribution limits

Instance-create audit identifies boot image `pi-orb-image-v-1f11f218-ee6909cbdebb419b` (image ID `5169336255816503699`, version label `v-1f11f218`). Its labelled source, `1f11f218:apps/orb-runtime/src/claude/agent.ts:1157–1174`, wraps both SDK iteration and `onMessage` in one catch and replaces every exception with the generic message. Current checkout `0d6388c` retains that lossy catch at lines 1194–1206. Image labels are source attribution evidence, not verification of the deleted VM's running files. The orb's separate repository checkout commit is `c7a03d00e250778ed099861afff0723350cca79e`.

**High certainty:** the runtime reported the stream-consumption failure class, and the controller disposed compute in response. **Unknown:** whether the exception originated in the SDK iterator or downstream adapter/listener processing; its message, stack, stderr, exit/signal and precise time. Neither provider failure, CI/Bash failure, query-rotation failure nor the earlier restart is established as the initiating cause. A successful earlier result does not contradict a later stream exception.

## Native inspection blocked

The VM is absent. Detached disk `pi-orb-data-4647f261-2126-4f20-a61c-51095d222a47`, ID `7279540682902199036`, remains `READY`, with no users; last detach 10:56:29.298 PDT. Native evidence was not read.

The announced plan was attachment to the investigation VM in read-only mode, mount `ro,noload` (no journal replay), copy diagnostics, then unmount/detach. GCP denied `compute.instances.attachDisk` on the investigation VM under the existing deployer credential. No attachment occurred. Investigation stopped at the existing IAM boundary; no broader access was requested. No snapshot or writable mount was attempted. Source identifies candidate retained files under `workDir/claude/`: `session.json`, `index.json`, and `config/projects/.../72e576bd-05f2-4410-a58e-2909afa7c8a6.jsonl`; their presence/content is unverified.

## Reproduction of evidence queries

```sh
pi-orb transcript 4647f261-2126-4f20-a61c-51095d222a47 --json
gcloud logging read '(textPayload:"4647f261" OR resource.labels.instance_id="3743171564653111472") AND timestamp>="2026-10-15T17:10:00Z" AND timestamp<="2026-10-15T18:05:00Z"' --project=playground-dev-6ae7 --order=asc --limit=3000 --format=json
```

Private copies and SHA256 manifest: ignored `.context/4647-forensics/`; not durable published artifacts. `lifecycle.jsonl` lines 5–11 retain the earlier outage/recovery; lines 12–13 retain final failure/disposal. Durable log identities and relevant values are recorded above.

Diagnostic invariant: a terminal stream-consumption failure must retain a bounded, credential-redacted cause before compute disposal, without claiming the SDK is necessarily the throw site. Current implementation and limits: `docs/claude-agent-sdk.md`.
