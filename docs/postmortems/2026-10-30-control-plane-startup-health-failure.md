# Control-plane startup health failure after committed migrations

**2026-10-30, PDT. Instrumented recovery validated. Original startup cause unknown.**

## Authority and release

The user approved a 600-second migration retry and separate old-lock-only recovery; the old lock was released at **11:00:34**. The original 300-second failure remains unexplained: `docs/postmortems/2026-10-30-native-search-migration-timeout.md`. This retry does not identify that attempt's slow phase or waive its investigation.

[PR 234](https://github.com/schani/pi-orb/pull/234) merged as `71f81c8df1e4dfa7ce6d9868119af25930156dd2`, changing only three files. All ten exact-main, first-attempt jobs passed: [CI 41104096390](https://github.com/schani/pi-orb/actions/runs/41104096390), [E2E 41104096416](https://github.com/schani/pi-orb/actions/runs/41104096416), [Durable 41104096384](https://github.com/schani/pi-orb/actions/runs/41104096384).

One normal [Deploy 41110874347](https://github.com/schani/pi-orb/actions/runs/41110874347) dispatched source `71f81c8d`, release `r-1793386567-a6296f86-12db-46df-b774-585e05d59dc7`. Outcome: **applied-but-unvalidated**, schema **PASSED**, apply **FAILED**. Retirement, activation, smokes and official monitoring were skipped.

## Observed sequence

| PDT | Evidence |
| --- | --- |
| Before dispatch | Independent read-only PostgreSQL observer ready. |
| 12:13:50.064–12:21:05.368 | 436 samples show index building with granted parent-table ACCESS EXCLUSIVE; backend 39072, worker 39073. Observer retained 1,825 samples total. |
| 12:21:06 | Four `agent.owner_lost` edges; the same four agents later reacquired ownership. |
| 12:25:40.913, 12:29:43.928, 12:33:46.872 | Three platform startup TCP:8080 failures, each after the four-minute startup window. Terraform apply reported Cloud Run error 9. |
| 12:33:10 | Old application's search actually returned **503 unavailable**; PostgreSQL logged a missing legacy helper. |
| 12:35:47 | Latest retained normal own-history write after schema commit. |
| 13:05:49 | Last service receipt; old revision still serves 100%, new revision unready. |
| 13:35:40 | Normal runtime-authorized history-search tool still returns `unavailable`. |
| 14:00:55 | Fresh read-only service check still shows old revision at 100% and new revision failed. |

## Committed schema, incompatible serving search

Independent catalog reads establish PostgreSQL **17.11**, installed `pg_textsearch 1.3.1`, committed migration ledgers **052 and 053**, and valid/ready English BM25 expression index on `history_search_public_text(record)`. Legacy keys/tokens helpers are absent. `user_skills.files` is JSONB NOT NULL with default `[]`; `source` is nullable JSONB. Synthetic extractor privacy checks passed. The successful migration job's normal deletion was independently verified by 404.

The migration ledger's `applied_at` is a transaction timestamp, **not commit time**. The observer establishes this retry's build/lock phase, not the original 300-second failure's phase.

Old `pi-orb-issuer-00079-gfl` retained 100% traffic and active generation **1793332596**. New `pi-orb-issuer-00080-2j5` was Ready=False, `HealthCheckContainerError`. Health, discovery, JWKS, orb and history reads returned 200; history writes continued. Ownership reacquisition does not prove interrupted turns completed. Those successes do **not** establish whole-application health: old search queries no longer matched the committed schema.

Neither feature was fully rolled out: native search schema was new but serving search was broken; skill-import schema existed but the new UI/API was unserved and unvalidated. Zero service HTTP >=400 rows in the bounded 12:13–12:30 log query is not a monitor pass and does not contradict the later search 503.

## Startup evidence and limits

Exact control-plane image: `us-central1-docker.pkg.dev/playground-dev-6ae7/pi-orb/control-plane@sha256:97efae21e3d921fb451ce5e59fc17e41ab02f37050b12fcd1893190fade4e3c3`; amd64, Node **26.13.0**.

The first seven platform logs, a later eight-row capture including Cloud Run audit metadata, and all three startup failures are retained. No application stdout/stderr was captured; absence cannot locate the boot phase. New-revision CPU stayed below 0.5% of two CPUs and memory below 2.4% of 4 GiB during 12:20–12:30; these samples prove neither CPU nor OOM root cause.

Network-disabled local diagnostics used that exact image without host credentials. Main import took 2.25 seconds; bundled skills loaded in 14 ms (five skills). Temporary PGlite/FileSecrets/process-host composition and the inherited CLI each listened in about six seconds. Fake Google-auth composition also listened. Real PG/GSM/GCE/GCS constructors with fake configuration reached TCP in 0.24 seconds after import; later local database refusals were expected fixture failures, not production-health evidence. None reproduces the field failure.

Saved old/candidate metadata differs only in four native-image pins and host-spec generation. Command/args, ports/probe/resources, volumes and startup-secret references are unchanged. Actual nonsecret configurations pass the main identity, hosting, image-pin and issuer validators with explicitly fake secret payloads; actual secret values were not inspected.

The pg_textsearch descriptor has no top-level await, fetch or WASM initialization; the migration job also imported it successfully. CI image proof does not invoke real main or prove TCP readiness. Valid Google-mode startup awaits no database, GSM, GCE or GCS request before listen. Pre-listen boundaries include module evaluation, platform/filesystem work, constructors, Fastify registration and listen. Release activation and signing repair occur **after listen**; the retained lock alone cannot explain failed TCP startup. No blocking await or field root cause is established. A later read confirmed ordinary log routing: only the two OAuth callback URL exclusions exist. Invalid-cookie and thrown-filesystem offline cases print errors and exit; neither reproduces a silent live process.

Local harness failures remain separate: the first private daemon exceeded the Unix-socket 104-byte path limit, corrected with an owned short path. One initial main fixture missed its autonomous 60-second bound and lived 83 seconds before stop/removal. Subsequent fixtures used in-container GNU `timeout 60` with KILL after three seconds and an exit trap; a 0.2-second control returned expected exit 124. Originals are retained; no production fix is claimed.

## Protection and disposition

GCS release-lock generation **1793386569045462** was retained after the failed apply. No rollback, helper restoration, restart, reindex, deadline increase, redispatch or unlock followed before separate recovery authority. Its later exact-generation deletion is recorded below. Follow-up lives only in `TODO.md`.

Protected SQL settings, two users, two databases, ten backup metadata entries and PITR/backup configuration (14 retained backups; logs seven days) were unchanged; preload flag remained on. All thirteen secret parents and twelve version inventories were unchanged. MCP versions **1115–1118** were added and **1108, 1112–1114** destroyed by the existing control-plane service account; the initiating operation is unproven. Payloads were not inspected.

Two expected new native images were READY; recorded owned builder/validator VM/disk targets were independently absent, with no pending Compute/SQL operations. Three historical FAILED migration jobs remain. An additional normal orb VM and two disks observed at 13:05 were outside builder names and untouched; no globally unchanged-resource claim is made.

Observer PID 7937 was absent; all owned diagnostic containers were removed, and the private Docker daemon/managed containerd stopped, including after the later offline-only probes. Both R1/R2 access and invoker token files (four files), plus Docker client config, were deleted. Receipts: `~/deploy-e124/retry600-control/cleanup-final.json` and `local-image-diagnostic/offline-daemon-stop-proof.json`.

R2 expired at 13:11; its final probe's expiry guard stopped before any call. A separately acquired, fixed ACCESS-only credential later captured service/log-routing metadata at 14:00:55 and was removed; no invoker token or secret payload was read. Other protection claims retain their earlier capture times. The 13:35:40 search check used the normal runtime-authorized tool and still returned `unavailable`.

## Diagnostic direction

The separate privileged Cloud Run probe proposal was withdrawn without creating or pushing anything: matching production identity is not a sandbox, and guard instrumentation was expanding beyond the need. [PR 235](https://github.com/schani/pi-orb/pull/235) added content-free startup phases and default-command image coverage through normal release fences. Instrumentation landed; no root fix is established.

## Authorized instrumented recovery

After all ten fresh exact-main jobs passed, the approved old-lock-only recovery deleted generation **1793386569045462** with HTTP **204**. One normal [Deploy 41157512677](https://github.com/schani/pi-orb/actions/runs/41157512677) used main `da14295ece24ed4734ff6e903821d7e67eff0311`, release `r-1793411728-0e96c91b-3a88-4e06-9c96-4a087ce41735`.

At **19:12:49**, successor `pi-orb-issuer-00081-kbp` was ready with **100%** traffic. Its 33 server startup marks include `module.enter` at **10,202 ms** and `listen.complete` at **10,604 ms**, plus inherited worker-bootstrap extras. This successful boot does not explain revision `00080-2j5`: its startup cause remains **UNKNOWN**.

Initial unbounded log queries returned empty pages **with `nextPageToken`**, not proof of absence. Corrected bounded pagination captured logs. The complete October 30 **12:20–12:45 PDT** (19:20–19:45Z) query for revision 80 returned eight system/audit rows only, no application stdout/stderr; the old boot phase remains unlocated.

All GHA transaction gates, including native lifecycle and identity, passed. The authoritative monitor passed **19:26:49–19:44:54**: 1,084 seconds including the 180-second metric lag. Overall Deploy succeeded on attempt one. The monitor itself did not observe central inference.

Post-release checks verified generation **1793412534**, revision 81 at 100%, no release lock, four fixture 404s, ready native images, no pending Compute/SQL operations and the three historical failed jobs retained. SQL settings, users, databases and secret parents matched the fresh pre-release baseline; only the MCP version inventory changed. Both auxiliary operator bearers were removed; no operator identity mint occurred during the official window.

Normal runtime-authorized orb search tool and HTTP probes succeeded: **three hits, 90.8 ms**. Skill API/read DTO, hash, no-store and 401 checks passed; two roots were unchanged, with zero supporting files and zero imported sources. No import or config writes occurred. Project search separately exceeded its client's read bound; all-scope search remains unqualified (`docs/postmortems/2026-10-30-project-search-probe-timeout.md`).

The R2 guard refused **before mint** because the release phase had advanced to `retire`: only an attempt file exists, no bearer. No retry or operator Google mint occurred during the window.

## Resulting rule and evidence

Passed migrations stay committed when later apply fails. Inspect the actual serving revision, schema/catalog and relevant user-facing API together; static health alone is insufficient. Apply failure or unchanged traffic never implies database rollback. Operational invariant: `docs/deployment.md`.

Private evidence: `~/deploy-e124/retry600-control/{apply-first-failure/,run-71f81c8d-initial/{before/,catalog-after.json,retry600-observer/},local-image-diagnostic/}`. Independent parent/source reviews are privately receipted. The `~/deploy-e124/retry600-evidence-sha256.txt` manifest stays outside Git. Queries, corpus, hits, history bodies, credentials and user labels are excluded from Git.
