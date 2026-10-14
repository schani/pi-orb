# History migration 044 deadlock

## Incident

[Deploy 38478055943](https://github.com/schani/pi-orb/actions/runs/38478055943),
attempt 1, source `ecdc74351cd4e56a445e827ee3165940f704f521`, failed
in schema before application apply: `failed-before-apply`,
`applyAttempted=false`, exit 1. GitHub artifact `release-38478055943-1`
(ID 11857745355) matches the durable GCS release record.

Times on 2026-10-13, America/Los_Angeles (PDT):

| Time | Evidence |
| --- | --- |
| 16:00:33.794 | Release entered schema phase |
| 16:01:54.034 | Migration 044 started |
| 16:02:45.212 | Cloud SQL backend 384062 reported deadlock |
| 16:02:45.214 | Server detail identified both statements and lock waits |
| 16:02:45.359 | Migration job logged `migration-failed code=unavailable` |
| 16:02:45.491 | Container exited 1 |
| 16:02:48.696 | Execution failed with `NonZeroExitCode` |

The job had one task, no retries, a 300-second timeout and one recorded
execution. This was a PostgreSQL deadlock, not a Cloud Run timeout or an
older failure covered by a waiver.

## Proven cause and limits

Sanitized server detail:

```text
Process 384062 waits for AccessExclusiveLock on relation 16588 of database 16565; blocked by process 384039.
Process 384039 waits for AccessShareLock on relation 16610 of database 16565; blocked by process 384062.
```

Backend 384062 ran 044: ALTER `history_records`, then ALTER `orbs`.
Backend 384039 ran the recursive history SELECT matching `pullHistory`
at the release SHA in `apps/control-plane/src/adapters/pg/store.ts`.
That transaction first SELECTs `orbs`, retaining its AccessShareLock,
then reads `history_records`.

The migration held history and waited for orbs; the reader held orbs and
waited for history. Mapping relation 16588 to orbs and 16610 to history is
**inferred from statements and lock modes**, not observed in production
`pg_class`.

**044 did not commit in this execution.** PostgreSQL selected the migration
as victim, aborting its transaction. The runner executes each migration
and its ledger INSERT in one transaction and rolls back on error.
Neither ALTER nor the 044 ledger entry could commit from this attempt.
No migration-applied event exists; only 044 started. Previously committed
migrations are not rolled back.

This is an exact-source and transaction-semantics conclusion.
**Production catalog, column types and migration ledger were not queried.**
No database credentials or history payloads were retrieved.

Application apply was never attempted. Prior issuer revision
`pi-orb-issuer-00054-mg2` remained Ready with 100% traffic at 16:07:20 PDT.
At that observation, the release lock remained owned by this release/SHA;
authorized cleanup subsequently removed it (below). Earlier builds and
native cleanup had already run; failed-before-apply does not mean the
release had no side effects.

## Rejected ordered-lock attempt (2026-10-13)

The first attempt locked orbs, then history, before either ALTER:

```sql
LOCK TABLE orbs, history_records IN ACCESS EXCLUSIVE MODE;
```

Two-session RED/GREEN proved this removes the original snapshot-reader cycle.
Reviewer identified the inverse-order `readHistoryRecord` JOIN. Before any
further fix, an owned three-session probe ran the real runner against the
complete pre-044 schema and extracted that exact current SELECT from `store.ts`:

1. Snapshot holds shared orbs; migration queues exclusive orbs.
2. Record SELECT holds shared history and queues shared orbs behind migration.
3. Snapshot COMMITs; migration holds exclusive orbs and waits for history;
   record reader holds history and waits for orbs.
4. `pg_locks` and `pg_blocking_pids` confirm both directed waits.

The probe uses no sleeps or detector/victim assumptions. Session-local
`deadlock_timeout=1h` stabilizes inspection; statement deadlines bound failure.
Cleanup cancels only the exact PID/application-name-owned migration
(SQLSTATE `57014`), drains both queries and drops only its schema.
No global PostgreSQL setting or production resource changes.

Evidence: `.context/migration044-fix/three-session-proof.{mjs,log}`.
Ordered blocking locks are insufficient. Changing only new reader SQL would
not protect already-live old readers.

## Approved correction (2026-10-13; subsequently deployed)

Attempt both exclusive locks with NOWAIT inside an exception subtransaction
catching only `lock_not_available` (55P03). Contention rolls back partial
locks before backoff. Use 120 attempts, with 0.25 seconds between attempts:
119 backoffs, at most 29.75 seconds of scheduled sleep, **not** a wall-clock
bound on SQL execution or scheduling. Exhaustion rethrows 55P03 before DDL.
The Cloud Run request deadline remains 300 seconds.

Both existing ALTERs remain outside the acquisition block and run once,
under both locks, in the existing migration/ledger transaction.
No pair-table lock is held or queued during backoff; already-live readers
in either order can finish. Persisted schema, data checks and conversion
are unchanged. This addresses the demonstrated pair-lock cycles, not all
possible DDL/catalog contention. Exclusive conversion still blocks access.

This is bounded lock acquisition, not whole-migration retries. Rejected:
fail-fast NOWAIT (rejects transient reader contention), new-reader-only SQL
changes, HTTP quiescence (broader release machinery), blind migration retries,
larger release timeouts, compatibility staging and a generic migration framework.

Contention logs once at attempt 1; acquisition logs only after contention;
exhaustion logs attempt count and SQLSTATE. These content-free `RAISE LOG`
edges survive transaction rollback in durable Cloud SQL logs. Uncontended
acquisition adds no lock log.

The migration-failed lifecycle event also includes optional validated
five-character SQLSTATE from the adapter; typed error classification is
unchanged. Filenames and outcomes remain logged without database messages,
parameters or payloads. Durable job and Cloud SQL logs diagnosed this incident,
but `unavailable` alone obscured deadlock SQLSTATE `40P01`. No new persisted
state is introduced.

## Tests-first proof and qualification

`apps/control-plane/src/adapters/pg/history-migration.contract.ts` runs the
real runner against real PostgreSQL, with an owned schema and two sessions
(three for the mixed-reader case). It is registered in the opt-in PostgreSQL
unit suite and `e2e/postgres-store.e2e.test.ts`.

The schema shadows unqualified `pg_sleep` using explicit
`search_path=<owned schema>,pg_catalog`. Its test-only function validates the
quarter-second argument, counts backoffs through a sequence and blocks on an
owned advisory gate. Live lock inspection observes that gate after contention
rollback, asserting **no granted or queued lock on either table**.
There are no test timing sleeps or production hooks/configuration.

Five cases cover snapshot commit, a history-only holder releasing the partial
orbs lock, the exact inverse-order record SELECT completing during backoff,
exhaustion after 119 backoffs, and failure at the runner's ledger INSERT.
They verify types, data, constraints, ledger and applied events on commit or
rollback. Cleanup releases owned transactions/gates, drains migration and drops
only its schema; it kills no backends.

Before NOWAIT implementation, all five cases failed at the stable lock checkpoint:
blocking orbs acquisition, or a held orbs lock while waiting for history.
After implementation, all five observe only the test advisory wait and pass.
SQLSTATE mapping/logging tests pass too: 25 focused tests. Source contracts
guard the attempt/backoff budget, narrow catch, DDL placement and edge logs.
Sanitized PostgreSQL logs show five contention edges, four acquisitions at
attempt 2 and one exhaustion at attempt 120, including rollback-surviving edges.

Additional scoped checks pass: 17 PGlite/history/migration/MCP DST tests,
root typecheck (including E2E), and root lint (warnings/information, no errors).
At this local checkpoint, no full CI/E2E qualification was claimed.

Evidence under `.context/migration044-fix/`:

- Original two-session `red-lock-order.log` / `green.log`, retained despite
  the rejected design.
- `nowait-red.log`, `nowait-green.log`, `nowait-telemetry.log`.
- `affected-scoped.log`, `typecheck-fixed.log`, `lint-fixed.log`.
- Full HEAD typecheck passed; full HEAD plus only optional SQLSTATE reproduced
  MCP OAuth neverthrow inference failure at lines 349–350. A return-type
  annotation corrects it without behavior changes. Preserve
  `full-head-typecheck.log`, `head-plus-sqlstate-typecheck.log` and the original
  `typecheck.log` / `e2e-typecheck.log`; this was change-induced, not baseline.
  The incomplete-source baseline probe is not valid baseline evidence.
- An initial SQL_ASCII fixture rejected migration 029's Unicode SQL literal.
  Its `red.log` and server log remain. An explicitly UTF8 database corrected
  that harness defect before the lock-order RED.
- The earlier broad affected-suite invocation exhausted its 240-second command
  budget after 35 completed files / 223 passing tests, with no recorded test
  failure. `affected-tests.log` is partial evidence, not a full pass; it was
  not rerun to obtain green.

Local server: owned PostgreSQL 15.19 cluster on a private Unix socket;
Docker CLI had no daemon. `npm ci` preceded checks. Disk remained above
44 GiB free on the workspace and 14 GiB on root.

## Evidence and release boundary

Original first-failure evidence remains unchanged in
`.context/deploy-38478055943/failure/`: `SUMMARY.md`, `SHA256SUMS`,
sanitized Cloud SQL lock/statement metadata, job, execution, source provenance
and release records. Hash verification passes. Source timestamps stay UTC.
No raw cloud log bundles, credentials, parameters or history payloads were
persisted by the investigation.

The implementation task performed no production SQL, cloud mutation or
release dispatch. Subsequent user-authorized administrative cleanup completed
on 2026-10-13 at 16:18:31 PDT:

- At 16:17:25, deleted only terminal migration job
  `pi-orb-migrate-r-1791931754-5a35aa8c-7872-421c-915b-aec0d87788`
  with its freshly verified etag. The operation completed without error;
  the exact job/execution were absent before unlock.
- At 16:18:22, removed only the original release lock with
  `ifGenerationMatch=1791931755981435`; immediate and final reads confirmed
  absence. Fresh runner, owner and serving guards preceded both deletes.
- Old serving revision `pi-orb-issuer-00054-mg2` at 100% traffic, active
  pointer `r-1791912462-55378f74-c84f-4aa0-9c5b-3e8d8da6f0d3` and the
  failed release record/body/object generation remained unchanged.

Evidence: `.context/deploy-38478055943/failure/safety/cleanup/`
(`SUMMARY.md`, guarded request receipts, operation/absence proofs,
`verification.json`, `SHA256SUMS`). The first verifier incorrectly required
an execution-list 404 rather than a complete empty 200 collection; its
failure evidence remains, seven offline guard tests passed after correction,
and continuation revalidated all guards without replaying job deletion.

Cleanup made exactly two guarded DELETEs, no SQL, release-record write or
workflow dispatch/rerun. Production catalog, column types and migration
ledger remained unqueried. Cleanup did not deploy the correction or validate
the failed release; local checks were not deployment qualification.

## Deployed qualification (2026-10-13, PDT)

Exact source `66479dffe6da964b5b2e50094a7d9852949ba213` passed first-attempt CI, Docker E2E and Durable qualification. All five real-PostgreSQL lock/rollback cases passed in CI and Docker shard 4 (ten executions, no skips). [Deploy 38484755289](https://github.com/schani/pi-orb/actions/runs/38484755289) recorded 044 applied at 17:05:57 and all twelve transaction gates validated at 17:41:28. No migration-job ERROR rows were found. Actual production contention/acquisition/exhaustion edges were unconfirmed; production catalog/ledger were not queried. The original failed release remains failed.

The separate monitor reported `regression` and failed the workflow; neither a clean monitor nor elimination of all DDL contention is claimed. Exact evidence: `.context/deploy-38484755289/{qualification,artifacts,verification}/`; outcome: `docs/deployment.md`; anomaly attribution: `docs/postmortems/2026-10-13-rollout-monitor-anomalies.md`.
