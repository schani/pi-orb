# Claude root activity during query shutdown: 1f315657

Date: 2026-11-04 (America/Los_Angeles). Observed shutdown race; initiating cause unproven. Forensic-only investigation: no product, prompt or recovery change.

Orb `1f315657-4fcb-4bb3-aefb-fe6a20d0180f`; native session `a45ed8eb-fa7c-4d85-bc57-a535023a6916`; failed operation `526f305e-02dd-444f-bf0d-4c4ff0486d53`; query `37aff923-7bae-4e7d-8eec-fb8f73baf9e1`.

## Observed sequence

All times below are November 4, PST.

| Time | Evidence |
| --- | --- |
| 17:09:02.787 | `claude.handoff_result`: successful nine-turn result `aac93131-74f1-4a78-b977-cd706d98f1e9` retires seven handoffs including Monitor task `bzc99aihw`; none pending. |
| 17:14:26.708845 | New human input accepted: launch deploy/monitor, then a separate tester, then notify parent. |
| 17:14:29.765 | Native orphan notification claims `bzc99aihw` did not finish before the previous session ended. It precedes the human input's native receipt and has `queueTranscriptOnly: true`. |
| 17:15:01.881243 | Deploy child `c7539e1e-f517-49a4-8a2b-5e66c16b7779` accepted. |
| 17:15:22.794 / 28.677 | Tool results confirm preview/hosted fixture creation, then predeploy token checks return 401/401. |
| 17:15:28.739 | Last incident API request retained in native JSONL; collection-time replicated history ends here. |
| 17:15:37.700 | Retained final reply `01ddc186-3a69-4eda-aa09-cb70ffb70675`, `end_turn`, reports the baseline, deploy child and fixtures; promises tester launch after deployment. |
| 17:15:38.501 | `claude.handoff_interrupted` records a different task, `bb9gb2c5f`: start `ac1a910b-ac8e-414f-a262-f00b5207901b`, terminal notification `2b1a1a21-24cb-40f5-8ea1-89def1eea030`, status `completed`, both observed during closing. No replay. |
| 17:15:38.663 | `claude.rotation_failed`, `reason: root_work`: first late signal is native `system/status: requesting`, UUID `513f9e0f-ab41-4e46-af50-2ba4d5bccd8f`. |
| 17:15:45.409779 / 17:16:08.670886 | Lifecycle records `runtime-failed reason=claude_rotation_uncertain`, then successful discard of incarnation 0. |

The late signal's `priorResult` is `88d80e1d-be2b-45ce-858e-0b12d737fb87`: success, `isError: false`, zero turns, zero queued turns, null stop reason. **This is the latest consumed result at the first late signal, not necessarily the result that admitted closing.** The adapter updates it during closing too. Neither the initial close caller nor the initiating result/ownership snapshot is retained.

Native lines 2242–2250 retain the final reply and housekeeping, with no subsequent incident API request, assistant response or tool call. This does not prove no inference or unrecorded side effect occurred. Confirmed side effects precede the final reply: deploy child, preview registration on 5174 and hosted fixture.

## Attribution limits

The orphan Monitor notification is real, but no retained evidence connects it causally to the shutdown race. It is not the closing task's ID. `bb9gb2c5f` lacks retained description, task type, tool-use ID, output and individual edge timestamps; its classification as Bash, a hook, or synthetic scheduling is unproven. Native JSONL does not preserve every SDK event. Inspected retained Claude files contain no raw SDK/debug log; only native JSONL and two persisted tool outputs. Docker container inventory is empty; retained boot-hook logs do not identify this task. A bounded Cloud Logging query for its IDs and continuation diagnostics returned no rows.

No `claude.continuation.*` diagnostics are retained. In this source they activate only after nested-delegation denial. The earlier defect reproduced in `docs/postmortems/2026-10-13-claude-query-rotation.md` does not establish this incident's cause. These observations justify neither blanket zero-turn filtering nor Monitor-notification deduplication. Investigation follow-up lives in `TODO.md`; general idle-fence uncertainty remains question 73 in `docs/open-questions.md`.

## Source and later restart

Compute creation audit selects boot image `pi-orb-image-v-1ea12c28-ab42930011374cfe` for incarnation 0. Its source association is `1ea12c28fad8fae7936e85a154e4c270912e5cb6`, whose lock pins SDK 0.3.310/native package 0.3.310; incident native records identify CLI 2.1.310. No per-process build digest survives. Retained `provenance.json` maps input UUIDs to operations, not runtime builds; the workspace Git HEAD is not runtime attribution.

