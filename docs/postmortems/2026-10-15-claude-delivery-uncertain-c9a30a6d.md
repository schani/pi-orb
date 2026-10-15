# Claude steering receipt failure: c9a30a6d

2026-10-15, America/Los_Angeles (PDT). **Root cause established by authorized read-only disk inspection: mid-turn steering receipt normalization drops native consumption identity.** No target restart, replay, repair, production code change or deployment.

Orb `c9a30a6d-afb3-4a51-a979-335ae7ac389e`; native session `37bd751f-1e28-4848-9416-9623480e4020`; native CLI records report `2.1.300`. Both incarnation VMs are absent. Detached workspace disk `pi-orb-data-c9a30a6d-afb3-4a51-a979-335ae7ac389e`, ID `6171680811230466435`, remains `READY`, without users.

## Evidence timeline

| Time (PDT) | Evidence |
| --- | --- |
| 12:54:19.115 | Orb created with Claude harness. |
| 13:12:12.935–15:05:16.339 | Five controller-initiated unreachable-runtime stop/start cycles; each recovered. Last restart decision 15:03:30.043, `health_no_answer`, `silent_ms=33369`. Their initiating causes are unknown. |
| 15:23:01.749 | Human inbox message `394adec7-bbde-4d98-bb11-dd90c7165e4d`: “And in the top right there should only be a \"go to dashboard\" button.” |
| 15:23:02.532 | `message-batch-dispatched`, `delivery=steer`. Inbox API associates operation `34517c36-97c0-4352-8567-ef821f8e48ad`. |
| 15:23:15.426 | Assistant record `a78cc97b-f802-4b64-b5bc-c4f87220c8c6` explicitly says it is replacing the account header with that button. This supports consumption, not a durable receipt. |
| 15:23:33.466 | Delivery retry exceeds its 10-second deadline. Further delivery/history deadlines occur before failure. |
| 15:26:20.146 | Assistant reports the dashboard header renders. |
| 15:27:47.342 | Bash result `6d51fc96-86ca-453e-a9e8-f9b79ef1f55b` reports successful HTML publication. Independent hosted-file inventory retains `analyst-onboarding-redesigns-v4.html`, 1,606,880 bytes, updated 15:27:47.251. |
| 15:28:03.452 | Last replicated tool result: Read of `/workspace/home/ao-export/v4-m6.png`. |
| 15:28:03.639 | Last replicated API-request event, raw native line 1300. Replica ends at native line 1304 (zero-based source index 1303); later metadata timestamps are not chronological progress. |
| 15:28:15.555 | Retained, unreplicated final reply `4416551b-b3da-4b1e-ab33-0d8f0550fb74` confirms the header change and links the published HTML; `stop_reason=end_turn`. |
| 15:28:53.683 / 54.281 | Local index records steering input answered, then a successful 17-turn handoff result; neither final diagnostic is in the exported replica. |
| 15:28:56.966 | `unreachable-restart-deferred reason=runtime_answered_corroboration`: no restart taken on this edge. |
| 15:29:05.334 | First `runtime-failed`: `claude_delivery_uncertain`, “Claude exited without a durable native input receipt; the accepted message requires inspection.” Incarnation 0. Insert ID `6ad153b100051c38cb87fc01`. |
| 15:29:06.154–15:29:26.406 | Control-plane identity deletes incarnation 0; `compute-discard ... outcome=ok`. Failure precedes deletion. |
| 15:30:33.449 | HTTP POST `/start` returns 202; lifecycle `start_requested`. This predates investigation; caller identity is not established here. |
| 15:31:33.859 | Replacement incarnation 1 fails startup: “A submitted message has no durable native receipt. Inspect the retained session before retrying; automatic replay is disabled.” Insert ID `6ad15445000d1c1728e2a704`. |
| 15:31:56.314 | Replacement discarded successfully. API remains `failed`, `stateVersion=22`, `stateChangedAt=15:31:33.855`, `updatedAt=15:31:56.311`. |

## Receipt evidence and source attribution

