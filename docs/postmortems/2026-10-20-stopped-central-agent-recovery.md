# Stopped central agent missed recovery after release shutdown

**2026-10-20; production observation and local deterministic reproduction. Eligibility fix implemented locally; not deployed. No production recovery performed.**

## Confirmed observations

Target: orb `d7f0c16d-272e-4ffc-aa1f-aea51212473e`. Times are October 20, PDT. Retained production evidence: `/tmp/d7f0-stop-investigation-20261020/{orb.json,inbox-message.json,orb-logs.json,shutdown-logs.json}`; content-free extracts and checksums: `.context/stopped-central-agent-recovery-20261020/`. Logs/API establish the observations below; source inspection establishes the mechanism separately.

- Idle stop began at 3:31:53.309 PM (`idle_for_902s`) and completed at 3:32:16.927 PM (`drain_complete`), with no later transition in the captured target logs. The API reported `stopped`, `stopReason=idle`, `stateVersion=5`, that same `stateChangedAt`, and `centralAgent=true`. The VM was already stopped about ten minutes before the new input.
- At 3:42:37.169 PM, the message was queued against that stopped state with `wake=requested`; owner fence 5 was acquired at 3:42:38.115 PM.
- During revision `00067` → `00068`, the control plane logged `shutting down` at 3:42:38.854 PM. The Harness opened at 3:42:42.090 PM; transcript input `d97b9514-8b27-4d39-90c9-8d2f2a1bc8e9` appeared at 3:42:42.498 PM; dispatch completed at 3:42:43.743 PM. Ownership release/Harness suspension followed at 3:42:43.954 PM. Other orbs were suspended in the same shutdown interval.
- The API's 3:42:43.739 PM `updatedAt` was not a stop transition: `stateChangedAt` and version remained unchanged. The inbox API reported `delivered`, `delivery=turn`, operation `conversation:d7f0c16d-272e-4ffc-aa1f-aea51212473e:submission:2692`, created at 3:42:37.158 PM and updated at 3:42:43.742 PM.
- Revision `00068` activated at 3:43:50.793 PM. No subsequent target owner acquisition or Harness opening appears in the captured logs.

**Diagnosis:** release shutdown interrupted a central-agent wake on an already-stopped VM. The evidence does not show a new idle stop after message acceptance. A public input receipt is not proof that its turn completed.

## Source-derived recovery hole

Inspected checkout: `4c21a7c2`; deployed-byte parity was not established.

1. Shutdown stops new scheduling but joins in-flight pollers before closing central agents (`apps/control-plane/src/main.ts:973–980,1044`; `apps/control-plane/src/domain/loops.ts:223–249`). Dispatch after the shutdown log is therefore possible. Harness close suspends work and releases resources (`apps/control-plane/src/adapters/durable/agent.ts:1429–1454`).
2. Public input projection marks inbox rows delivered and clears `auto_start`; dispatch acknowledgement also clears it (`apps/control-plane/src/adapters/durable/atomic-history.ts:186`; `apps/control-plane/src/adapters/pg/store.ts:343–350,1474–1478`). These are delivery receipts, not task-completion records.
3. A fresh process has no loaded agent. `reconcileCentralAgent` treats a stopped VM with no process-local work, execution lease, sleep, or queued/delivering inbox row as quiescent, attempts unloading, then returns **before** opening the agent (`apps/control-plane/src/domain/lifecycle.ts:2583–2604`). Unloading without a handle is a no-op (`apps/control-plane/src/adapters/durable/manager.ts:441–443`).
4. Neither backstop rescues that combination: message wake requires an outstanding `auto_start` row (`apps/control-plane/src/adapters/pg/store.ts:1662–1670`); agent-work wake requires process-local work (`apps/control-plane/src/domain/lifecycle.ts:2491–2498`). Passive history reads do not open the Harness and report idle (`apps/control-plane/src/adapters/durable/manager.ts:513–539`).
5. Native recovery scans queued/placed submissions and recovered tasks **inside** `DurableAgent.open`, then resumes (`apps/control-plane/src/adapters/durable/agent.ts:428–439,505–522,547–550`). The stopped fast path prevents reaching that inspection.

This gate can strand persisted unfinished central work after restart. It is not evidence that Native lost the work.

## Limits and recovery guidance

Native task/submission rows and inbox `auto_start` were not directly queried. The public operation references submission 2692, but its native status, any task ID/status, survival at shutdown, and whether any task had started remain unconfirmed. Clearing `auto_start` is source-derived, not a production database observation. The local campaign below reproduces the mechanism, not the incident’s exact schedule or unqueried Native state. No historical schedule replay or successful production recovery was performed.

