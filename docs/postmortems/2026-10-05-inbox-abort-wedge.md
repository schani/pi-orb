# Inbox steer stranded by abort (2026-10-05)

## Result and limits

Confirmed locally against the installed, repository-patched Pi SDK and agent-core 1.0.0. Local correction implemented October 7, 2026 (America/Cancun); no deployment or target/cloud mutation. The reported target state (`c6a07a79` delivering as a steer under `b8f65516-41c4-4654-aede-db0a6066e0e1`, newer `fac32b1d` queued, root idle after abort) matches this mechanism; this investigation does not independently establish the target's exact queue contents or deployed source version.

## Field recovery after the user's stop/start

On October 5, 2026 (America/Cancun), restart notice `a89e2770` persisted at **14:38:11.044**. Old steer `c6a07a79` persisted at **14:38:50.550** and newer `fac32b1d` at **14:38:57.849**; inbox reads confirmed both `delivered` under new operation `4be42990-80c3-44ec-8c78-3b4cc3d2cd41`. The queue recovered.

The commit/push subagent reported upstream executable changes and requested integration/validation guidance, with no commit or push yet. Its result `aef7b918`, **14:39:40.032**, was the last committed record. At **14:47:19.029**, live root status was busy, with no active tool or child and uncommitted intent to integrate/rebase/check before pushing. No executing tool was visible; actual rebasing or a definitive root stall was not established. These follow-up reads made no target mutation; stop/start was the user's action. Full evidence: `docs/postmortems/2026-10-05-busy-orb-stall.md`.

## Test-first evidence

New regression: `apps/orb-runtime/src/pi/inbox-abort.contract.test.ts`.

```
npm ci
npx vitest run apps/orb-runtime/src/pi/inbox-abort.contract.test.ts
```

The real SDK uses a network-disabled faux provider. An explicit inference-entry barrier ensures the steer arrives after initial queue polling; the provider waits for the real abort signal. No sleeps, external provider, or scheduling timeout chooses the interleaving.

All setup assertions passed: the first delivery was queued/nonduplicate/steer under the original operation; no inbox record existed; abort settled the original turn; runtime health was ready/idle; Pi still had queued messages. Three subsequent deliveries of the same batch all returned queued/duplicate/steer under the old operation. Provider request count remained one. The final progress invariant failed:

```
AssertionError: expected [] to have a length of 1 but got +0
```

First-run log retained locally at `/tmp/inbox-abort-first-failure.log`; this document retains its failure and prerequisites. Runtime typecheck passed. Dependencies occupied roughly 0.9 GB; disk retained 46 GB available.

## Exact mechanism

1. `apps/orb-runtime/src/pi/agent.ts`, `deliverSettledInboxMessage`: persisted native entries are checked first; otherwise an existing `pendingInboxMessages` entry immediately returns `queued`, `duplicate:true`, with its original delivery/operation ID. This precedes the cancelling gate and idle classification. A new steer is inserted into the map before `session.sendCustomMessage`.
2. SDK `core/agent-session.js`, `sendCustomMessage`: a streaming custom message with `deliverAs:"steer"` enters `agent.steer`, not session persistence. Acceptance resolves immediately.
3. Agent-core `agent-loop.js`, `runLoop`: an aborted/error assistant result exits before the subsequent steering poll. SDK `AgentSession.abort` signals the active run but does not clear steering; `_handlePostAgentRun` returns false when `_agentRunAbortRequested`, suppressing the otherwise automatic queued-message continuation.
4. Runtime `abortOperation`/`maybeFinishAgentOperation`: after root readiness and child holds settle, the operation finishes and activity becomes idle. Neither clears or resumes pending inbox messages. The map is cleared only by publishing a persisted inbox record (`attachSession`'s live-history callback) or a failed send (`deliverSettledInboxMessage`'s `mapErr`). Neither occurs for this accepted, unconsumed steer.
5. `apps/control-plane/src/adapters/pg/store.ts`, `claimNextOrbMessageBatch`: outstanding rows are ordered by ordinal; an existing head batch is returned unchanged. A later message arriving after that batch was frozen cannot join it or bypass it.
6. `apps/control-plane/src/domain/lifecycle.ts`, running inbox dispatch: each successful retry records delivery and authenticated liveness, touches the busy timestamp, then returns before idle-stop. `noteOrbMessageDelivery` keeps an outstanding row `delivering`; response status `queued` or `persisted` is not the durable acknowledgement. `commitReplication` alone marks inbox IDs `delivered` when their history record arrives. With no record, CP retries the same head forever, keeping newer rows queued. Successful duplicate responses also prevent liveness recovery and idle-stop from rescuing it.

Necessary conditions: same live runtime; an accepted custom steer not yet consumed/persisted when cancellation stops continuation; no independent root turn later drains the retained queue; CP retains the frozen batch as FIFO head. Child work is not required. Already-persisted steers do not have this failure. A runtime restart loses both in-memory dedup and steering queue, allowing safe CP replay after the persisted-entry check. Independent input may drain the existing queue; CP's newer input cannot do so because FIFO blocks dispatch.

## Correction decision (2026-10-07; implemented locally)