Read-only inbox polling returns seven human inputs. Six are `delivered`, each with one matching replicated `inboxMessageIds` receipt. Only `394adec7-bbde-4d98-bb11-dd90c7165e4d` remains `delivering` (`delivery=steer`). Retained `session.json` and `provenance.json` agree on native input UUID `f2d396f5-37a3-442f-bb56-e863b974eb45`, operation `34517c36-97c0-4352-8567-ef821f8e48ad`; the ledger retains `steer:true`, `submitted:true` and the exact button instruction. All six other ledger UUIDs have top-level native and normalized message receipts; this one has neither. No system input appears in the inbox snapshot.

Compute insert audits identify both VMs' boot image as `pi-orb-image-v-1f11f218-ee6909cbdebb419b` (image ID `5169336255816503699`, version label `v-1f11f218`). This attributes source by image metadata, not by hashing deleted VM files. VM IDs: incarnation 0 `8424360049534341504`; incarnation 1 `7022417174329092836`. Orb repository checkout `072e6f5fd2fdc167caf2a8b1f1a78638e034fd60` is not runtime-source identity.

At `1f11f218:apps/orb-runtime/src/claude/agent.ts:2040–2119`, input provenance and `submitted:true` delivery intent persist **before** `input.push`. Therefore `submitted` proves neither SDK consumption nor a provider request. Duplicate inbox attempts return the existing operation/classification without resubmission. Replication marks inbox delivery complete only on a correlated committed receipt.

The first failure's exact text identifies `drainOperationOwned` (`agent.ts:1627–1639`): after query closure/history flush, a submitted delivery in that operation lacks a history record with its UUID. The screenshot instead identifies startup's `qualifyClaudeRestart` (`restore.ts:256–282`), which checks every submitted delivery. These are two detections of retained receipt uncertainty, not proof of two independent SDK crashes. Compute replacement cannot manufacture the missing receipt, and disposal proof does not authorize replay.

## Retained native consumption proof

Paths are relative to workspace `claude/`; raw JSONL line numbers below are **one-based**. Root file: `config/projects/-workspace-repo/37bd751f-1e28-4848-9416-9623480e4020.jsonl` (1,308 parseable lines, no malformed lines). `index.json` contains 1,347 records, including adapter-local diagnostics.

| PDT / line | Correlation |
| --- | --- |
| 15:23:02.522 / 1178 | `type=attachment`, UUID `0d60ebf1-0218-4dc8-8ec9-40d1142977ea`, parent `48a7c8b7-0e43-4826-84d7-69753a5043fe`. `attachment.type=queued_command`, `source_uuid=f2d396f5-37a3-442f-bb56-e863b974eb45`, `delivery_id=d482db7d-9d5e-48e0-a2c7-1b6863928264`; prompt exactly matches the inbox instruction. |
| 15:23:02.795 / 1179 | `type=queue-operation`, `operation=remove`, `reason=absorbed_mid_turn`, same `commandUuid` and `deliveryId`. This consumption edge, not attachment presence alone, establishes absorption. |
| 1181 → 1183 | Request blob containing that instruction has hash `72bf807a353f20f69ef91430804a2a69a761cb0095c3e4c57e3d106f815c908f`. Request `b166b178-709f-4550-8553-d236b458c8e5` at 15:23:02.910 includes that hash in `tail`; request digest `cc4c01986e61a4af07a809944db47b21c5570ac875f656d0d86e0c08c3c901e1`. This is retained request construction evidence, not independently a provider acceptance receipt. |
| 15:28:03.639 / 1300 | Final request `a75e9a67-63a9-412b-a679-5025e1d88c2f`; digest `c17d14dc55c236bfcb0ba5e2e95c94fc5b040bd201b726d6a91baa6bb4004746`. |
| 15:28:12.942 / 1305; 15:28:15.555 / 1306 | Thinking record `c12da274-4fe2-4113-927b-194fe9eb0508` and final text `4416551b-b3da-4b1e-ab33-0d8f0550fb74` share provider request `req_011Cg4p1HSYPqZRrnnq4byTt`, `requestRef=a75e9a67-63a9-412b-a679-5025e1d88c2f`, message `msg_011Cg4p1L4ny9AYbmKcpo4QQ`, `stop_reason=end_turn`. Final text explicitly confirms the button and published file. Both records exist in the local index, not the replica export. |
| 15:28:53.683 / local index | `claude.steering-result:ffb6a963-777e-410a-8bb0-e11937126f13`: `answeredInputs=[f2d396f5-37a3-442f-bb56-e863b974eb45]`, `pendingInputs=[]`, `queuedTurns=0`. Query `9fb0f7bd-251d-4020-bfd1-36ee9791c64a`, same operation. |
| 15:28:54.281 / local index | `claude.handoff-result:9fb0f7bd-251d-4020-bfd1-36ee9791c64a:ffb6a963-777e-410a-8bb0-e11937126f13`: `subtype=success`, `isError=false`, `numTurns=17`, `stopReason=end_turn`, no pending handoffs or awaited inference. |