Explicit **Start** from `stopped` bypasses the fast path and should reopen/resume eligible persisted work (`apps/control-plane/src/domain/lifecycle.ts:2969–2989`). This is unverified guidance, not an executed recovery. Do not resend accepted input or issue Stop first. Verify subsequent owner acquisition, recovery status and actual progress rather than treating `updatedAt` or a delivery receipt as completion.

**Invariant:** stopped compute and an empty delivery inbox do not establish that persisted central work is quiescent. The implemented eligibility rule is in `docs/lifecycle.md`.

## DST coverage gap (2026-10-20)

Source inspection found a missing composition, not evidence that more scheduler seeds would catch it:

- Central lifecycle tests inject a fixed `work` flag and no-op suspend/close; they cannot distinguish unloaded ownership from persisted unfinished work (`apps/control-plane/src/domain/central-lifecycle.dst.test.ts:22–65,525–550`).
- The campaign command grammar has no control-plane shutdown/replacement. Its central plane uses fake runtime delivery, boolean activity and no-op close (`apps/control-plane/src/domain/lifecycle-campaign.dst.test.ts:42–51,281–350`). The restart helper resets control/auth state but retains other dependencies, including any agent plane (`apps/control-plane/src/testkit/fixtures.ts:244–250`).
- Campaign quiescence forces activity false and checks receipts, `delivered` and replication—not Native task completion (`apps/control-plane/src/domain/lifecycle-campaign.dst.test.ts:562–606,627–633`).
- Real unfinished-work recovery is tested by directly reopening `DurableAgent`, bypassing lifecycle eligibility (`apps/control-plane/src/adapters/durable/agent.test.ts:849–968`, especially `905–933`). Manager shutdown DST uses new storage per open and asserts ownership/resource cleanup (`apps/control-plane/src/adapters/durable/manager.dst.test.ts:12–86`). Neither composes fresh ownership with the stopped fast path.

**Coverage decision (2026-10-20):** use a small general central-work composition campaign, not an incident-specific regression or a rewrite of the older fake campaign. Independent worker quanta matter: batching poll plus host reconcile erased the release cutpoint by waking compute before a restart could run. More seeds on that incorrect composition would not expose the gap.

## Pre-fix generated-campaign evidence (2026-10-20)

`apps/control-plane/src/domain/central-work-campaign.dst.test.ts` generates programs from submit/retry, poll, reconcile, model progress, idle and restart, without inspecting incident-specific predicates. It retains real Native/public SQL and replaces process-local ownership. Its independent acceptance ledger requires completion under original identities after a fair, input-free suffix. Scope and simulation boundaries: `docs/testing.md`.

Default exploration: **7 passing histories, 1 unskipped completion-liveness failure**. Seed 3's generated program is:

```text
submit → poll → poll → restart → restart → reconcile → progress → reconcile → reconcile
```

With initially running compute it passes. With compute stopped by ordinary idle lifecycle, input is accepted as Native submission 10/public operation `conversation:…:submission:10`, projected once, and marked delivered with `autoStart=false`. Generation task 12 remains running at a persisted request checkpoint. Both release restarts replace the plane/persistence/control state; ordinary reconciliation and polling never reopen it. Model progress is released, but the 15-second virtual fair suffix ends without a terminal task or answer. Total opens remain 2: the initial idle incarnation and the message-admission incarnation; none after replacement. Passive observations preserve that same operation/submission identity across both restarts.

Retained trace: `test-failures/central-work-true-3-1792537434171-0.json`. First passive state: `test-failures/central-work-true-3-state-1792537434162.json`. `runDst`'s automatic replay and an explicit replay reproduce the completion invariant:

```sh
DST_REPLAY=test-failures/central-work-true-3-1792537434171-0.json \
  npx vitest run apps/control-plane/src/domain/central-work-campaign.dst.test.ts -t 'idle=true seed=3'
```

Final focused qualification retained the same failure with 33 passing tests across the new campaign, central lifecycle, manager DST and PG stable-plane tests; full workspace/E2E typecheck passed. An independent existing-suite run passed 180 tests (logs `/tmp/central-work-existing-tests.log`, `/tmp/central-work-typecheck.log`). Final-source trace `test-failures/central-work-true-3-1792537613832-0.json` also reproduced automatically and by explicit `DST_REPLAY` with the same test selector. Focused logs: `.context/central-work-campaign/{final-focused,final-explicit-replay}.log`.

This confirmed the eligibility defect in the local composition, not the production incident's exact Native state. That investigation changed no product code, schema or target state.

### Harness first-failure record

Each first failure was explicitly replayed before correction; none was cleared by a passing rerun. Logs/replays and source snapshots are retained under `.context/central-work-campaign/`; original traces remain under `test-failures/`.

