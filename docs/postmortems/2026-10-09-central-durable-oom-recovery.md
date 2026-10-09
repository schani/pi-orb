# Central Durable OOM recovery loop

**Status (2026-10-09):** shared control-plane OOM confirmed; memory driver unproven. Investigation made no deployment, Stop, or other live-state mutations. Documentation only; no fix claimed.

## Confirmed evidence

All log times below are UTC on 2026-10-09.

- Orb `e8836220-358d-4480-84aa-ae07068a7864` had 23 root Harness recovery notices in roughly 30 minutes at the `21:47:44Z` transcript snapshot; the latest notice listed 701 recovered task IDs. Task IDs are not a count of subagents.
- Shared Cloud Run issuer revision `pi-orb-issuer-00047-czn` was configured with 1 CPU, 1 GiB memory, minimum/maximum instances both 1.
- `21:43:39.032955Z`: platform reported the 1024 MiB limit exceeded, with 1140 MiB used.
- `21:43:39.106Z`: shutdown began. All agents were suspended, not only the investigated orb.
- `21:43:40.817Z`: this orb released owner fence 42 and logged `harness.suspended`.
- `21:43:44.992Z`: replacement acquired fence 44, admission version 0.
- `21:43:47Z`: root recovery notice; `21:43:47.851Z` logged `harness.opened recovered=true`.
- Reopens repeatedly discovered/adopted the same host instruction digest `3817caa559ffba308c9de09c4e69bf87d41481f6404afd9ad8fb451c2c5b778d`, with host incarnation 1 and admission version 0. Adoption waves covered many child conversations; bash results often requested instruction re-evaluation.

Private local evidence: `/tmp/target-logs.json`, `/tmp/target-edges.txt`, `/tmp/target-transcript.json`; platform OOM/configuration evidence was collected by the parent investigation. These temporary paths are not durable retention guarantees; do not publish raw transcripts/prompts.

## Code findings and limits

`process-agent-composition.ts` constructs a new `InstructionReadiness` per owner open. Its offered digest and per-conversation generation map are memory-only. `prompt()` logs adoption on the first request for each conversation after reopening, even for an unchanged digest. That logging path does not create a child or generation task. `prompt.ts` calls it from the generation `beforeRequest` hook.

The execution gate captures the conversation's adopted revision when `envFor` creates an invocation. If the new owner has not adopted the offered host revision for that conversation, host effects are rejected with `Host instructions adopted; re-evaluate the operation under the current instructions.` This can explain recovered-tool re-evaluation, but does not prove it caused memory growth.

`tools/subagents.ts` deduplicates a spawn by `${api.taskId}:${api.callId}` in private `orb.children`; the child anchor submits with `requestId=anchor:<taskId>`. New model calls have new identities and can spawn additional children. Codemode is `replay: unsafe`; its nested callbacks are not independently checkpointed. There is no evidence here proving duplicate child creation on recovery, recursive fanout, or automatic replay of completed codemode effects.

`agent.ts` appends a passive, model-unseen recovery notice for retained live task IDs before resuming the Harness. Its count includes native task types, not just child anchors. Shared OOM explains owner replacement and repeated recovery; task/subagent fanout, retained history, sandbox workers and concurrent inference remain possible memory contributors, not established causes.

## Confirmation paths

Compare native task counts by kind/status and conversation ownership, especially `orb.child` anchors, before/after reopen. Distinguish stable recovered IDs from newly allocated anchors, submissions and generations. Use `durable_pg_tasks`, `durable_pg_conversations`, `durable_pg_submissions`, private `orb.children` document revisions, and `durable_pg_owner_events` (schema: migration `036_durable_authority.sql`). Correlate acquisition/release fences and platform instance IDs with root notices and adoption edges. Attribution of memory requires per-instance heap/RSS/worker and active-task measurements, not recovery-notice counts alone.

The governing rule and follow-up are in `docs/pi-durable-evaluation.md` and `TODO.md`.