**Mechanism, established:** deployed `1f11f218:apps/orb-runtime/src/claude/history.ts:290–300` chooses only top-level `native.uuid` (or a synthetic line identity), then looks up provenance by that ID. Its fallback at lines 397–402 reduces attachments and queue operations to type/identity events. The queued attachment is therefore indexed and replicated as `claude.attachment` under `0d60ebf1…`, without the nested input UUID, consumption edge or inbox correlation. The queue-removal event has a synthetic ID. Neither satisfies the exact-ID checks in `agent.ts:1627–1639` or `restore.ts:266–272`.

The SDK answered the steering input; native storage retained its consumed representation; the adapter failed to recognize it as a receipt and later failed closed. This is not evidence of an omitted native write or an SDK crash. The guard correctly refuses what its incomplete normalization presents as unreceipted delivery. Replacing compute repeats that same check against retained state.

## Limits and recovery

Retained success and final-response evidence resolves the receipt failure's initiating defect; no separate provider rejection or SDK crash is established. Exact process exit code/signal is unavailable. No standalone native debug/request/exit log files were found in the inspected Claude tree; `claude/config/debug`, `home/.claude/debug` and `claude/logs` are absent. Home boot-hook logs exist but are not native process-exit evidence. Deleted-VM journald cannot be recovered from the workspace disk. Earlier reachability failures and why the replica stopped before the local final reply/result remain unattributed; this inspection does not claim to explain them.

The published result is independently inventoried at:

https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/c9a30a6d-afb3-4a51-a979-335ae7ac389e/analyst-onboarding-redesigns-v4.html

Leave the failed orb and disk intact. No target restart, replay, ledger edit, inbox acknowledgement or native-file mutation was performed. The separate unreplicated tail remains unexplained; follow-up work lives in `TODO.md`.

## Approved correction (2026-10-15; local, undeployed)

After this inspection, the user approved an append-only existing-schema `claude.input_receipt` event, not target mutation or deployment. `ClaudeHistory` reparses all complete root lines after fsync/hash-prefix validation, including already fingerprinted stripped wrappers. It joins a same-session queued attachment to exactly one later `remove / absorbed_mid_turn` matching **both** input UUID and delivery ID, then joins trusted saved provenance. Incomplete, mismatched, child/sidechain, untrusted and conflicting evidence cannot authorize receipt. Native origin/prompt and result echoes are not provenance or consumption proof.

A deterministic event appends to the current journal tail without rewriting native bytes, old records or identities. Its bounded identifiers, source lines/hashes, classification and trusted inbox IDs retain durable consumption evidence. Reopen verifies/reuses its original timestamp and parent. Atomic scan/index commit precedes payload retirement, publication and ordinary transactional inbox acknowledgement. Shared receipt lookup covers restore and all four agent exact-ID sites; ordinary user/platform UUID receipts remain supported. Missing proof retains the visible fail-closed guard; automatic input replay remains forbidden.

Boot planning places genuine human authority at the original attachment position, not at the appended event. This preserves the retained final reply's settled classification and prevents late receipts from resetting the human budget. The retained handoff success does not manufacture an adapter operation terminal; qualification may report an interrupted operation without replaying it. Requirements and rationale: `docs/claude-agent-sdk.md`; tests and preserved failures: `docs/testing.md`.

