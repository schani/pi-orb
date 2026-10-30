# PostgreSQL 17 production upgrade

## Status (2026-10-29, PDT)

Normal [Deploy 40928556779](https://github.com/schani/pi-orb/actions/runs/40928556779)
deployed source/runner `05feb52b5ea213d8a49851c5ab692c43f1a67254` as
`r-1793298872-f7f0988e-06a2-4d7a-b074-ee6ae72a1d8f`.
All ten exact-main qualification jobs succeeded on attempt 1 (`docs/testing.md`).
Cloud SQL is `POSTGRES_17`, `RUNNABLE`; SQL independently reported `170011`.
The recorded release is **validated**, finished at 13:23:47 (20:23:47Z), with
all 12 gates passed, including lifecycle and identity. Post-release validation
is complete, but the separate rollout monitor ended **regression** and workflow
40928556779 completed **failure**. Deployment is not fully successful; the
monitor failure is not waived. No rerun, rollback or filter/guard bypass occurred.

All four fixtures (one project, three orbs) are recorded deleted, independently
confirmed by four HTTP 404s. The three owned orb VMs/workspaces, two native
VMs and two native disks are absent. Both published images are `READY`.
The release lock is absent and no Compute operations were pending at the snapshot.

## Upgrade and outage evidence

Operation `c6eb1026-15f3-4d1e-895a-efb200000032` ran
11:56:16–12:14:07, ending `DONE` without an error.
Cloud SQL's pre-upgrade backup `1793300616140` (PostgreSQL 16) and
post-upgrade backup `1793301066018` (17) are both `SUCCESSFUL`.
Endpoint, connection name, region, tier, edition, availability, backup/network
settings, database-secret versions and SQL-user metadata match the baseline.
This verifies metadata, not secret contents or a restore rehearsal.

Sanitized server events record fast shutdown at 12:03:27, fully shut down at
12:03:28, and ready for connections at 12:08:15; a second shutdown at 12:08:42
was followed by ready at 12:08:49. These bound server availability transitions,
not exact end-user outage or uninterrupted application recovery. The full
upgrade-operation duration is not the database outage duration.

## ANALYZE identity guard

At 13:15:31 the first scratch execution refused at identity validation, before
any `ANALYZE`: `inet_server_addr()::text` returned an IPv4 address with `/32`,
but the exact-IP guard expected the host alone. A read-only diagnostic proved
the target correct. The guard failed closed; it was not bypassed.

A tests-first scratch-only correction uses `host(inet_server_addr())` while
preserving exact target checks. The new projection assertion failed before
the change; all 26 offline tests then passed. The original script and refusal
receipt were preserved. This was not a release-code change or release rerun.

The corrected controlled execution completed `ANALYZE` for all 41 application
tables. After closing the writer, a fresh authenticated connection verified
advanced `last_analyze` statistics for every table; completion was recorded at
13:19:25. This proves the enumerated statistics refresh, not query-performance
improvement.

## Rollout-monitor failure

The window ran 13:23:51–13:42:45 PDT (20:23:51–20:42:45Z), 1,134 seconds
with 14 samples. Health was `ok` and SQL `RUNNABLE` throughout. Final counters
were one ERROR, one HTTP 5xx and zero HTTP 429s; no lifecycle regression was
observed. Central inference remained **unobserved**, not verified healthy.

The sole failing request was a headline-persistence POST at
13:30:30.931765 PDT (20:30:30.931765Z), returning HTTP 503 in 1.554454158 seconds,
for orb `1ccfa9fe-52cd-4ad8-ab3f-289b4b965864`. Read-only review of nearby
private events found the same orb's `running` → `deleting` transition,
`source=self`, `reason=delete_requested`, about 4 ms before `headline.completed`
reported `stage=persistence`, `outcome=unavailable`, `termination=not_retriable`
and about 1,540 ms elapsed.

**Leading explanation, not proven cause:** deletion wins the persistence fence,
and the SQL adapter returns `null`. The deployed source supports this path:

- `apps/control-plane/src/adapters/pg/store.ts:438–446` returns `null` when
  the locked orb is deleting (also for other invalidated authority).
- `apps/control-plane/src/domain/activity-headlines.ts:235` maps both a store
  error and `null` to `unavailable` at persistence.
- `apps/control-plane/src/http/activity-headline-routes.ts:42–68` maps that
  outcome to HTTP 503, with `retryable: true` despite the completion event's
  `not_retriable` termination.

Telemetry cannot distinguish `null` from a store error. SQLSTATE is unknown.
The retained SQL-error metadata query reports `matchingSqlErrorRows: 0` for
20:30:25–20:30:37Z (13:30:25–13:30:37 PDT), limit 100. This bounded absence is
not proof of the persistence outcome or absence of a database error.
No PostgreSQL 17 defect or historical persistence cause is established.

**Decision (2026-10-29, PDT):** the user approved focused investigation and
correction. The local correction separates expected persistence invalidation
from real store errors and adds safe completion diagnostics
(`docs/activity-headlines.md`). Focused local tests, PGlite contracts and static
checks passed before subsequent combined exact-main qualification and corrective
deployment below. Qualification receipts and unchanged replay/suite limits are in
`docs/testing.md`; local evidence is under `headline-fix/` beside the original
production receipts below. The historical production cause remains unproven and
workflow failure unwaived. The corrective rollout result is recorded below.

## Evidence

Token-free receipts remain in
`$HOME/.local/share/pi-orb/pg17-production-20261029/`:
`release-validated.json`, `fixture-absence-final.json`,
`native-resource-absence-final.json`, `resource-cleanup-final.json`,
`compute-images-final.json`, `compute-pending-final.json`, `lock-final.stderr`,
`qualification-*.json`, `sql-upgrade-operation.json`,
`backups-after.json`, `unchanged-baseline-checks.json`,
`sql-availability-events.json`, `analyze-receipt-identity-refusal.jsonl`,
`analyze-receipt.jsonl`, `analyze-identity-diagnostic.json`,
`identity-fix-tests-receipt.json`, `rollout-summary.json`,
`rollout-error-summary.json`, `rollout-error-metadata.json`,
`rollout-sql-error-summary.json` and `workflow-final.json`.

## Corrective release (2026-10-29, PDT; workflow success, rollout observed)

User-approved combined Node 26/headlines and explicitly PR 228 cooperative
retirement shipped through normal [Deploy 40986634860](https://github.com/schani/pi-orb/actions/runs/40986634860),
dispatched at 18:34:20 after the 15:35 not-before. Source/runner
`0f52ae6cd795f2b83fd0b6b71e31790eb36ba25c` passed all ten exact-main jobs on
attempt 1 (`docs/testing.md`). Release
`r-1793324145-ba8aa6fe-8673-43be-9afb-2d5bca55c463` validated at 19:11:07;
all 12 gates passed, including the normal schema/migrator gate and native
acceptance. No search feature/extension, preload flag or new SQL migration file
was included. Read-only SQL verification confirms `pg_textsearch` is neither
installed nor preloaded. This was not another database major-version upgrade.

Serving revision `pi-orb-issuer-00078-r22`, generation `1793324912`, uses
`sha256:20ff6928c562053c1b3e8c7d9bc120fa6554df8395bcaec1d45155994abb09b6`.
Active authority matches and retains retirement cutoff `1793324911`.
Independent predecessor zeros preceded activation at 19:00:00; first-handover
limits and observer interruptions are in
`docs/postmortems/2026-10-29-pg17-production-interruption.md`.
All four fixtures independently return 404; their VMs/disks and all four native
cleanup resources are absent. Images `pi-orb-image-v-0f52ae6c-4cfec022089e459d`
(ID `5476221122335623365`) and `pi-orb-image-workspace-v-0f52ae6c-4cfec022089e459d`
(ID `7067460596598197046`) are `READY`. Release lock is absent and no Compute
operation is pending at the final snapshot.

SQL remains PostgreSQL 17.11 (`170011`), primary and `RUNNABLE`. Endpoint,
connection name, region, tier, edition, availability, network/backup/PITR settings,
database flags and database-secret versions match the protected baseline.
Fresh original-credential authentication and all 41 original `last_analyze`
timestamps are confirmed; **ANALYZE was not repeated**. Original pre/post-upgrade
backups remain `SUCCESSFUL`; latest automated PostgreSQL 17 backup
`1793318400000` is also `SUCCESSFUL`.

The independent full monitor ended **observed** for **19:11:11–19:30:02 PDT**
(October 30, 02:11:11–02:30:02Z): 1,130 seconds, 14 samples, all health `ok` and
SQL `RUNNABLE`, zero ERROR/HTTP 429/HTTP 5xx. One `compute-discard` and one
`compute-discard-requested` were nonregression events. Central inference remained
**unobserved**, not live-provider verification. Workflow 40986634860 completed
**success on attempt 1**. The uploaded release artifact exactly matches the
durable validated record. These receipts do not rewrite the original failed
monitor or establish its historical cause.

### Fleet warning: classification pending

The final fleet gained one `setup_failed` detail on the still-running parent orb
`973fb397-1897-4cdb-bd51-7a47a283482a`, hook `setup`, state-change timestamp
**19:28:44.717 PDT**. The other failed orb, `dbe40ba4-6860-4d70-b119-31be81985fcd`,
was already failed on October 9. Read-only parent-local diagnostics were requested;
the warning's reason and classification remain **pending**, not an established
deployment regression or a resolved warning. The user was informed at the last
check before final signoff. The investigation is tracked only in `TODO.md`.

Corrective evidence is separate from the original inventory:
`$HOME/.local/share/pi-orb/headline-corrective-release-20261029/`:
`release-validated.json`, `active-final.json`, `protected-baseline-final.json`,
`sql-private-verification-final.json`, `backups-final.json`,
`fixture-absence-final.json`, `native-resource-absence-final.json`,
`resource-cleanup-final.json`, `compute-images-final.json`,
`compute-pending-final.json`, `lock-final.stderr`, `rollout-summary.json`,
`workflow-final.json`, `fleet-failure-metadata-final.json`,
`excluded-feature-verification.json` and `final-evidence-sha256.json`.
Final workflow artifacts: `artifacts/release-40986634860-1/release.json` and
`artifacts/rollout-monitor-40986634860-1/rollout-monitor.json`.