At a fully idle CP retry, cancel exactly the owned, unpersisted inbox steer and admit the frozen batch as a fresh operation. The adapter calls public `AgentSession.cancelQueuedCustomSteer`; the session checks idle plus exact custom type, original operation, steering disposition and complete ordered batch IDs, then calls agent-core's single-match steering cancellation. Zero/ambiguous matches and active ownership leave queues unchanged. Other steering/follow-up entries retain their order. Neither interrupted tools nor the old operation resume.

Before native ownership changes, append and fsync one visible, content-free `pi-orb.inbox-recovery` intent: batch ID, old/planned-new operation IDs and `cancel-and-redeliver` disposition. Publication, persistence, native exceptions or uncertain ownership fence admission with restart-required failed health; the adapter does not retire dedup on uncertainty. After confirmed cancellation, retire dedup and synchronously reserve the fresh operation/turn-start barrier. Concurrent retries join it; persisted native input remains the first dedup check and the sole replication acknowledgement authority. The recovery entry deliberately has no `messageIds`, so it cannot acknowledge the batch.

Process loss before/after cancellation loses both native in-memory queue and adapter dedup, leaving CP free to replay after the canonical persisted-entry check. Loss after native consumption is deduplicated by that receipt. An SDK admission failure after confirmed cancellation can safely retry; it cannot retain an old native copy. Recovery metadata records intent, not successful inference or delivery.

The preserved original RED is `.context/pi-inbox-abort-fix/reproduced-red.log`. With the approved policy, the native regression requires one new operation, exactly two provider calls (aborted plus recovered), one canonical receipt, one recovered-context occurrence, zero interrupted-tool executions, and durable reopened receipt/recovery identity. Concurrent/lost replies and persisted-first dedup are covered. The SDK rejects mismatched/active ownership; core tests preserve unrelated queue order and ambiguous ownership. Adapter DST exercises 80 abort/entry/poll/receipt schedules and audit, fsync, native refusal/throw and admission cuts. A further 40-schedule CP-store composition proves that recovery-intent replication and delivery notes cannot acknowledge/bypass the frozen FIFO head; only canonical receipt replication releases its successor, with exact native/replica ID counts and order. This is not PostgreSQL/runtime-transport qualification; upstream gates remain separate. Clean `npm ci`, all 364 tests in 53 affected Pi/CP-subagent files, all 11 installer/seal tests, whole-repository typecheck and scoped lint pass locally.

Two new harness failures were preserved and explicitly replayed before correction: the fake root omitted user persistence (Pi's lazy session file therefore never existed); finite retry tasks could all run before settlement, leaving an acknowledgement task waiting without dispatching. The fixture now persists native root input and continues CP retries until canonical receipt. Trace `test-failures/inbox-abort-recovery-1791350901691-14.json` replays green after that synchronization correction. The shorter first trace exhausts once the corrected fixture progresses beyond its original failure. The existing subagent race fixture also expected indefinite old-operation dedup and omitted native turn persistence. Its two preserved traces (`subagent-wake-inbox-abort-1791351321087-0.json` and `subagent-wake-inbox-abort-1791351652046-0.json`) replay green with durable recovery ownership and the correct distinction: an unconsumed steer starts fresh, while an already-consumed turn deduplicates against its old-operation receipt. Its 200 schedules pass. The composed CP-store fixture initially starved virtual time: native/poller checkpoint-only waits kept the store's mandatory 1–6ms latency parked forever. The preserved trace `inbox-abort-cp-receipts-1791352111011-0.json` reproduced before correction; simulated polling sleeps now own that clock progression. All 40 corrected schedules and the complete affected suite pass, without larger test timeouts. A shell status previously masked this test's first failure behind a succeeding typecheck; both logs and the inaccurate interim report are preserved. Evidence is retained in `.context/pi-inbox-abort-fix/`.

## Alternatives considered

- **Cancel native queued ownership, then replay from CP.** After cancellation fully settles, remove unpersisted owned inbox steers from Pi and then retire their adapter pending IDs, under serialized admission. The next CP retry starts a new operation. A global `session.clearQueue()` plus pending cleanup is small only if cancellation intentionally clears *all* native steering/follow-up work; it also removes non-inbox extension/user queues. Selective inbox removal needs a narrow SDK queue API. Preserve persisted-first dedup and frozen batch identity.
- **Resume retained work once.** At idle retry, resume the existing native queue through an SDK session-level run entry, claiming a new operation and turn-start barrier, without enqueuing the payload again. The SDK needs an appropriate public session-level seam; direct low-level `session.agent.continue()` bypasses session preparation/settlement ownership. Repeated/lost-response retries must join the same resume, not trigger more inference.

Rejected shortcut: deleting `pendingInboxMessages` alone. Pi retains the original custom message; retrying it as a new custom turn can persist both copies. A successful delivery response cannot substitute for history acknowledgement. No new CP timeout, FIFO bypass, or database compatibility machinery is necessary to explain or correct this runtime ownership defect.

Visible inbox status remains pending/delivering until actual replication; acceptance and the recovery intent are not delivery acknowledgements. No healthy queue-poll history noise is added.
