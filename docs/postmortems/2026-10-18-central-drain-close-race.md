# Central deletion blocked by concurrent storage close

**2026-10-18; local qualification, not a production incident.**

## Evidence

The corrected PR 145 Docker full-slice run passed reasoning/tool, upload and peer-delivery assertions, then timed out waiting for self-deletion. Its target remained `deleting` with live compute. Original evidence: `/workspace/pr145-evidence/full-slice-local/green.log` and `self-delete-red/failure.json` under that directory. These artifacts do not establish the complete teardown ordering.

A separate unchanged-source diagnostic run captured control-plane output and deletion responses using an external preload, without changing assertions or deadlines. `self-delete-red/control-plane.jsonl`, `deleting.jsonl`, `database-proof.txt` and `diagnostic.log` establish: `delete_requested`, native `stale_owner`, cancelled tool, released owner, suspended Harness, then repeated `Agent drain ownership unavailable`. The SQL owner events include `draining` before `released`; compute destruction never ran. These are diagnostic-run observations, not an original-run trace.

## Cause

Deletion advances admission. A racing native write fails its owner check. Native `Session.fail` initiates close before reporting failure; storage closure races the adapter's `beginDrain`. The drain transaction can commit its owner-fenced event before activation finds closed storage. The adapter returned `closed` even though no writes remained possible. `DurableAgent.close` still joined teardown and released ownership, but cached that error. The manager retained the failed-close agent, so every deletion retry returned the cached error before host destruction.

## Correction and invariants

`PgDurableAuthority.beginDrain` validates the storage/owner identity and database owner fence even for closed storage. After successful validation, activation is unnecessary if storage has closed. Closed storage stays closed; admission and effect authority are not restored. Wrong owners, revoked leases, database outages and genuine resource-cleanup failures remain errors. Harness and resource teardown must still be joined before provider destruction.

Tests first reproduce the cached cleanup error with a real native task, PostgreSQL-backed storage and an explicit post-drain-COMMIT checkpoint. Adapter schedules cover close before validation and between COMMIT/activation, foreign ownership, revoked ownership and unavailable SQL. Composition checks held resource teardown, repeated disposal, provider destruction and HTTP `404`; a cleanup-failure control retains compute and the visible error. Evidence: `self-delete-red/composition-confirmed-red.log` and `closed-drain-red.log`. Initial composition setup failures are retained separately and are not regression proof.

No persisted state, lifecycle policy, timeout or assertion weakening is required. Final source/image/CI receipts belong to the PR, not this incident account.
