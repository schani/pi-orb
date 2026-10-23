# Agent lease loss followed by cached drain failure

**2026-10-23; production investigation, generic DST reproduction and local correction. Not deployed.**

[Replay bundle](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/e4190b14-4967-46ad-97ee-c998b94f2fec/evidence/pr179/replay-evidence.tar.gz) contains the original traces, qualification receipts and logs referenced below. Extract at the repository root before replaying. Archive SHA-256: `c98c4cd038402bab1d2dc35a4300793386e6d48ee7f422aa3035cd2a2ffcc602`.

## Evidence

Read-only Cloud Logging queries and the committed orb transcript for `b4ef7da2-5fc0-4a02-adef-ac63aaf447be`, fetched during this investigation. Cloud Run revision: `pi-orb-issuer-00070-v6q`, project `playground-dev-6ae7`. Times below are PDT (UTC−07:00), with UTC timestamps retained. Raw query results are retained locally in `/tmp/drain-window.json`, `/tmp/drain-heartbeats.json` and `/tmp/drain-sql-logs.json`; selected evidence follows.

| PDT | Evidence |
| --- | --- |
| 08:26:33–08:33:34 | Cloud SQL vacuum cutoff stayed at `26722227` (`15:26:33Z`–`15:33:34Z`). |
| 08:27:12.830 | Target's last `sleep renew agent owner` (`15:27:12.830Z`); a sleep edge is not a successful renewal receipt. |
| 08:27:13.412 | Last target transcript record: `toolResult` for subagent wait, interrupted by `parent_input` (`15:27:13.412Z`). No later records observed. |
| 08:29:41–08:34:31 | Other orbs' renewal activity stopped after `15:29:41Z`, returning at `15:34:31Z`. `codemode.memory` continued every ten seconds throughout. |
| 08:34:28.089 | Cloud SQL database `pi_orb`, PID `1010281`: `unexpected EOF on client connection with an open transaction` (`15:34:28.089Z`). |
| 08:34:28.762 | Target `agent.owner_lost`, fence `5` (`15:34:28.762Z`). Then `harness.reported_failure` / `execution_blocked`, owner release and Harness suspension. |
| 08:34:30.358 | `central-agent-unavailable`: `Agent drain ownership unavailable` (`15:34:30.358Z`). |
| 08:34:34 | Vacuum cutoff advanced (`15:34:34Z`). |
| 08:42:32.718 | Target transitioned `stopping` → `stopped`, reason `drain_complete` (`15:42:32.718Z`). |
| 08:42:33.108462 | `central-agent-unavailable`, same drain error (`15:42:33.108462Z`). |
| 08:42:33.108762 | `central-agent-recovery-failed`, `source=persisted_work`, `stage=open`, `code=history_unavailable`, message `Agent drain ownership unavailable`, `state_version=21`, `admission_version=0` (`15:42:33.108762Z`); then `central-reconcile-blocked` with the same error. |

The timing is consistent with a long-lived transaction holding up database progress, followed by expired agent ownership and blocked recovery. The original transaction, its statement, locks, client identity and termination cause are unknown. The cutoff does not identify a row lock or prove PID `1010281` held the blocking lock. EOF does not establish a crash, deliberate cancellation or network cause. Continuing memory samples exclude a continuous process-wide event-loop stall over this interval, not database waits or selective task blockage.

## Code-supported failure chain (pre-fix)

`apps/control-plane/src/adapters/durable/pg-persistence.ts` grants a 60-second lease and renews every 20 seconds. Renewal awaits SQL without a persistence-level deadline; any renewal error emits `agent.owner_lost` and aborts ownership. `apps/control-plane/src/adapters/durable-pg/index.ts` locks the orb row, then the owner row, and checks expiry using database time after locking. A renewal delayed beyond expiry cannot revive the lease. The observed lost-owner edge alone does not distinguish expiry from a database error or another owner fence.

The writable `PgClient` pool has ten connections and no configured acquisition, query, statement or lock timeout (`apps/control-plane/src/adapters/pg/client.ts`). Renewal and native mutations share that client. A long-held orb lock can occupy connections with waiting same-orb operations and starve unrelated renewals. This is a plausible amplification mechanism, not an established production pool deadlock. Inspected renewal/native commit/projection callbacks use the transaction-scoped query; no nested pool-acquisition cycle was found in those paths. Native public projection scans history within the transaction; its duration is unmeasured here.

