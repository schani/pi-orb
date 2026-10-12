# GlideOS: failed resources blocked delivery

Orb `92a3cea4-54e2-47a4-9510-367204c8b72c`, GlideOS ([glideapps/g3](https://github.com/glideapps/g3)). Cloud investigation is read-only; no production repair/deployment. Resource warnings, SQL retry and delivery presentation have focused local qualification; the subsequent execution-readiness correction and full-suite limits are separate below. Current local-status dates use America/Mexico_City; historical evidence retains its explicit source timezone.

## Read-only cloud evidence — 2026-10-09 (source timestamps: UTC)

- **14:58:21:** created; **14:58:25:** `resources.failed admission_version=0 code=invalid`, without a resource-specific reason.
- **14:59:15:** failed with `checkout_unavailable`, “invalid initial checkout response”.
- **14:59:48:** user message `d6b02556-299c-445f-9dd7-5777ddd94df7` queued; automatic wake moved `failed` → `starting`; `central-delivery-blocked`: central agent not open.
- **15:00:36:** retry VM i1 failed with `resource_acquisition_failed`; **15:25:25:** i2 failed identically; **15:25:41:** compute discarded.

`orb_transcript`: `state=failed`, `records=[]`, `headId=null`. The agent never opened; queued inbox input is not a committed transcript receipt.

## Local metadata reproduction; attribution pending

The historical `/tmp/g3-skill-audit.Spj3gr/results.json` audit used the exact vendored parser on fetched main tree `9550bc8df1e75c44bff52d5753f0b1c6d5d3cc0c`. All 42 skill blobs were fetched. Sole malformed YAML: `.claude/skills/update-entitlements/SKILL.md`, blob `5fb1d6a25d0bd9aee5d856ac8f1e7572a5076480`, exposed by `.agents/skills/update-entitlements` → `../../.claude/skills/update-entitlements`. Line 3's unquoted description contains a colon followed by a space; the parser returns `BLOCK_AS_IMPLICIT_KEY`. No other invalid/missing descriptions or duplicate names were found. Latest pre-incident commit touching the file: `080fef113e8e7398a0d2aea64f3af1b0d915ec5c` (2026-09-25 16:37:40 UTC). Earlier audit `ENOENT` entries reflected incomplete diagnostic downloads, not repository corruption.

This confirms malformed metadata on inspected main, **not the exact production cause**: the durable selected failed commit was unrecorded. Attribution remains pending. The first malformed checkout response is separately unresolved.

## Pre-change implementation findings

- `apps/control-plane/src/adapters/git-resources/prompt.ts:56-69` maps parser failure to invalid metadata; `apps/control-plane/src/adapters/pg/resource-gate.ts:70-84` logs only the failure code.
- `apps/control-plane/src/adapters/pg/resource-gate.ts:86-130`: `initialPin` refuses a stored non-storage failure in the same admission; `acquire` invokes it before the source. Normal Start from failed preserves admission (manual/sleep release advances it), poisoning retries.
- Inbox claim writes `delivering` before agent admission; retryable agent-not-open preserves it, and orb failure does not fail the inbox. The retryable rejection is at `apps/control-plane/src/adapters/durable/manager.ts:397`; the blocked edge at `apps/control-plane/src/domain/lifecycle.ts:2562-2567`. `apps/web/src/components/HistoryView.tsx:784-788` displays stored status, not proof of acceptance/progress.
- `apps/orb-runtime/src/pending-initial-checkout.ts:84-104` distinguishes invalid JSON/response from a valid 503 `resource_acquisition_failed`; the first response needs independent forensics.

Required invariant: delivery presentation must reflect admission/progress; explicit retry must intentionally permit resource re-acquisition without bypassing Stop authority. Follow-ups: `TODO.md`.

## Local implementation status — 2026-10-11 (America/Mexico_City)

Warning/skip for invalid repository skill metadata, reload-safe `OrbView.resourceWarnings` and failed-orb `blocked` presentation are implemented and focused-test qualified locally, not production deployed. The SDK's strict YAML `parseFrontmatter` parser is used; repository/platform name collisions, platform skills and Git/read/path/integrity/required instruction failures remain fatal. Durable snapshot/orb warnings expose only `{path, code}` (`invalid_yaml`, `invalid_utf8`, `invalid_metadata`, `duplicate_name`); pending inbox identity/status is preserved, and delivered-but-unreplicated rows remain delivered.

Explicit Start/current-failure queued wake from `failed` to `starting` advances admission only without an immutable snapshot and with a failed resource event for the current admission. Manual/sleep reopening advances once; successful snapshots and compute-only failures preserve active central admission. Contracts: `docs/lifecycle.md`, `docs/pi-adapter.md`, `docs/control-plane-api.md`, `docs/web-ui.md`. No incident recovery or resolution of the original malformed checkout response is claimed.

The barrier-corrected resource-retry process E2E exposed terminal failed central health being replaced by transient `central agent unavailable`, leaving the orb in `creating`. The tests-first local correction preserves typed initialization failure through execution readiness and lifecycle; **33 focused tests** and **51 regression tests** pass. After a separate fixture model-rule priority correction, scoped E2E passes **4/4** (two process, two Chromium; `e2e-readiness-fixed-scoped-final.log`); the preceding **3 passed / 1 failed** and its diagnosis remain retained. These results qualify pre-rebase source only. Integration onto `origin/main` `2c901ae` (Pi 1.1.0 and migrations 040/041) and normal exact-head GitHub CI/root/E2E gates remain pending; no PR or full repository/release qualification is claimed.

## Local evidence retention

Earlier local `/tmp` logs, including the metadata audit, were lost after compute failure. Prior reported RED receipts were **4 failed / 14 passed** for resources and **16 failed / 3 passed** for retry; their original logs are unavailable. New failure, replay and qualification logs are retained durably under `.context/delivery-fix/`; later greens do not replace first failures. Confirmed focused results: resources **66 passed**, retry **32 PGlite/DST passed** plus **8 actual-PostgreSQL passed**, optional actual-PostgreSQL snapshot **1 passed**, and UI/API/protocol **64 passed**. Scoped corrective E2E passes **4/4**; full exact-source unit/infrastructure and root static qualification remain incomplete; the aborted dependency-collision run, first E2E fixture failure and subsequent readiness-propagation product failure are retained separately. Current evidence and limits: `docs/testing.md`.