| Trace suffix | Diagnosis |
| --- | --- |
| `false-queued-1792537151797-0` | Fixture reused an in-memory helper's non-UUID project ID. Replaced with UUID rows and the existing host-seeding helper. |
| `false-queued-1792537185175-0` | Native `AbortSignal.any` rejected determined's structural deadline signal. Added the timing-preserving test-only bridge. |
| `false-queued-1792537235752-0` | Oracle compared a JSON-encoded SQL request key to plain text; use the Native record's request ID. Rich error messages included wall timestamps, so automatic replay reported a message-identity mismatch despite reproducing the same oracle failure. Diagnostics now use separate snapshots and a stable invariant message. |
| `true-inference-1792537317147-0` | Primitive composition reproduced the product defect. Preserved its source before replacing the fixed histories with generated independent quanta. |
| `true-3-1792537434171-0` | General generated campaign independently reproduced the defect; seven controls passed. |

Full trace filenames use the `central-work-` prefix and `.json` suffix. The earlier primitive source snapshot is evidence only, not a committed incident-specific test.

## Local correction and qualification (2026-10-20)

Central reconciliation now checks existing persisted task/submission status before stopped quiescence can bypass native recovery. The read-only query traverses the selected agent/persistence boundaries, acquires no owner, and changes no persisted state. Existing admission/version fences still govern opening and resuming. Probe/open failures are typed retries, logged as condition edges and shown through the existing `lastError` view from reconstructible memory. Explicit inhibition and passive reads retain their authority. Current rule: `docs/lifecycle.md`.

Tests were red before implementation: demand true/false/read-error, selected-backend forwarding, SQL status matrix and user-visible failure handling. The focused suite now passes 62 tests; the default generated campaign passes eight. Expanded unfixed exploration also found seeds 8/16/19 with the same eligibility defect, explicitly replayed before correction. All four formerly failing generated programs match their saved unfixed histories and pass fixed source. Comparison: `.context/central-work-campaign/fixed-program-comparison.json`; an external synchronous `h.command` observer independently confirms those programs in `fixed-program-observer.{test.ts,jsonl,log}` under that directory, without changing the campaign or scheduler.

Original trace replay on fixed source is **not** green: record 1022 of `central-work-true-3-1792537434171-0.json` expects timer-create #366, `commands-and-workers deadline: unload stopped host agent state`; fixed source creates `commands-and-workers deadline: persisted central agent recovery demand` at the same virtual deadline, 34207.49504459696 ms. The three focused demand traces similarly diverge at record 7, timer #3. The new scheduled read changes the trace structure. Original traces and exact mismatch logs are preserved unchanged; successful generated programs, not an edited trace or passing rerun, qualify the fix. Evidence: `.context/central-work-campaign/fixed-original-trace-replay.log`, `fixed-demand-replay-{true,false,error}.log`, `fixed-focused.log`, `fixed-default-campaign.log`.

Final fixed-source root `npm run typecheck` passed (`/tmp/central-recovery-fixed-typecheck.log`); `npm run lint` exited 0 with unchanged 411 warnings/83 infos (`/tmp/central-recovery-fixed-lint.log`); 353 infrastructure tests passed (`.context/central-work-campaign/fix-infra-tests.log`). The local full-suite sequential Vitest+PG command ended before a result (36 files reported passed; no reported test failures or complete-suite claim; `.context/central-work-campaign/fix-full-vitest.log`); its cause remains unconfirmed pending the tool receipt. The initial expanded 32-history fixed command hit its 180s aggregate bash deadline without a file result or reported per-test failure/trace (`.context/central-work-campaign/expanded-fixed-0-15.log`). Neither assertion timeouts nor source changed. Subsequent expanded qualification used CPU 1 isolation; full local qualification was not restarted. CI must qualify full tests/E2E. Incomplete commands do not establish test failures.

Expanded fixed exploration passed **128/128 histories** (seeds 0–63 × initially running/ordinary-idle compute), with no new campaign failure artifacts or additional defects observed within this workload; successful runs totaled 552.33s (`.context/central-work-campaign/expanded-fixed-summary.json`). The initial 32-case command aborted at its 180s aggregate budget and is not counted; completion used eight-seed batches on CPU 1 with unchanged test timeouts/assertions, counting the original seeds 16–31 run's 32 passes once. No failure was cleared by repeated green runs; coverage remains one synthetic accepted ID, PGlite persistence and independent completed worker quanta.

These are local qualification results, not a replay of the production schedule, deployed-byte parity, live database recovery or proof that submission 2692 completed. No production target was mutated.