Ownership abort invokes `DurableAgent.close()`. Drain still requires a valid database owner, including an unexpired lease; losing that authority can therefore reject drain. `pg-persistence.ts` collapses every drain cause into retryable `history_unavailable` / `Agent drain ownership unavailable`.

`apps/control-plane/src/adapters/durable/agent.ts` caches its first close result. Even when drain fails, it joins Harness/publication/resource teardown and releases ownership, then returns the drain error. `apps/control-plane/src/adapters/durable/manager.ts` retains an agent whose close failed; subsequent ensure/suspend/dispose attempts return that cached error instead of making a fresh recovery attempt. Thus database progress returning does not clear the in-process blocker. The reported release/suspension edges are compatible with failed close, not proof of recoverability. The later `drain_complete` transition completed compute stopping, not central agent recovery: persisted-work recovery immediately failed at open with the same error, without an admission-generation change (`admission_version=0`). This matches the retained failed-close blocker.

The earlier closed-storage activation race was corrected separately: `docs/postmortems/2026-10-18-central-drain-close-race.md`. That correction deliberately retains revoked/expired-owner failures; it does not clear this cached lost-owner path.

## Deploy correlation and authorized restart (2026-10-23)

Follow-up reads found failed Deploy `39973665889` (`cf0083e3`), release `r-1792768208-b61ad9b5-678b-4605-84f8-322c00b59ee0`. Its migration job logged `migration-started name="049_history_search.sql"` at `15:25:00.100504Z` (08:25 PDT), then the platform's 300-second timeout at `15:29:55.677393Z`; execution completion was `15:30:09.398378Z`, failed. The release stopped before application apply and retained its lock. The serving revision remained `pi-orb-issuer-00070-v6q`, image digest `ceba11a21e8f2c3d93cefbdb14a178689c95ba108c339b85a739abeea8ee00ad`, active generation `1792703743`.

Migration 049 builds a non-concurrent expression GIN index on `history_records`; its write-blocking index build is a concrete candidate for the stalled native history transactions and renewal waits. These logs establish temporal correlation, not the exact lock chain or ownership of the EOF backend. Failed-job output is retained locally in `/tmp/failed-deploy-39973665889.log`. The earlier claim of no established deploy link was made before inspecting this run.

The user authorized a single-operation control-plane restart, acknowledging interruption. `gcloud run services update pi-orb-issuer --revision-suffix=restart-20261023-1614 --async` returned success: `Service [pi-orb-issuer] is deploying asynchronously.` Only the revision suffix was changed; the request preserves image/configuration/generation and platform-managed replacement requires no follow-up start. This is incident maintenance, not deployment of the failed release. The retained release lock and activation pointer were left untouched. Issuance is confirmed; recovery was not independently verified.

## Correction (2026-10-23; implemented locally)

`PgDurableAuthority.beginDrain` first verifies its storage capability. A database owner-guard `stale_owner` result then returns typed `owner_lost` with its authority cause; it never activates drain writes. Foreign storage and SQL/transaction errors remain errors. The lease preserves the typed outcome/cause. Renewal abort alone is insufficient proof because database outages also abort renewal.

`DurableAgent.close` joins normal native Harness/storage closure, publication, summaries and resource teardown. Confirmed ownership loss is not a cleanup failure; successful retirement lets the existing serialized manager replace the agent. Native/resource failures still block replacement. Close now checks publication's returned `Result` instead of discarding it, so a real publication failure cannot masquerade as successful teardown. Manager policy and close-result caching are unchanged.

Failed authority release remains in persistence's pending releases. Concurrent callers share the in-flight receipt; only a failed release attempt is cleared, allowing later release/persistence-close calls to retry the idempotent database release without rerunning Harness/resources. Success or confirmed stale ownership removes tracking. This is release-only retry, not a general retry loop for arbitrary failed close stages.

Existing lifecycle edges retain bounded renewal/drain/release cause codes and final `drain_outcome`, `close_outcome`, `failed_stage`, `error_code` and `cause_code`. A suspended Harness can therefore be distinguished from successful overall close. Memory persistence reports identity/expiry/revocation consistently without renewing or synchronously aborting from drain. No persisted-state, schema, prompt, runtime-protocol or manager-policy change.

This fixes the reproduced lost-owner recovery/cleanup failures and the discovered publication-result/failed-release bookkeeping defects. It does not identify the original database lock chain or claim general SQL-failover qualification; remaining work is in `TODO.md`.

## Telemetry and qualification limits