## Reproduction and preservation

Initial cloud diagnostics used existing keyless identities. The separately authorized attachment used the user's existing gcloud login; no login flow, credential export, IAM/federation/firewall change or production service-account attachment was performed. Queries:

```sh
pi-orb transcript c9a30a6d-afb3-4a51-a979-335ae7ac389e --json
# API helper: set PI_ORB_APP_ORIGIN to the application origin; omit bodies for GET.
./infra/api.sh /api/v1/orbs/c9a30a6d-afb3-4a51-a979-335ae7ac389e
# POST is a read-only polling query, not input admission.
./infra/api.sh /api/v1/orbs/c9a30a6d-afb3-4a51-a979-335ae7ac389e/messages/poll '{"after":0,"tracked":[]}'
gcloud logging read 'textPayload:"c9a30a6d" AND textPayload:"lifecycle:" AND timestamp>="2026-10-15T19:50:00Z"' --project=playground-dev-6ae7 --order=asc --limit=1000 --format=json
```

### Attachment safety and cleanup

Project `playground-dev-6ae7`, zone `us-central1-a`; disk identity and detached READY state reverified before attachment. Existing hosts were production orbs, not suitable inspectors. Owned disposable Debian 12 VM `forensic-c9a30a6d-224244`, ID `8366661171117090824`: e2-small, 10 GB auto-delete boot disk, existing image-build subnet, **no service account, scopes or external IP**. Existing SSH firewall required a service account, so SSH was abandoned; bounded scripts in only this VM's startup metadata emitted selected nonsecret projections through serial output. No target disk code or SDK loader was executed.

GCE attachment was `READ_ONLY`, `autoDelete:false`; kernel `blockdev --getro=1`. Filesystem identified as ext4, UUID `57230052-30ed-46aa-815d-89f5b7b8689a`. Mounted explicitly `ro,noload,nodev,nosuid,noexec`; `findmnt` confirmed `ro,nosuid,nodev,noexec,relatime,norecovery`, and kernel confirmed no journal replay. Workspace had 44 GiB free; inspector 7.2 GiB; local evidence volume 47 GiB. No snapshot or whole-disk/config copy.

Selected reads: ledger, provenance, normalized index, root JSONL and diagnostic filename inventory. Prompts/tool content were excluded or hashed except the known instruction and final text; no authentication/config payloads were copied. Original files were hashed on the inspector. Raw source SHA256:

| File | SHA256 |
| --- | --- |
| `session.json` | `718331f264b5d526ad1000b3b18d7fdac95c87d01756edac69ab5292985746bf` |
| `provenance.json` | `bb95fa5ff6bad3588583053098c2a6505d4e441ae156bf4853947dadb93a02f2` |
| `index.json` | `90f21d45194dfbb90303ae391b132594b1171e17a28dc4b4429310db19de8df7` |
| Root JSONL | `269cfd076b4ae8652136c6546878281cacc84a3c3bc7bebe7aa57569d686bc3e` |

The three JSON hashes matched on the second read. Serial transport projections were checksum-verified; one interleaved inspector kernel line was removed during reassembly, with raw output preserved. The initial inventory script stopped on a bounded-list SIGPIPE; it did not complete the inventory, so a subsequent explicit file projection supplied the evidence.

At 15:47:50, explicit unmount and `lsblk` confirmed no evidence mount, disk still kernel read-only. Detachment completed 15:48:20.086; inspector and its boot disk were then deleted. Final inventory: target disk ID unchanged, READY, no users; no target or inspector VM, no inspector boot disk. Orb remains `failed`, `updatedAt=15:31:56.311`, unchanged from before inspection. A direct diagnostic API GET returned forbidden; final state verification used the authorized read-only orb inventory instead. Temporary inspector SSH key removed. User login was not reconfigured or revoked.

Private local evidence: `/workspace/evidence/c9a30a6d/`; new selected projections, scripts, raw serial transport, replica comparison, mount/attachment/cleanup descriptions and separate SHA256 manifest in `disk-forensics/`. These local copies are not published durable artifacts; this postmortem retains the diagnostic correlations. No tests or production changes were made.
