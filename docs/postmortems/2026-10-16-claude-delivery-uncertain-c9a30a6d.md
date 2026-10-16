# Claude delivery uncertainty recurs: c9a30a6d

2026-10-16 investigation; times are PDT (UTC−07:00). Orb `c9a30a6d-afb3-4a51-a979-335ae7ac389e`, session `37bd751f-1e28-4848-9416-9623480e4020`. Cloud/API capture, retained-session inspection and the separately approved offline disposition are complete. After normal Start and an automatic unreachable restart on the same VM, the once-submitted fresh probe was delivered and answered on the original session; two-minute stability acceptance passed. This was not an uninterrupted boot. Historical stall cause, the new unreachability cause and original-batch consumption remain unproven.

## Established distinction

The [October 15 steering input](2026-10-15-claude-delivery-uncertain-c9a30a6d.md), inbox `394adec7-bbde-4d98-bb11-dd90c7165e4d`, **is delivered**, updated October 16 at **06:22:58.620**. The receipt correction [#124](https://github.com/schani/pi-orb/pull/124) worked for that input. Its absence from the current transcript ancestry does not establish a missing persisted receipt.

The pre-disposition inbox poll had 35 rows: 33 delivered and **two fresh rows delivering**, both updated **13:11:24.426**:

- `3a00e4b8-3161-4f74-a46d-10f4f70baa2f`, created **13:05:56.543**.
- `b21f7889-c4e7-40af-9d10-0bf387ad0c05`, created **13:11:00.621**.

Both rows match one submitted steering batch: input UUID `15c6a9f5-d4ea-4bd5-b577-1d7038358b83`, operation `fc75622e-43ac-4fc1-812d-c52b2c227b9d`. Ledger and saved provenance agree exactly on operation and both inbox IDs; provenance contains no system/boot/compaction/sender authority fields.

## Native finding

The ledger has 33 submitted deliveries; the index has 5,497 normalized records and 5,210 fingerprints. Exactly one submitted UUID—the batch above—is absent from normalized record IDs. The root JSONL is 43,586,548 bytes (43.6 MB), 5,210 lines: 600 native user rows, four queued-command attachments and 302 queue operations. No user UUID, queued-command `source_uuid` or queue `commandUuid` matches this input; no matching attachment/removal consumption proof exists.

Historical input `f2d396f5-37a3-442f-bb56-e863b974eb45` remains at line 1178; its proof cannot authorize this new batch. Missing identity proof does not establish that the provider never consumed the content or that replay is safe.

## Incident build

Then-serving revision `pi-orb-issuer-00060-kfk` names runtime image **`pi-orb-image-v-90fc48a3-b78ac50e16d242d0`**, image ID `6783900232879950249`. Compute insert audits independently identify that image for **i11, i12 and i13**; all use replacement spec `23a2b9992eaa`.

Source `90fc48a3` includes receipt fix `8836f306` (#124), verified by Git ancestry. Deploy [38950036826](https://github.com/schani/pi-orb/actions/runs/38950036826) maps to that source per the deployment investigation. The orb's project checkout is not runtime-build evidence.

## Sequence

| Time | Confirmed evidence |
| --- | --- |
| 13:09:25.155768 | Explicit Start after i10 exhausted its restart budget. |
| 13:10:09.642588 | i11 Compute insert, instance `1504539815754807884`. |
| 13:11:19.632096 | i11 reaches running. |
| 13:11:22.855 | Earlier inbox `eb01faaa-e6a8-4040-af1e-0f83302572f4` delivered, matching native user UUID `825314d6-769e-4163-b9fe-f26d04fde92e`. |
| 13:11:24.426 | Two fresh inbox rows claimed as delivering; no successful dispatch edge appears in the scoped capture. |
| 13:11:29.428876 | Guest-local supervisor `runtime_health_failed`: transport, 2,004.352 ms elapsed against 2,000 ms deadline, `requestedStop=false`. |
| 13:12:08.860005 | Control plane chooses unreachable restart: `silent_ms=35177`, `health_no_answer`. |
| 13:12:57.634240 / 13:13:11.285330 | Provider stop/start completes successfully. |
| 13:13:57.076966 / 13:13:58.063261 | Guest then control plane report `claude_delivery_uncertain`; i11 discarded at 13:14:22.329592. |
| 13:17:05.639907 / 13:18:10.582648 | Explicit Start creates i12; startup rejects the same error; discarded at 13:18:28.244562. |
| 13:23:34.203700 / 13:24:43.369082 | Explicit Start creates i13; control plane records the same failure; discarded at 13:25:01.994495. |

Before disposition, captured state was failed, stateVersion 216. The visible error says a submitted message lacks a durable native receipt and automatic replay is disabled.

## Causal limits

The local health failure establishes guest-local transport unresponsiveness, not its cause. The all-GCE i11 query returned 178 entries for 13:10–13:15, exit 0, empty stderr, below limit 1000. It contains no original runtime-exit or kernel/OOM record explaining the loss. This does not establish that none occurred elsewhere.

Native assistant tool-use at **13:11:53.940** and a native user/tool-result row at **13:12:10.550** postdate the runtime-local endpoint failure. Native activity continued; this does not prove a Node event-loop block.

**Offline finding — 2026-10-16:** production `ClaudeHistory.scan` with real file reads/fsyncs took **325–370 ms** per unchanged scan (five samples, mean **338 ms**), with five reads/fsyncs, no commits and unchanged index mtime. The representative root matches **43,586,548 bytes / 5,210 lines**: 1,444 complete native messages copied from the API ancestry (24,627,841 serialized bytes), plus 3,766 synthetic metadata filler rows. Its generated index matches **41,030,090 bytes / 5,497 records**, including 287 synthetic platform events and padding. These are size-matched fixtures, not retained native/index copies.

Twenty synthetic, already-buffered SDK-shaped events invoking that scan occupied the parent event loop for **6,605 ms**. An independent child observed localhost health **200 in 10.1 ms** before, a **2,000.3 ms timeout** during (2,000 ms deadline), and **200 in 9.7 ms** after. This establishes starvation potential: roughly 15 such consecutive scans can occupy five seconds. It does not reproduce the deployed HTTP server, full history-flush path, native queue/receipt mix, actual event cadence or historical schedule; it establishes neither the historical stall's cause nor input consumption/replay safety.

Each preparation/measurement ran under a 60-second deadline and a 1 GiB cgroup memory cap with swap disabled and a private network namespace (localhost only). Maximum observed process RSS was 712 MiB in preparation and 446 MiB in the burst parent; scratch remained 81 MiB. `npm ci` completed before measurements. No provider calls, target writes, replay, product edits or timing-based repository tests were involved. Private scripts, fixtures, measurements and logs: `/workspace/evidence/c9a30a6d/offline-scan-2026-10-16/`.

Guest-agent signal 15 follows the requested provider stop. Later `runtime_child_exited`, exitCode 0, `requestedStop=true` belongs to uncertain-startup cleanup, not evidence of the earlier failure's cause. No historical crash, OOM, causal performance defect or provider rejection is established.

Display history and full HTTP transcript contain the same 2,447 record IDs on the current parent chain, ending at native index 5175, **13:11:20.747**. Neither returned ancestry contains `claude.input_receipt`; neither enumerates every stored record. Missing ancestry alone is not proof of missing persistence; the separate full-index/native inspection establishes the identity gap above. Consumption and the causal runtime stall remain unknown; no replay-safety conclusion follows. Follow-up is tracked separately from the October 15 tail in `TODO.md`.

## Preservation

Private cloud/API captures, summaries and manifests remain in `/workspace/evidence/c9a30a6d/recurrence-2026-10-16/`; final native findings, identity projections, raw serial transport, transport-repair accounting, cleanup verification and `SHA256SUMS` are preserved beside `/workspace/evidence/c9a30a6d/native-serial-2026-10-16/summary.md` and `selected-missing.json` (0700 directories, 0600 files). Raw target file contents were not exported. These are local private files, not published artifacts or external archival.

Disk `6171680811230466435` was attached READ_ONLY to disposable inspector `pi-orb-builder-forensic-c9-20261016203150`, without service account/scopes/public IP. Kernel RO was verified before/after; mount used `ro,nosuid,nodev,noexec,relatime,norecovery`. Inspection completed (`C9_END rc=0`), then unmounted. Inspector and boot disk deletion were verified by exact-resource NOT_FOUND responses; target disk is READY/no users, unchanged except attach/detach timestamps. During this read-only inspection the orb API was unchanged; no target restart, writes, repair or replay occurred. The subsequent approved repair is recorded below.

| Retained file | SHA256 |
| --- | --- |
| `claude/session.json` | `2e13bc76339ca4890625e9c339b9fbe87f7fc9b2274fcbde8c2ead2e0c9975a3` |
| `claude/index.json` | `b17d97721195362290ef6bcfdf377571081028687d06cfa1998070ce854eb1a7` |
| `claude/provenance.json` | `187c4f06a8af0ff1d3cb564df02bada3f6f5abe33ae18f5b4fb6cbca218e0c00` |
| `claude/config/projects/-workspace-repo/37bd751f-1e28-4848-9416-9623480e4020.jsonl` | `221e2257df02ad32276bc504f147d238d722fc3f75eb354e9fb4e8e7123e7c58` |

The empty failed broad-query artifact is retained and excluded from the cloud/API manifest; its 60-second timeout is not an empty-log result. The zero-record boot selector missed logs found by exact-instance queries. Bounded native inventory found five boot-hook log/status paths, no supervisor/journal/debug path; excluded locations remain unexamined. Private configuration and user-content captures must not be published.

## Approved one-off disposition — 2026-10-16, complete

The user separately approved marking exactly the two fresh inbox rows **failed**, with a truthful consumption-unknown reason and their original text/history retained. This was committed and independently verified before appending a visible durable `claude.delivery_disposition` event to the native index, then removing only this batch's exact retained ledger entry. The event neither reuses the native input UUID nor carries top-level `inboxMessageIds`: disposition is explicitly not a receipt. No SDK launch, native JSONL edit, synthetic receipt or replay occurred during repair.

Private, tests-first helper sources and validation evidence: `/workspace/evidence/c9a30a6d/recovery-2026-10-16/implementation/`. This is a one-off, not a new endpoint/schema/recovery state machine. Full private originals and backup manifests, exact state revision/offline compute ownership, original file hashes, explicit stage boundaries and fail-closed crash-prefix checks precede writes. The CP batch ID is `3fa2570c-2e20-5992-8742-6c007dea7afe`, not the retained ledger key. Full CP rows remain private on the current orb; only their backup hash/identity attestation crosses to the inspector. Unrelated ownership maps, lifetime/boot guards and history remain unchanged. Candidate restart qualification uses existing history and a hypothetical new physical lifetime; it is not proof of provider nonconsumption or permission to bypass other startup guards.

**Physical readback:** index SHA256 `4cc0bb21767b617be32d42e77b48e1eab3c449b915507d0455122c1ee5ab3018`; session SHA256 `3aeefb47f20db610c482e745086a2c2c8824fb8e450285ba780f33efe2db756c`. Index-stage readback still had the original session hash; ledger-stage readback verified only the selected entry removal. Before boot, physical readback verified the original 43,586,548-byte JSONL and provenance hashes above unchanged; this is not a post-boot byte-identity claim after legitimate SDK input/history appends. Full native originals remain private in `.recovery/c9-20261016-211622`; CP original rows and SHA-verified message text remain private beside the recovery evidence. No unrelated ownership/lifetime/boot state changed.

Final read-only CP verification remained **failed / stateVersion 216**, with **33 delivered / 2 failed**. Cleanup at **14:27:22 PDT** verified inspector and boot disk HTTP 404, retained target disk `6171680811230466435` READY with `users: []`, and no target VM. Completion, unmount and exit 0 were independently read back. Private evidence: `/workspace/evidence/c9a30a6d/recovery-2026-10-16/ops-preflight/{ledger-final-readback-verification,final-store-readonly-result,cleanup-api-verification,repair-completion}.json`.

## Normal Start / fresh-exchange acceptance — 2026-10-16, complete

One Start at **14:28:51** returned HTTP 202, starting/stateVersion 217; running/stateVersion 220 was observed at **14:30:18**. The acceptance helper initially applied the durable-history schema to the browser display-history response, which validates against `DisplayHistoryViewSchema`. Its first STOP proof is retained; this deterministic harness contract error occurred before any probe send, not a product regression or guard bypass.

The control plane began an **automatic unreachable restart at 14:31:09**, before the fresh probe. Probe `f421f836-fd82-4369-8fad-37b34276593c` was PUT exactly once at **14:31:41** and observed queued. At **14:32:01**, the acceptance guard observed the orb was no longer running and stopped without retry; that STOP evidence is retained. The same VM **i14**, instance `7784491750147435001`, became ready at **14:32:59**. Read-only observation then established delivery and reply; no second Start or probe submission was used. This sequence is automatic recovery, not uninterrupted boot or proof of the unreachability cause.

Native user receipt `6f71775c-695d-488e-8e72-b02363e00ed6` at **14:33:16.988** delivered the fresh input. New assistant record `3fbc7ef8-cc8e-49d9-9694-d118dbe8e5d7` at **14:33:19.941** contains the exact expected recovery marker, ends with `end_turn` and has no failure. Both are on the active ancestry of original session `37bd751f-1e28-4848-9416-9623480e4020`; the reply was absent before submission.

**Stability passed:** ten samples over **130.2 seconds**, completed **14:36:56**, retain running/stateVersion 223, no last error or action required, fresh input delivered and the original two inputs failed. VM i14 remains RUNNING on original workspace disk `6171680811230466435`. The same workspace disk/session, original input text and private backups were retained; no original input was replayed. Normal Start changed checkout-commit metadata; worktree byte identity is not established. Offline repair changed only the index/session files and private backups; subsequent SDK appends are legitimate activity, not repair writes.

Private allowlisted acceptance metadata: `/workspace/evidence/c9a30a6d/recovery-2026-10-16/acceptance/{PROBE-REPLY,STABLE-VERIFIED,STABLE-SAMPLES}.json`; initial STOP proofs remain beside it. Recovery used serving source `e6710059`, not the local cooperative-responsiveness patch. Fresh-exchange recovery is verified; neither the historical stall nor this automatic restart is claimed fixed or explained, and original-batch consumption remains unknown.