Incident evidence cannot separate connection-pool wait, SQL execution, row-lock wait and transaction callback time, or associate the EOF backend with an orb/operation. Incident-time renewal/drain mappings discarded the underlying cause and suspension did not report the cached close outcome; the local correction adds those bounded fields. There is still no retained blocker/transaction correlation proving the original stall. Follow-up is tracked in `TODO.md`.

Existing `closed-drain.test.ts` covers closed-storage races and rejects revoked ownership/SQL outages; `drain.postgres.test.ts` covers admission/release fences; `storage.test.ts` covers expiry. They did not establish automatic recovery from this production lost-owner/cached-close chain. The initial investigation was read-only; subsequent generic DST reproduction follows below.

### Why the existing DSTs missed recovery

Inspection of the pre-fix suite found a composition/liveness gap, not evidence that more seeds alone would expose this scenario:

- `adapters/durable/manager.dst.test.ts` schedules real Harness shutdown against `MemoryStorage`, without `beginDrain` or PostgreSQL lease renewal. Its synthetic-manager close resolves successfully; the `fake close failed` rejection mapper is not an injected failure. `adapters/durable/memory-persistence.testkit.ts` models expiry/abort but makes drain/release unconditionally successful, excluding the failing shutdown combination.
- `adapters/durable-pg/atomicity.dst.test.ts` fixes the authority clock at zero. It explores admission/archive races and asserts native/public atomicity and stale-owner rejection, not expiry followed by manager recovery; its drain result is not asserted.
- `adapters/durable-pg/storage.test.ts` advances authority time and proves expired-owner fencing in isolation. `closed-drain.test.ts` proves revoked-owner drain rejection in isolation. Neither connects those outcomes to repeated manager reopening.
- `adapters/durable-pg/pg-composed-drain.test.ts` includes explicit scheduled drain cuts, but the persistence heartbeat uses `NoSimulationTask`; replacement is opened directly with `DurableAgent.open`, not through the retained manager. Its successful owned drain asserts `acquired → draining → released`, not lost-owner shutdown.

The broader `domain/central-work-campaign.dst.test.ts` asserts eventual completion, but does not inject lease loss and disables late timers; `testkit/central-work.ts` restarts through graceful close/recreation, clearing the manager rather than retaining its failed-close cache. Real `PgAgentPersistence` also uses database `clock_timestamp()` for authority, not the simulation clock: virtual heartbeat delay alone does not advance that deadline.

The missing invariant is conditional progress: once database service returns, old work/resources are joined, current admission permits execution and persisted demand remains, reconciliation must acquire a fresh owner and resume without restarting the control plane. Exercise that invariant together with stale-owner fencing and genuine cleanup-failure controls; isolated safety assertions cannot establish recovery.

## Pre-fix generic DST reproduction (2026-10-23)

The existing central-work campaign now includes an independent finite database environment actor. It samples two healthy/stalled interval pairs from entropy, without inspecting queries, owners, commands or results. A SQL-blind admission gate delays queries/transactions before PGlite execution; faults never return fabricated ownership errors or edit database rows. PgAgentPersistence's optional clock forwards to the existing authority clock seam; simulation uses floored virtual milliseconds, production still uses database time. No schema or recovery-policy change.

Generated programs combine accepted inputs/retries, poll/reconcile, model progress, idle and worker pauses. The database-stall mode retains the original manager. After environment completion, a healthy 90-second virtual suffix allows ordinary workers/model progress only. The oracle requires each acknowledged input's unique public receipt and answer, native completion, stable public operation identity and no duplicates, including inside one record. Batch/steering operation sharing is permitted only with persisted native identity and correct inbox provenance. Teardown errors are recorded separately, never substituted for a failed completion assertion.

Default seed 0 samples `healthy=2732ms, stalled=18044ms`, then `healthy=5173ms, stalled=65905ms`. Real owner validation fails after the second stall; the existing code rejects drain, joins Harness shutdown and successfully releases ownership at virtual `91854ms`. The retained owner row ends at fence `2`, `lease_until=0`. Despite healthy database access, only one agent was ever opened and ordinary reconciliation keeps returning the cached drain error. This is the production recovery mechanism reproduced without an expiry command, targeted failing call or manager reset. Seed 1 independently fails completion; seed 3 completes work but detects the same cached error during cleanup. Seed 2 passes.

