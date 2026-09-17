# Typed-history migration ran without fencing legacy runtimes

## Incident

Deploy [35168145109](https://github.com/schani/pi-orb/actions/runs/35168145109) applied `022_typed_history_fields.sql` at `2026-09-17T01:38:06.336Z` without first stopping running orbs, contrary to the then-current manual requirement in `docs/pi-adapter.md`. A legacy `1fcc261` runtime continued writing after the one-time backfill. The deployment had no compatibility or typed-rejection boundary for later legacy-shaped writes.

The automated release itself completed with durable outcome `validated` at `01:53:47Z`; GitHub completed at `01:53:59Z`. That verdict covers its encoded gates, not the omitted fleet writer fence. Migration compatibility enforcement remains a follow-up.

## Evidence and impact

A read-only assessment at `01:57Z` found six live GCE-backed orbs: one running legacy `1fcc261` runtime (`056e8233…`, generation `1789594045`), three legacy `d110990` VMs still `archiving`, and two new `ec81e80` runtimes. The running legacy runtime inserted 44 rows after migration 022; the archiving runtimes inserted none.

The exact 022 predicates initially found zero missing shell, custom, subagent, inbox, failure, or patch projections among 119 post-migration rows in the bounded six-orb set at `01:57Z`. That result was valid at its cutoff, not a writer fence. Five later parent-orb edit-tool calls then persisted a native edit diff without top-level `patch`.

A fresh read-only check at `2026-09-17T02:19:49.331Z` found 117 post-022 rows for `056e8233…`: five missing patch projections and zero missing projections for each of the other five kinds. Each affected `ToolResultBlock.patch` is optional in `packages/protocol/src/history.ts`, and its raw diff remains at `overflow.native.message.details.patch`. `ToolActivity.tsx` uses the projection only for `+`/`-` counts and falls back to call status when absent. The verified impact is therefore five missing display statistics—not broken conversation, native-data loss, or SQL schema corruption. The three VMs observed as archiving still had zero post-022 rows at that cutoff. The normalized historical inbox proof found zero non-delivered messages for every inspected orb. No runtime was stopped or repaired during either assessment.

A read-only recheck at `2026-09-17T13:48:32Z` verified `056e8233…` on incarnation 2, generation `1789608844`, and image `ec81e80`. Its 192 post-022 rows still contained the same five missing optional patch projections; other missing-projection and proven-undelivered-message counts were zero. The three other inspected orbs remained archiving with no post-022 rows. No patch-bearing writes occurred after restart, so this did not exercise the new writer's patch mapping. No repair was performed. This is a bounded check of the known legacy orb set, not fleet-wide consistency proof. Evidence: `.context/deploy-35168145109/runtime-fence/post-restart-readonly.json`.

The assessment also considered inbox delivery. Migration 022 only adds `history_records.record.inboxMessageIds` (`apps/control-plane/src/adapters/pg/migrations/022_typed_history_fields.sql`). Normal replication marks `orb_messages` delivered only from the records in the current commit (`apps/control-plane/src/adapters/pg/store.ts`, `commitPullBatch`); a duplicate runtime acknowledgement can leave them `delivering` (`noteOrbMessageDelivery`), and lifecycle reconciliation does not rescan historical records (`apps/control-plane/src/domain/lifecycle.ts`). Therefore zero missing projections alone does not prove inbox delivery state is repaired.

Migration 023 applied at `01:38:25.184Z`. All three existing projects received verified owner `53da7ad4-6c53-4223-868e-0641bb4bcdd9`; project metadata was otherwise unchanged. The one personal-instructions row retained exact content hash, revision, and timestamp. The three `PI_ORB_ORIGINAL_*` bootstrap variables were removed after this verification; `PI_ORB_USER_ID` remains for future smoke selection.

## Cause

The stop-before-backfill requirement existed only as an operator instruction. Neither release preflight nor migration execution enumerated and rejected old runtime writers. Release preparation missed the manual step, while the durable result correctly reported success for every gate the workflow actually contained. The original recovery analysis also equated projection repair with complete repair; migration 022 has no `orb_messages` delivery side effect, so that conclusion did not follow.

## Superseding decision and follow-up

**Decided 2026-09-17:** manual fleet stopping is rejected as the standing migration mechanism. Supported old runtimes must continue temporarily: changed writes either remain safe through optional/defaulted fields with behavior-preserving handling, or are rejected at the boundary with a typed, durable, user-visible incompatibility outcome. That protection must become effective atomically with the migration/backfill. Behavior-sensitive fields are included: `inboxMessageIds` affects delivery state, so parse compatibility alone is insufficient. No generic migration framework, dual-write scheme, or concrete guard has been chosen or implemented.

The earlier proposed recovery required a dashboard stop/start, global legacy-writer fence, and migration replay before further work. The full plan was not completed and is superseded as a deployment prerequisite. The historical failure remains: release preparation missed the manual requirement that existed at the time, and no automated gate enforced it.

**Decided 2026-09-17:** no existing database patch repair is planned. The five absent optional display statistics are accepted, and their raw diffs remain retained. The bounded checks observed no other missing projections or inbox-delivery issue. Migration compatibility enforcement remains a follow-up.

## Rules

- A migration must preserve supported old-writer behavior or reject incompatible writes observably before commit.
- Migration/backfill and its compatibility or rejection boundary must have no unsafe write interval.
- Release evidence distinguishes encoded gate success from omitted operational preconditions.
- Bounded zero-defect queries are evidence for their named set and cutoff only.

Assessment artifacts: `.context/deploy-35168145109/runtime-fence/`. Follow-up work is tracked in `TODO.md`.
