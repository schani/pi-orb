# Peer input waits for an active root turn (2026-10-16)

## Finding and limits

Orb `02f4fd87-03dd-4af0-9718-deaaecfb7129` retained peer input as `delivering`, with later input queued, while its root repeatedly awaited subagent results during the user's deployment request. Live evidence supplied by the parent investigation establishes busy-peer deferral and continued root progress, not a dead inbox or lost message. The missing busy indicator most likely reflects rollout handover: the new serving process had no recovered local owner yet and projected its absent busy sample as idle. The exact screenshot HTTP response is not captured. No product correction or target mutation was made by this investigation.

Times below are October 16, 2026, America/Los_Angeles (PDT). Canonical record references are the target session's numeric ID suffixes.

- **11:47:21:** delivery logged busy-peer deferral.
- **12:17:55:** canonical `:153` showed a subagent-result wait.
- **12:23:32:** the old harness logged `harness.suspended`.
- **12:23:56:** the user's screenshot-investigation orb was created.
- **12:23:58:** Cloud Run HTTP list GETs were served by new revision `pi-orb-issuer-00060-kfk`, before target recovery.
- **12:25:07:** canonical `:159` recorded recovery after apply.
- **12:25:08:** delivery again logged busy-peer deferral.
- Canonical `:186` showed activation progressing; `:194` showed lifecycle smoke progress at **12:25:28**, followed by another wait.

The parent observed repeated `get_subagent_result(wait:true, timeout_ms:900000)` calls and no completed root turn since the deployment request. A child result or a waiting tool is not root-turn completion. These observations do not establish the historical browser frame order, API activity value, or serving revision at the screenshot.

## Delivery mechanism

`apps/control-plane/src/adapters/durable/agent.ts`, `deliverNow`, submits peers with Native `whenBusy:"reject"`. `ConversationBusy` maps to retryable `Peer input waits for the current turn`. `apps/control-plane/src/domain/lifecycle.ts`, `dispatchQueuedMessages`, retains a retryable batch. The PostgreSQL store's `claimNextOrbMessageBatch` freezes the FIFO head as `delivering` before Native acceptance and returns that same head on retry. Later messages cannot overtake it. Only canonical receipt replication marks it delivered.

This is the existing peer scheduling policy, not evidence of the older host-Pi abort/steer wedge. Restart can restore unfinished Native work and therefore legitimately restore the same deferral.

## Busy indicator: likely handover projection

At inspected source `90fc48a3`:

- `apps/control-plane/src/http/views.ts`, `orbView`, derives central activity solely from `control.hasAgentWork(orb.id)`; absent memory becomes `idle`.
- `apps/control-plane/src/domain/lifecycle.ts`, `reconcileCentralAgent` and `reconcileComputeOnce`, sample `agentPlane.session(id)?.workActive()` into that process-local boolean. Neither delivery rejection nor live status frames update it directly.
- `apps/control-plane/src/adapters/durable/manager.ts`, `session`, returns a stable handle. Its `workActive` delegates to the loaded agent, or returns false when unloaded (`handle.ts`).
- `agent.ts`, `workActive`/`unfinishedWork`, count Native inbox items, task-graph tasks and `live.run`, unless paused. Long tool waits have no explicit idle exemption. Native view/task-graph subscriptions refresh these observations independently of history projection; projection-only work is excluded from `workActive`.
- `apps/web/src/pages/OrbPage.tsx` renders the lifecycle word/glyph from polled `orb.activity`, separately from WebSocket activity. Central history pulls do not refresh the control-state busy boolean (`domain/replication.ts`).

The observed new-revision list GETs fall between old-owner suspension and recovered-owner publication, adjacent to the screenshot report. In that window the new process's empty busy map and missing loaded owner project `idle`, although the durable task remains unfinished. This is the leading explanation: a handover status projection gap, not evidence that subagent waits are idle. The GET revision/timing supports it but does not identify the exact screenshot request or its response. No long-wait activity defect is established. Follow-up is tracked only in `TODO.md`.