Exact-source focused result: **12 pass, 3 fail** across the twelve campaign cases and three persistence tests. The eight healthy control campaigns and all three persistence tests pass. All three failing traces reproduce through explicit `DST_REPLAY`; typecheck, scoped Biome and whitespace checks pass. That pre-fix campaign was deliberately left red, without an expected-failure annotation or weakened assertions. The correction's results are recorded separately below; the original evidence remains unchanged. Current replay commands, source/trace hashes and compact owner/lifecycle evidence are retained in `test-failures/2026-10-23-generic-central-work-evidence.json`.

```sh
DST_REPLAY=test-failures/central-work-database-stalls-0-1792773724871-0.json \
  npx vitest run apps/control-plane/src/domain/central-work-campaign.dst.test.ts \
  -t 'database-stalls seed=0'
```

Initial model corrections were replayed before changing assumptions:

- `central-work-database-stalls-0-1792772851031-0.json`: unrounded virtual milliseconds caused bigint SQLSTATE `22P02`, including drain/release failure before any stall. A direct PGlite parameter probe confirmed the cause. Flooring the injected clock restores production's integer-millisecond contract. The first genuine expiry trace is `central-work-database-stalls-0-1792772919204-0.json`.
- `central-work-database-stalls-3-1792773144385-0.json`: the earlier single-input oracle assumed every message ID named a distinct native submission. Ordinary batching/steering disproved that before faults began. Correlation now uses delivery batches and stable persisted operation IDs; the synthetic model acknowledges all unacknowledged inputs. Duplicate-token/answer counts and inbox provenance checks remain independent of model deduplication.

These initial traces remain in `test-failures/`; local detailed logs are under `.context/generic-central-work/`, clock-contract red/green evidence under `.context/clock-seam/`. The model covers dependency-admission latency, not an actual PostgreSQL migration lock or connection pool. It proves the recovery defect, not the precise original production lock chain.

## Correction qualification

All three original traces explicitly reproduced before production edits (`.context/recovery-fix/pre-replay-{0,1,3}.log`). Tests-first core changes initially failed six assertions (typed owner-loss, joined outcome telemetry and discarded projection failure). Release-retention and memory-model tests separately failed before correction. Focused final validation passes **44 tests** across five files, including real cleanup-failure controls, capability/SQL rejection, expired ownership and successor fencing. The unchanged generic default campaign passes **12/12**. Root typecheck and lint pass (existing warnings/info remain). Final frozen-source qualification follows.

Exact old traces do **not** replay green on fixed code. Seed 0 diverges at position 327 after persisted evidence shows `owner_lost → owner_released(fence=1) → owner_acquired(fence=3)`; the recovered agent creates an additional renewal timer and shifts later timer IDs. Seeds 1/3 first diverge at positions 73/52 when replacement creates `lease-renewal sleep: renew agent owner` at the first database recovery (`t=64320ms`/`t=70892ms`), where old code cancelled activity after retaining failed close. Later entropy mismatches/unhandled replay errors are fallout from that changed trace shape, not a separate product failure or exact replay success. Logs: `.context/recovery-fix/post-replay-{0,1,3}.log`; original traces and assertions are untouched. Same generated seeds/programs pass in fresh simulations on the corrected code.

Final frozen-source validation passed on the first broad run:

- `PI_ORB_DURABLE_PG_TEST_URL=<owned PostgreSQL 16> npm test`: **5,159 Vitest tests pass**, 25 conditional skips; 656 files pass, 12 conditional skips. Infrastructure checks pass: **110 Node, 220 Python, 33 native-VM** tests. Actual PostgreSQL durable cases were enabled; the disposable loopback-only container was removed and absence verified afterward.
- Expanded generic database-stall seeds **4–31: 28/28 pass**; other campaign modes were explicitly filtered in that invocation. Together with default seeds 0–3, **32 generated database-stall seeds** pass without changing campaign source or invariants.
- `PI_ORB_E2E_BACKEND=process npm run test:e2e -- --project=lifecycle e2e/durable-process.e2e.test.ts e2e/full-slice.e2e.test.ts --bail=1`: **7/7 pass**, no skips. This covers real runtime/browser handshake, remote filesystem/shell, replication, controlled drain and replacement. It is scoped process-backed E2E, not the entire Docker E2E suite.
- Root `npm run typecheck`, `npm run lint` and whitespace checks pass; lint retains 447 warnings/87 infos. Qualified source checksums verified unchanged after validation.

Compact immutable qualification/source-hash receipt: `test-failures/2026-10-23-owner-recovery-fix.json`. Original traces and their pre-fix evidence are unchanged. No merge, deployment or production replay performed; the original production database stall remains separately attributed only as documented above.
