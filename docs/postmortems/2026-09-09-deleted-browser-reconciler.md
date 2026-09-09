# Deleted browser revision continued reconciling after release

## Observed failure (2026-09-09)

After application release `a02638e` and the userspace-Tailscale harness correction (`fb8b465`), the complete lifecycle smoke passed in 221 seconds. The subsequent workload-identity gate failed before minting: fixture orb `6564da3b-e5ee-474f-97b5-3238f887c01b` entered `failed` with `clone_failed: fatal: ambiguous argument 'HEAD'`.

Cloud Logging establishes a mixed-generation provision/discard race during that boot:

- At 03:27:43, the new browser revision reported a newly created workspace disk with the wrong accepted image identity.
- New revision `pi-orb-00049-dpj` repeatedly reported racing/instance specification mismatches, then requested discard of incarnation 0 for `host_spec_changed` at 03:27:59.
- At 03:28:52, old revision `pi-orb-00048-tnf` emitted `spec-replacement-declined committed_generation=1788922912 configured_generation=1788844394` for the same orb.
- Incarnation 1 was subsequently provisioned; at 03:29:45 it failed the checkout's `rev-parse HEAD` validation.

The old revision's deletion had already succeeded at approximately 03:06 in the original release. Nevertheless it was still emitting poller/reconciler/project-deletion activity at 03:38. Revision-resource deletion and zero assigned traffic did not establish that its running process had stopped. The confirmed stale actor was the old **browser** revision, not merely an old ops/runtime revision left in inventory. No unrelated ops/runtime revisions were deleted during diagnosis.

The race and continued old process are proven. An interrupted initial checkout is a plausible explanation for the later `HEAD` failure, **not yet a proven filesystem-level cause**. The identity smoke's cleanup deleted its fixture before disk inspection; do not erase or rebuild a retained user checkout on that inference. Further investigation is tracked in `TODO.md`. Source inspection also confirmed that both the old `a80e66d` native image and the new runtime used temp-clone/rename; that alone does not establish crash durability or explain the missing `HEAD`.

## Evidence and containment status

- `.context/release-a02638e/release.log`: original apply, IAP reconciliation, and successful old-revision deletion.
- `.context/release-a02638e/postdeploy.log` / `postdeploy.exit` (`1`): corrected lifecycle pass and the first identity-gate failure.
- `.context/release-a02638e/wif-lifecycle-allowlisted.json`: timestamp, revision and lifecycle-message evidence, without request metadata or credentials.
- `.context/release-a02638e/revisions-before-containment.json` and the two service snapshots: current traffic assignments and historical revision inventory.

All three owned smoke projects were confirmed absent through the API after cleanup, including both identity fixtures. The global/local release locks were removed and no release/smoke process remains. The accepted application image remains serving; no rollback, additional application apply, arbitrary revision deletion, or user-workspace repair was performed. At that point the identity gate was **not** validated and was not retried for green; the later isolated validation is recorded below. The optional separately bootstrapped GCP federation legs were also disabled; the earlier isolated real-project federation/permission verification remains a separate passing result.

The existing `--quiesce` path deliberately refuses tagged browser traffic. Hosted files now require a `files` tag, so it is not currently a usable maintenance path without a reviewed correction. It also inventories revision resources, which omits the already-deleted but demonstrably active revision in this incident. A safe drain must account for actual old processes, preserve/restore the exact files routing and IAP policy, and establish quiescence before claiming the next gate is isolated. Do not bypass those guards or regard deletion alone as proof.

## Observed retirement and isolated validation

The user authorized a UI pause only with guaranteed restoration. Before introducing downtime, a fresh observation at 04:28 found the old revision had already logged `boot: shutting down` at 03:50:06. Monitoring reported explicit zero **active and idle** counts for it through 03:57, while the new revision alone had one active instance at 04:28. There was no pagination left unread. This was independent evidence of retirement, not a wait followed by a convenient passing test.

No browser scaling, routing or IAP mutation was made. No maintenance process or watchdog was needed. The remaining identity gate alone ran under the global release lock and passed in 193 seconds: both fresh orbs booted, mint/signature/claims verification passed, stopped minting returned `403 not_mintable`, and an unknown bearer returned `401 unauthorized`. The optional STS tier remained explicitly skipped. Four-service snapshots before and after matched exactly, including the declared image digest and host-spec generation. The test project was confirmed absent after cleanup; browser scaling remained automatic, its `files` tag still routed 100% to `pi-orb-00049-dpj`, IAP's exact member remained `domain:heyglide.com`, and anonymous browser access returned the expected authentication redirect (302).

Evidence is in `.context/release-a02638e/final-validation/`: `old-shutdown.json`, `instance-counts.json`, `run.log`, `run.exit` (`0`), the serving snapshots, `browser-restored.json` and `iap-members.json`. A preceding preflight attempt found OpenTofu missing after compute replacement; it created no fixtures, its log was preserved, and the same 1.12.6 version recorded in deployed state was reinstalled with checksum verification before the actual gate.

The original failure remains unexplained at filesystem level and the rollout-isolation defect remains open. Passing under a now-isolated generation does not retroactively fix either. To preserve evidence next time, the identity smoke now retains failed cloud fixtures, prints their IDs and cost warning, and removes local credential scratch through its exit trap; successful fixture cleanup is unchanged. Deterministic shell tests cover success/failure/signal-style exit statuses and reused versus disposable projects. Any future deliberate pause must have an independently verified restoration watchdog in addition to shell traps (`docs/deployment.md`).
