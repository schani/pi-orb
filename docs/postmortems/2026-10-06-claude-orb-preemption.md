# Claude orb stopped turning after Spot preemption — 2026-10-06

Orb: `16b24827-0927-431e-ba1d-8ae138985db8`; Claude session: `0f159eb8-5883-4954-94d1-0b004964f92d`.

## Finding

Two confirmed GCE Spot preemptions restarted compute. The first interrupted an unfinished operation; recovery restored its session but deliberately did not trigger inference. The second restarted the idle recovered session. Successful subscription notices were boot attachment events, not evidence of resumed work or renewed authentication.

## Timeline

All entries are October 6; Cancún is UTC−05:00.

| UTC | Cancún | Evidence |
| --- | --- | --- |
| 16:28:34.306 | 11:28:34.306 | User requested support for repositories without commits; native record `f91e6301-47a8-43a3-932c-b2e13e691637`. |
| 16:32:54.948 | 11:32:54.948 | Claude invoked typecheck and Biome; record `7c1a0fc2-d23a-4113-a4d5-d4761238edac`. |
| 16:33:19.495 | 11:33:19.495 | Bash returned exit 137; record `b9aa3888-6b16-4a48-a38b-2d45f309ec2d`. This alone does not establish OOM or the kill's source. |
| 16:33:28.684602 | 11:33:28.684602 | Audit: `compute.instances.preempted`, principal `system@google.com`. |
| 16:33:43.510026 | 11:33:43.510026 | Lifecycle: `running → starting`, `host_observed_stopped`. |
| 16:34:41.831 | 11:34:41.831 | `claude.interrupted:79d445c6-8ebd-48dc-8951-5898a7a59b4b`: “Previous operation was interrupted. Send a message to continue.” Metadata: `automaticReplay: false`. |
| 16:34:41.854 | 11:34:41.854 | Record `1a3cc99b-c7c9-4086-808b-b611fedcb5d5`: “Previous native background work ended with its compute.” |
| 16:34:49.761 | 11:34:49.761 | Subscription connected, generation 1; record `116cfb76-0149-4aa9-b6f6-105330912750`. |
| 16:34:53.041823 | 11:34:53.041823 | Lifecycle: `starting → running`, `runtime_ready`. |
| 16:40:07.668569 | 11:40:07.668569 | Second audit `compute.instances.preempted`, principal `system@google.com`. |
| 16:40:22.220916 | 11:40:22.220916 | Lifecycle: `running → starting`, `host_observed_stopped`. |
| 16:41:25.464 | 11:41:25.464 | Subscription connected again, still generation 1; record `3a7e51a3-b084-4e22-97d8-878cfc2a9215`. |
| 16:41:28.696193 | 11:41:28.696193 | Lifecycle: `starting → running`, `runtime_ready`. |

The inspected transcript ends without another user message or assistant continuation.

## Why recovery did not continue at the time

`apps/orb-runtime/src/claude/restore.ts` classifies submitted input with a durable native receipt but no `claude.operation_finished` event as interrupted. Changed execution lifetime permits recovery of old native ownership. Here the lifetime changed from `claude:0:2568a2ab-cb6f-4f8f-9cac-fe570a942768:21` to `claude:0:fe0a1156-d050-4bc6-930e-266c003bb339:20`; orphaned IDs were `bi3k3uo1l`, `bo6i5a3dh`, and `bol1xvckj`. These are ownership IDs, not proof of three actively running subagents.

`apps/orb-runtime/src/claude/agent.ts` (`boot`, `attachSession`) publishes the interruption notice, clears old ownership, restores the native session, and reports ready/idle. SDK `resume: state.id` restores context; it does not submit a continuation prompt. The operation notice is deduplicated by operation ID, and cleared ownership prevents a repeated child notice on the second boot. `claude.auth` is emitted after each successful boot attachment, explaining both connection notices without a credential-generation change.

This was the documented Claude policy at the incident, not Pi's automatic boot-resume behavior: known receipts permit manual continuation, never automatic replay. The proposed rationale is one continuation owner until native cancellation state and our resume prompt are qualified (`docs/claude-agent-sdk.md`, “Proposed boot, interruption and stop behavior”). No automatic-continuation qualification or implementation is established here. Missing orb naming was separately confirmed as a deliberate Claude naming skip, not a symptom of this interruption.

## Evidence and limits

Provider resource: `projects/playground-dev-6ae7/zones/us-central1-a/instances/pi-orb-16b24827-0927-431e-ba1d-8ae138985db8-i0`. Audit source: `projects/playground-dev-6ae7/logs/cloudaudit.googleapis.com%2Factivity`. Lifecycle source: `projects/playground-dev-6ae7/logs/run.googleapis.com%2Fstdout`, service `pi-orb-issuer`, revision `pi-orb-issuer-00043-2k5`; filter by exact orb ID and timestamps above. Transcript source: `pi-orb transcript 16b24827-0927-431e-ba1d-8ae138985db8 --json`.

Inspection copies were `/tmp/target-orb-audit.json`, `/tmp/target-orb-events.json`, and `/tmp/orb-16-transcript.json`; these private local files are not durable evidence links. The identifying fields and record IDs above allow source correlation. Preemption is proven; attribution of the earlier exit 137 specifically to shutdown rather than another kill is not. The investigation did not mutate the target orb.

## Subsequent decisions — 2026-10-06

The user requested automatic Claude restart continuation using Pi's guarded boot policy, successful authentication diagnostics outside conversation, and optional owner-Codex auto-naming. These are local implementation changes, not explanations of the historical recovery above or evidence of a target-orb deployment. Current policy and qualification: `docs/claude-agent-sdk.md`, `docs/claude-sdk-capabilities.md`, and `docs/agent-settings.md`.