The disk was subsequently reused **before this collection**. At 19:32:16.812987 the deploy child sent message `724f4e36-c877-4fbe-8944-8d303a3c0290`; at 19:32:17.418056 lifecycle changed `failed → starting`, `reason=queued_message`. Compute Audit Logs attribute incarnation-1 creation to `pi-orb-control-plane@playground-dev-6ae7.iam.gserviceaccount.com`, selecting image `v-aa1c45d1-e0487fa2f63042a7`. The retained host notice is 19:33:25.194; readiness is 19:33:27.067182. Later native records identify CLI 2.1.318. Thus copied `session.json` is **post-restart state**, not the original failure snapshot. This investigation neither started nor replayed the target.

## Later usability blocker (2026-11-05)

This is distinct from the original shutdown race. At 19:44 on November 4 the restarted runtime became unreachable. Its subsequent boot failed with `claude_delivery_uncertain`: a submitted message lacked a durable native receipt. Incarnations 2 and 3 repeated that gate; incarnation 3 was discarded at 07:23 on November 5. Its boot reported 34,068,889,600 workspace bytes free: this is not a disk-full diagnosis.

A read-only PostgreSQL transaction at 07:36:32 on November 5 found:

| Resource | State |
| --- | --- |
| Orb | `failed`, state version 29, no host, next incarnation 4, no Claude recovery proof |
| Tester report `5dd1ab6e-b1a3-4dfe-86ab-448eb82954b5` | `delivering`, singleton batch of the same ID, `steer`, operation `acb6a393-cf34-401c-b074-8070b90666bf`, `auto_start=false` |
| New human message `3d45cef0-69b0-4817-b5c3-40869b21f70a` | `queued`, “Where are we now?”, no batch or operation |

No replicated record acknowledges the tester report. The earlier retained journal marks its native UUID `d00d53e0-29ef-4c1b-bfa3-526c44fa8887` submitted, but the retained native transcript contains no receipt for that UUID. Its last native tool result records an aborted Bash transcript-polling command at 19:44:25.879, exit 137; the current replica still ends at 19:37:11.013. This does not establish why the runtime became unreachable or whether the report was consumed.

Source `aa1c45d1` checks missing delivery receipts before operation terminals; an aborted terminal alone cannot pass that gate. Ordinary startup can dispatch retained inbox work before repaired history is pulled. The pull-before-dispatch barrier applies only to verified Claude compute recovery, absent here. Removing the report delivery from disk first could therefore replay it. A platform event carrying its inbox ID would mark it `delivered`, not truthfully failed, and would not remove this race. Neither approach is a safe repair.

**Recovery scope:** the user requested disk repair without task replay. Additional permission to fail the singleton central inbox row remains pending; no repair, lifecycle change or replay occurred during this follow-up. The five retained pending handoffs are separate ownership evidence; an aborted operation does not release them. Existing qualification requires a changed known physical compute lifetime or matching verified disposal proof. No ownership was cleared.

Current evidence is retained separately as `current-*-20261105.*`, `report-delivery-logs-20261105.json` and `SHA256SUMS-current-20261105` under the ignored evidence directory. The lifecycle query returned 134 rows without hitting its limit. The exact report-ID log query returned acceptance and dispatch only, not confirmation. Existing federated service-account access supplied the read-only database query; no secret was printed or saved. Its first query failed because a JSON value used a JSONB membership operator; the preserved failure was corrected with an explicit cast. No database writes were attempted. A fresh source-disk capture remains uncollected because read-only attachment lacks service-account permission; new temporary human credentials have not been used.

## Evidence custody

Ignored `.context/claude-rotation-1f315657/` preserves collection-time transcripts/logs, audit/image metadata, earlier permission denials and the read-only collection. `target-restart-authority-logs.json` contains 59 filtered rows without hitting its cap; the earlier broad query hit its cap and is not absence evidence. `SHA256SUMS-readonly-20261105` covers the collected files; source-to-copy hashes were verified before unmount.

| Retained file | SHA256 |
| --- | --- |
| `native.jsonl` | `a42b2c1f817b7c1c6e90a89aac1dfe3027d7be9421ac79e0fcb4bf05a7807444` |
| `index.json` | `14039bd7821e7f7b0ccffed90670c5a5ee62473592dccc5c7976b18b3f7f0773` |
| `session.json` | `7f5935b1de3ced8ccbf482c867d14ad76c3350b39d31bbe3a17c6111c0869d8d` |
| `provenance.json` | `9a24f4cdbdfad48d2ae880b1dc6fe104706175c66a6c78cef73aebcbbcc61816` |

Disk `6909509454845642001` was attached read-only to the investigator's metadata-verified current VM (incarnation 1; the supplied incarnation 0 no longer existed), mounted ext4 `ro,noload`, and copied into mode-0600 files. It was unmounted and detached; disk users were verified empty. Temporary `mark@heyglide.com` credentials were revoked and active account restored to `pi-orb-amp-deployer@playground-dev-6ae7.iam.gserviceaccount.com`. Further log reads used that account. No IAM change, source-filesystem write, target execution, test or deployment occurred.
