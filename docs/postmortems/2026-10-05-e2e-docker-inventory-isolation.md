# E2E Docker inventory isolation — 2026-10-05

## Incident and cause

The first gate failed on a missing Docker build-cache parent. The failed identities remain retained; targeted cache repair and an explicit no-cache runtime build preceded the next attempt. That attempt reported 256 passes before it was aborted for a different cause, not a test retry: startup orphan reconciliation stopped preexisting runtime `b43b807db615` on the shared daemon. The fresh E2E database had no row for it, while provider inventory enumerated all `pi-orb.orb-id` containers. Database isolation did not isolate provider authority.

The owned test group was stopped and the exact user container restored with its original image and volumes. Its start timestamp changed during this incident; the entire task did **not** leave it unaffected. Separate evidence: `.context/loose-ends/gate-summary-before-isolation.json`, `gate-isolation-root-cause.txt` and retained inventory snapshots.

## Correction and proof

The provider accepts an inventory scope, composed through `PI_ORB_DOCKER_INVENTORY_SCOPE`, and stamps `pi-orb.inventory-scope` on containers and volumes. Each fixture owns a UUID, retained across control-plane restarts. Scoped discovery selects the exact label; ordinary unscoped discovery excludes explicitly scoped containers. Container operations and volume deletion verify scope at the adapter boundary, returning typed conflicts for foreign mutation. Orphan reconciliation remains enabled; no prefix-based authority or safety bypass was added. The resulting invariant is in `docs/host-provider.md`.

Fake-provider regressions were red before implementation on labeling, scoped discovery and foreign Stop; `.context/loose-ends/isolation-{red,green}.log` preserves both outcomes. The real-Docker probe verifies exact scoped inventory, exclusion from ordinary inventory, foreign Stop refusal and continued foreign-host execution (`isolation-docker-probe.log`).

The subsequent fresh isolated **pre-review** gate passed 385 E2Es in 42 files without skips, 2,680 unit/DST tests in 340 files with twelve existing skips, 122 infrastructure checks (46 Node, 52 Python, 24 native VM), ten patch-runner tests, clean `npm ci` with zero audit findings, typecheck and lint without errors; existing warnings remain. Source inventory: `.context/loose-ends/gate-isolated-source-inventory.json`. Ledger: `gate-summary.json`; `docs/testing.md` retains the detailed proof.

During that successful gate only, all preexisting container IDs, image IDs, mounts and start timestamps remained unchanged. All eleven original volumes and preview services on 7100/5173 were preserved. Minimum available bytes were 15,038,103,552 on root (~14.0 GiB) and 24,129,536,000 on workspace (~22.5 GiB); the later rounded `df` display of 23 GB is not the minimum. Three event-attributed anonymous test volumes were removed. Two probe-time anonymous volumes were retained because container-to-volume ownership events were unavailable; timing alone did not authorize deletion.

## Review boundary

P1 review found another ownership gap: Docker's idempotent `volume create` can return an existing foreign volume without replacing its labels. Creation is not proof of ownership. The corrected provider inspects exact orb-ID and inventory scope after creation, before container run; mismatches return a typed conflict before mounting, and failed inspection prevents container creation. Ten added guard regressions preceded the correction.

The fresh final gate qualifies that guard and all current executable sources: 2,690 unit/DST tests in 340 files (twelve existing skips), 122 infrastructure checks, ten Node patch-runner tests, 385 default Docker E2Es in 42 files (zero skips), clean isolated `npm ci`, typecheck/lint without errors and zero audit findings. All 1,329 source files match SHA-256 `6a35bd7facec7f085fa0035fba0e02379b3cd7f3a524e95fa08df2c00af1689c`, without content, mode or path mismatches. Evidence: `.context/loose-ends/gate-final-summary.json`, `gate-final-source-inventory.json` and `gate-final-*.log`.

The final gate again preserved preexisting container identity, image, configuration, mounts and start timestamps, all eleven original volumes and live services on 7100/5173. Three anonymous PostgreSQL test volumes were removed using event ownership proof; the two unattributed earlier probe volumes remain. Evidence: `gate-final-preservation.json`, `gate-final-inventory-final.json` and `gate-final-owned-volume-cleanup.json`. Root `node_modules` and the intentionally old-source live backend were untouched; no broad prune occurred. These preservation claims cover the successful gates, not the original incident.

The historical WebKit pointer-interception cause remains unresolved (`docs/postmortems/2026-10-04-webkit-read-drawer-hit-test.md`); passing focused cases or this full gate do not clear it. User-reported real-Luna acceptance is separate from automated inference/transport proof. No commit, push or deployment occurred.
