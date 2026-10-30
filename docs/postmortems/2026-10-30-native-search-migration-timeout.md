# Native-search migration timeout

**2026-10-30, PDT. Failed deployment; no correction or retry.**

## Release

[Deploy 41078004710](https://github.com/schani/pi-orb/actions/runs/41078004710) selected approved `e124e9420e0e8abfb71834b7b7070fbd7517faf7`: native history search ([PR 231](https://github.com/schani/pi-orb/pull/231)) and pinned GitHub skill imports ([PR 225](https://github.com/schani/pi-orb/pull/225)). Both features and migrations 052/053 were authorized. Exact-main first-attempt qualification passed all ten jobs: [CI](https://github.com/schani/pi-orb/actions/runs/41011901420), [E2E](https://github.com/schani/pi-orb/actions/runs/41011901448), [Durable](https://github.com/schani/pi-orb/actions/runs/41011901349).

Authoritative release `r-1793373030-53ab473d-0081-43dc-850e-5ffc1af5cd0e` is **failed-before-apply**, exit 1, `applyAttempted=false`. Preflight, checks, native/image build and protected plan passed; schema failed. Infrastructure apply, application rollout, retirement, activation, smokes and official rollout monitoring did not run. Default migration task timeout remained **300 seconds**; no override, assertion change, waiver or redispatch.

The preceding preload release's original workflow failure and separately accepted isolated observation remain distinct (`docs/postmortems/2026-10-19-observer-mint-floor.md`; PR 233 retains the October 29 recurrence).

## Timeline

| PDT | Evidence |
| --- | --- |
| 08:23:03 | Schema stage entered. |
| 08:25:44.297 | Job logged `migration-started name="052_native_history_search.sql"`. |
| 08:28:55.524–08:32:41.481 | Old serving revision recorded 115 ingress HTTP 429s. |
| 08:30:35.153 | Platform terminated the task at its 300-second timeout. |
| 08:30:54.089 | Exact execution completed failed, one failed task, no running task. |
| 08:31:04 | GitHub workflow finished failure; release lock retained. |
| 08:32:40.008–.014 | PostgreSQL PID 29354 logged an 84,293,633-byte temporary file, the exact whole migration-052 SQL, then `unexpected EOF on client connection with an open transaction`. |
| 08:32:41–42 | Three central agents lost ownership with `stale_owner`; all closed with `drain_outcome=owner_lost`, `close_outcome=closed`. |
| 08:32:42–44 | Those three agents acquired successor ownership automatically. |

The job is `pi-orb-migrate-r-1793373030-53ab473d-0081-43dc-850e-5ffc1af5cd`; its sole execution is `pi-orb-migrate-r-1793373030-53ab473d-0081-43dc-850e-5ffc1a4696m`. Task termination did not immediately end the database backend. No migration SQLSTATE or `migration-failed` edge was captured. There is no migration-053 start edge.

## Observed state and impact

Postfailure read-only PostgreSQL checks establish:

- PostgreSQL **17.11**, preload includes `pg_textsearch`, preloaded `pg_textsearch.library_version=1.3.1`; Cloud SQL remains `RUNNABLE`, flag `on`.
- Neither 052 nor 053 appears in `schema_migrations`; `pg_textsearch` is absent.
- The original `history_records_search_idx` remains valid/ready, using GIN on `history_search_keys(record)`; both old keys/tokens helpers remain.
- `user_skills.files` and `.source` are absent. Synthetic public-text extraction still excludes reasoning/image/private overflow.
- The later index-progress view is empty; the captured later relation-lock sample has no ungranted locks. Neither sample describes the earlier stall.

The runner executes each complete migration and its ledger insert inside one explicit transaction; commit precedes its applied edge. The catalog and EOF/open-transaction evidence establish visible rollback of 052, not merely absence of Terraform apply. Neither feature deployed.

All 115 request rows explicitly report **“no available instance”**. They concern ordinary UI/project APIs and discovery, not the identity-token endpoint. The bounded old-revision query (08:23–08:36:30) has zero ERROR/HTTP 5xx rows and three ownership-loss edges. This was real preapply availability impact, not observer mint-floor noise. A production lock chain or exhausted connection/concurrency inventory was not captured.

A later bounded historical request read found **79 HTTP 200 requests lasting at least 30 seconds**: starts 08:25:52.522–08:28:52.525, durations 229.704–409.644 seconds, and inferred completion times (`timestamp + latency`) clustered at 08:32:41.222–08:32:42.529. Paths were hosted files (61), message polling (6), uploads (6), GitHub tokens (2), JWKS (2), orb metadata (1) and projects (1). The first 429 followed the last such request start by about three seconds. This supports a stalled-request/release burst, not a sampled pool/concurrency inventory or identification of the blocking SQL.

Later authorized metadata, history and search reads return 200; search returns a hit with no-store. Owner-skill API/runtime reads return unchanged roots. Ownership reacquisition proves that recovery edge, not completion of every interrupted operation or model turn. Central inference remains unobserved; no clean rollout-monitor result is claimed.

## Source-supported hypothesis, not established root cause

Migration 052 drops the old index before building BM25. PostgreSQL 17.11 [`RemoveRelations` / `RangeVarCallbackForDropRelation`](https://github.com/postgres/postgres/blob/REL_17_11/src/backend/commands/tablecmds.c) acquires `ACCESS EXCLUSIVE` on the parent table for ordinary `DROP INDEX`; transaction locks last until transaction end. This can block history readers as well as writers across the subsequent build.

`apps/control-plane/src/adapters/database.ts` shares one `PgClient` between stores and `PgAgentPersistence`. The writable pool has ten connections and no acquisition/query deadline (`adapters/pg/client.ts`); lease renewal uses that same client, every 20 seconds for a 60-second lease (`adapters/durable/pg-persistence.ts`). The observed Cloud Run revision permits 80 concurrent requests and one instance. Blocked history work → shared-pool/request saturation → ingress refusal and lease expiry is therefore a concrete hypothesis, **not a captured production wait chain**.

The whole-SQL statement, temporary file and late EOF do not identify which statement or phase consumed the time. An existing reader can delay the requested exclusive lock; a queued exclusive lock can also block subsequent readers before it is granted. No production lock sample establishes that sequence here. Query Insights is not configured; retained SQL logs contain no per-statement lock/progress timing. The initial retained application filter excludes ordinary `history-search:` completion telemetry. A later narrow 08:10–08:33 query returned zero such completion rows (including all-field search) and zero `/runtime/v1/history/search` request rows. Neither result excludes an uncompleted, direct-central or other-path search holding a reader lock. Instance-wide CPU reached its maximum, but does not attribute cost or distinguish CPU work from lock waits. A diagnostic `pg_stat_statements` read returned a typed invariant error; no statement timings are claimed.

At 09:09:34, a bounded read-only count returned **212,884** current history records in 924 ms. Heap size was 163,110,912 bytes; table including TOAST 1,433,788,416 bytes; TOAST total 1,270,611,968 bytes; total including indexes 1,564,401,664 bytes. These postfailure aggregates are not an as-of-migration count or corpus identity proof; the earlier `reltuples=144098` was a stale estimate.

Postfailure settings reads record one vCPU / 3840 MiB, `maintenance_work_mem=64MiB`, `work_mem=4MiB`, two maximum parallel maintenance workers and `pg_textsearch.memory_limit=2GiB`. These are postfailure configuration observations, not a sampled build execution plan. The diagnostic client's five-second statement timeout is its own read-only override, not the migration task's SQL deadline.

Parent-supplied historical qualification-13 receipts measured one actual same-expression English BM25 build on 208,143 rows at **127.311 seconds**, including implicit autocommit; index size was 78,094,336 bytes. That lab had two CPUs, uncapped memory and `maintenance_work_mem=256MB`; it did not time the whole migration 052. A later 26.119-second resume reused the index, not a second build. This is neither a production-equivalent budget/lock baseline nor attribution of this failure's slow phase.

A later parent-supplied controlled reproduction ran **unmodified whole migration 052** on the same 208,143-row fixture with one CPU, 3840 MiB and the observed build GUCs. Whole SQL took **142.615 seconds**; ledger insert plus commit completed at **142.642 seconds**. It observed one parallel worker, no blockers/OOM, a valid/ready 78,094,336-byte index and an 80,595,869-byte temporary file. All 142 lock samples held parent-table `ACCESS EXCLUSIVE`; the worker was predominantly CPU-bound, with five I/O-wait samples. Its `tp_worker_0.0` temporary file appeared near local completion. This does **not** reproduce the production task timeout or establish its slow phase; the fixture is not a current production-corpus identity proof.

The checksum-pinned upstream 1.3.1 source contains an `ii_Concurrent` serial-build path, a concurrent-validation callback (`src/access/{build,vacuum}.c`) and `test/sql/concurrent_build.sql`. That establishes intended support, not qualification of concurrent expression-index construction on Cloud SQL. Build subphase progress exists; it was not sampled during this failure. The current transaction runner cannot simply execute `CREATE INDEX CONCURRENTLY`.

Parent-supplied small deterministic characterization demonstrated `old transaction ACCESS SHARE → migration's ungranted ACCESS EXCLUSIVE → ten subsequent ACCESS SHARE readers queued behind the migration`. The shared pool had ten connections, none idle, and one waiting renewal stand-in; that stand-in remained unresolved while independent `SELECT 1` succeeded. Releasing the old reader allowed the small build and rollback to finish, restoring GIN/helpers with no extension or ledger entry. This is structural pool/lock evidence, **not the past production trace or an actual lease-expiry test**. A separate client-termination test retained the backend and exclusive lock until its barrier was released, then rolled back.

A small upstream concurrent-build exercise held `SHARE UPDATE EXCLUSIVE`, allowed concurrent insert/update/read and produced a valid searchable index. Cancellation returned SQLSTATE `57014` and left an invalid/not-ready artifact; concurrent drop cleaned it. This is not full-scale or Cloud SQL qualification. Local owned fixtures were stopped; no production repair followed these experiments.

## Proposals — not authorized changes

The resource-matched whole-migration run and small lock/pool models characterize mechanisms but do not reproduce the production timeout. Production phase attribution and release qualification remain incomplete; execution work is tracked in `TODO.md`.

Options for user decision are an online concurrent-build/cutover design or explicit maintenance with a justified, bounded SQL/task budget. The latter must account for backend work continuing after task death; a longer task alone is not a cancellation or availability guarantee. Neither option is selected. No nontransactional runner mode, extra index/state, resource change or timeout override is authorized here.

## Protection and disposition

Independent before/after reads show the entire serving service object unchanged: `c8aa6e96`, revision `pi-orb-issuer-00079-gfl`, prior digest, generation **1793332596**, 100% traffic. Active authority, discovery and JWKS are unchanged; the latest-attempt pointer names the failed release. Full SQL instance/settings, database/user metadata, secret-parent metadata, backup/PITR configuration and twelve of thirteen secret-version inventories are unchanged.

MCP OAuth versions **1103–1105** were added; **1099–1101** were destroyed. Audit metadata attributes the successful writes to the existing control-plane service account, not the deployment executor; it does not establish the initiating operation. A further destroy attempt returned code 9. Payloads were not inspected or changed by the executor. These deltas are not reported as unchanged secrets.

The four prerequisite fixtures still return independent 404s; this failed release created none. All four exact owned builder/validator VM/disk targets return 404, both accepted images retain their recorded IDs and `READY` status, and no Compute operations are pending. The failed migration job and generation-matched release lock remain intact. Two unrelated terminal October 23 migration jobs were retained, not mistaken for active/current-owned resources.

Fixed bearer files were mode 0600 under a mode-0700 directory and removed after final safety reads; no background observer remains.

Only one Deploy was dispatched. No SQL repair, reindex, restart, cancellation, timeout increase, rollback, unlock or cloud cleanup mutation followed failure. Operator probes used pre-acquired fixed access/invoker tokens; no official measurement window opened. Investigation and follow-up are tracked in `TODO.md`.

## Evidence

The narrow historical follow-up used one fresh ordinary access credential, pinned for read-only Logging/aggregate reads outside any monitor window, without an invoker-ID mint. Its fixed bearer file was removed afterward. First-failure evidence was not rewritten; new receipts are under `narrow-followup/`.

Private durable-home root on executor orb `1514edb4-eab4-4738-808c-9fdd50dbf779`: `~/deploy-e124/`. `first-failure/` retains the original workflow log, downloaded artifact, exact job/execution, SQL/request/lease logs, read-only catalog, diagnostic metrics and cleanup proofs; `first-failure-sha256.txt` hashes the retained files. Baselines and protected after-reads live alongside them. Queries, hits, history bodies and credentials are excluded from Git.

[Release artifact](https://github.com/schani/pi-orb/actions/runs/41078004710/artifacts/12990345718), extracted JSON SHA-256: `291996aec9c6c182168d448a26cf2997b2de76b68746370ce7a617f6e6d768fe`. Authoritative record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1793373030-53ab473d-0081-43dc-850e-5ffc1af5cd0e.json`.
