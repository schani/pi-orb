# Claude stream identity gap after a completed turn

2026-11-21, America/Los_Angeles (PST). Orb `5c48b8f8-f60b-41d8-8bc4-f10fc072a736`, native session `4a69a7e4-6377-4d73-93ef-7fe9f6350227`.

## Incident and recovery

| Time (PST) | Evidence |
| --- | --- |
| 20:28:57 | Native assistant `534dfe13-c842-41c3-9c17-178df737294e` persisted the full 2,800-character answer with `end_turn`. |
| 20:29:00 | Native result was `success`, `isError=false`, five turns, zero queued, `end_turn`. The `claude.handoff_result` accounted for three completed handoffs; none remained pending or awaiting inference. |
| 20:29:05 | Incarnation 5 failed with `runtime_failed: claude_stream_identity_gap`: one live block (`c6b05b45-bbdd-4156-8d50-b6906437be9b:0`) had zero owners; `published=nativeLength=28895`, `firstUnpublished=null`. These were runtime publication counts, not a control-plane replication checkpoint. |
| 20:29:23 | Compute discard succeeded. The retained workspace disk was detached; the control-plane replica still had 28,889 rows. |
| Before Start | The disk was mounted `ro,noload` on investigation compute. The 28,895-row index contained the final assistant and five metadata rows absent from the replica. No files were changed; the disk was unmounted and detached. |
| 21:48:18 | One authorized Start reused the retained workspace on replacement incarnation 6. No continuation prompt was sent. |
| 21:49:53 | Incarnation 6 reached `running` / `idle` (state version 54). Lifecycle logged `turn-resume outcome=notified_restart` with the exact saved assistant ID as its head. |
| 21:50:14 | The same-session replica returned 28,898 rows, including the full final answer, the successful handoff result, and a passive restart marker with no operation ID. No post-Start model calls appeared in the inspected replica. |

The answer was durable but temporarily missing from the replica. Start restored replication without rewriting native history or replaying the completed turn.

## Controlled reproduction and limits

With pinned Claude Agent SDK `0.3.328`, ending an SSE response after a partial thinking block, without SSE completion, produced synthetic `content_block_stop` and `message_stop` without a stop-reason delta or corresponding assistant record. The SDK then emitted `system/api_retry` with `error_status: null`, a distinct `message_start`, and ultimately a successful result. This reproduced an orphaned live block despite a successful retry.

The incident's raw SDK stream was unavailable. The reproduction establishes a possible mechanism, not that this orb saw `api_retry` or any particular transport failure. Incarnation 5's image (`v-f1c5b85e`) already included the earlier interrupted-thinking fix; the same identity-gap diagnostic does not establish the same cause. See [Claude history publication](../claude.md#history-publication) and the [October identity-gap incident](2026-10-22-claude-timeline-identity-gap.md).

Evidence: authenticated orb GET, lifecycle and Compute audit logs, read-only retained index, same-session transcript after Start. Operation `339fbb29-6305-4a12-bdeb-b84ca9ba231e`, query `aa13fb99-e61d-43bd-a8b8-caedb4ad8799`, result `1e15a0f4-444b-48db-801f-0bf675a9eaca`. The handoff result is not a `claude.operation` record; none appeared in the recovered suffix.
