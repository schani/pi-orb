# First consolidation deleted the application, then stalled

## Impact

On 2026-10-06, [Deploy 37431686576](https://github.com/schani/pi-orb/actions/runs/37431686576) deleted `pi-orb`, `pi-orb-ops` and `pi-orb-runtime-api` during first-consolidation maintenance. Retirement timed out before migration or application apply. Production remained without its browser/API/runtime services; the previous issuer continued serving discovery/JWKS.

Read-only investigation confirmed the three services absent, the old browser URL returning 404, and issuer discovery returning 200. Issuer revision `pi-orb-issuer-00041-zcl` still serves the previous `d67de4c` image digest `sha256:2bcd07a4cf4bf2dca850ee649ad3fe152db353b33a878e5510524a6fb0f42a07`. The newly built application was never deployed.

## Evidence and timeline

All times UTC on 2026-10-06:

- 07:46:53: release `r-1791272808-351ab5e5-e1d8-47bf-828d-2d843e292ffc` starts from `17b00891383757b66ef4a1ba4062da97e72324ec`; preflight, exact-source qualification, build and plan pass.
- 07:58:14–07:58:29: Cloud Audit Logs record successful deletion of the three application services. Actions reports their completed deletion operations.
- 07:58:38: the cutover resets the retirement boundary and requires subsequent active/idle zeros for every inventoried revision.
- 08:05:00: latest explicit active/idle zeros for `pi-orb-runtime-api-00081-kbt`.
- 08:06:00: latest explicit active/idle zeros for `pi-orb-00079-2k7`.
- 09:13:47: the 75-minute retirement wait times out; the global release lock remains retained.

The authoritative [release artifact](https://github.com/schani/pi-orb/actions/runs/37431686576/artifacts/11401332343) records `phase=maintenance`, `outcome=failed-before-apply`, `applyAttempted=false`, `migrationJob=null`, 158 retirement targets, two proved targets and 156 pending targets. “Failed before apply” does not mean production was untouched: service deletion already happened.

## Cause

`infra/release_retire.py::inventory` unconditionally admits every name returned by the revision metadata listing. Its complete-preboundary-zero exclusion applies only to revisions already absent from that listing. The old ops/runtime services retained 157 revision names; together with the browser revision, this produced 158 targets.

`infra/release_cutover.py::retire` inventories before deleting the services, then advances `retirement.after` and clears `zeroes`. `evidence` requires fresh active **and** idle zeros after that boundary for every target. Retained revision metadata therefore creates a requirement for future process metrics even when the revision has already stopped emitting them.

Independent paginated Monitoring reads found only the browser and current runtime API revision in both the 16-minute preboundary window and the entire postboundary wait. Both reached explicit zero. The other 156 targets emitted no samples in either window. Historical ops reads establish that current ops revision `pi-orb-ops-00076-4zv` last emitted complete zeros at **2026-10-05 20:27 UTC**; seven older ops revisions also have earlier complete zeros. This is evidence of a metadata/metric mismatch, not evidence that 156 processes remained alive. Retirement of every remaining target was not independently established by this investigation.

Replaying the captured postboundary samples through the unchanged production `evidence` and `wait_for_retirement` functions deterministically reproduces the timeout: 158 targets, two proved, 156 pending. No cloud mutation is involved in this replay.

The cutover unit tests mock both inventory and retirement waiting. Sandbox qualification had no legacy application services. Neither covered this production combination of retained metadata and already-silent metric series.

The Actions-owned cutover change in `8998acf` reused the existing resource-based inventory, then reset its observation boundary after service deletion. The inherited rule already misclassified dormant retained metadata; the reset additionally rejects zeros emitted during deletion. Neither assumption matches sparse process metrics. Read-only inspection also found 41 retained issuer revisions, so fixing only legacy-service deletion would leave the following normal rollover vulnerable.

## Local correction (2026-10-06; undeployed)

Revision resources and observed processes now have separate evidence. The record retains every resource name in `resources`; unresolved positive metrics alone admit process targets. Retirement checks that old resources are absent and permits only the new serving revisions, disjoint from the old inventory. `resourcesRetired` durably records that fence plus a 180-second metric-visibility observation, and activation requires it. This uses the existing bounded Monitoring-observation assumption for discovering deleted-but-live instances; it cannot establish absence during a prolonged unreported telemetry outage.

The original pre-deletion boundary remains fixed. Polls reread its 15-minute lookback to catch delayed preboundary positives. A late-reported process that already stopped before inventory retains its complete fresh zero proof in `excluded`; both zeros must follow every observed positive. No observed positive is resolved by deletion, elapsed time or missing samples: both explicit zero states remain required, and newer positives, API errors and pending Compute operations block completion. The visibility interval covers the documented 60-second sampling plus 120-second ingestion delay; it is observation coverage, not termination proof (`docs/deployment.md`).

Tests exercise the real inventory, service deletion and retirement functions together with injected clocks: retained metadata, cold ops, zeros during deletion, delayed cold starts/preboundary positives, surviving resources and Monitoring failure before deletion. The incident cases failed on the original implementation. Replaying captured production data through the correction succeeds with 158 resource identities fenced and the same two explicit-zero process proofs. This replay is historical validation, not a live production-readiness attestation. Private red/green and replay evidence remains in `.context/incident-20261006/`.

Qualification passed: 182 infrastructure tests plus filesystem checks, 21 release-shell contract tests, lint and diff checks. The first infrastructure invocation stopped at the Docker-backed filesystem check because Docker Desktop was not running; its failure log is retained. Starting Docker corrected that environment prerequisite before the complete passing run. Full source CI/E2E qualification and production deployment remain outstanding.

## Recovery constraints

Preserve the failed release record, its two explicit-zero proofs and the retained lock. Qualify and merge the correction, review lock ownership and the original runner's termination, then clear only that exact lock generation before a fresh first-consolidation Actions release. Recheck service absence, current process observations and pending Compute operations before migration. A larger timeout cannot manufacture samples from silent revisions.

Recovery follows the existing main-branch Actions workflow after reviewed lock clearance. Automatic restoration of old controllers, database rollback and bypassing retirement remain rejected under `docs/control-plane-consolidation.md`. This investigation made no production changes and did not establish database/workspace integrity independently. Actionable recovery work lives in `TODO.md`.

Private local evidence: `.context/incident-20261006/` contains the authoritative release, failed Actions log, deletion audit receipt, independent service inventory, active pointer, raw Monitoring samples and summaries, and deterministic replay result.
