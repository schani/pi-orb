# Deleted browser revision continued reconciling after release

## Observed failure (2026-09-09)

After application release `a02638e` and the userspace-Tailscale harness correction (`fb8b465`), the complete lifecycle smoke passed in 221 seconds. The subsequent workload-identity gate failed before minting: fixture orb `6564da3b-e5ee-474f-97b5-3238f887c01b` entered `failed` with `clone_failed: fatal: ambiguous argument 'HEAD'`.

Cloud Logging establishes a mixed-generation provision/discard race during that boot:

- At 03:27:43, the new browser revision reported a newly created workspace disk with the wrong accepted image identity.
- New revision `pi-orb-00049-dpj` repeatedly reported racing/instance specification mismatches, then requested discard of incarnation 0 for `host_spec_changed` at 03:27:59.
- At 03:28:52, old revision `pi-orb-00048-tnf` emitted `spec-replacement-declined committed_generation=1788922912 configured_generation=1788844394` for the same orb.
- Incarnation 1 was subsequently provisioned; at 03:29:45 it failed the checkout's `rev-parse HEAD` validation.

The old revision's deletion had already succeeded at approximately 03:06 in the original release. Nevertheless it was still emitting poller/reconciler/project-deletion activity at 03:38. Revision-resource deletion and zero assigned traffic did not establish that its running process had stopped. The confirmed stale actor was the old **browser** revision, not merely an old ops/runtime revision left in inventory. No unrelated ops/runtime revisions were deleted during diagnosis.

The race and continued old process are proven. An interrupted initial checkout is a plausible explanation for the later `HEAD` failure, **not yet a proven filesystem-level cause**. The identity smoke's cleanup deleted its fixture before disk inspection; do not erase or rebuild a retained user checkout on that inference. Further investigation and the blocked gate are tracked in `TODO.md`.

## Evidence and containment status

- `.context/release-a02638e/release.log`: original apply, IAP reconciliation, and successful old-revision deletion.
- `.context/release-a02638e/postdeploy.log` / `postdeploy.exit` (`1`): corrected lifecycle pass and the first identity-gate failure.
- `.context/release-a02638e/wif-lifecycle-allowlisted.json`: timestamp, revision and lifecycle-message evidence, without request metadata or credentials.
- `.context/release-a02638e/revisions-before-containment.json` and the two service snapshots: current traffic assignments and historical revision inventory.

All three owned smoke projects were confirmed absent through the API after cleanup, including both identity fixtures. The global/local release locks were removed and no release/smoke process remains. The accepted application image remains serving; no rollback, additional application apply, arbitrary revision deletion, or user-workspace repair was performed. The identity gate is **not** validated and was not retried for green. The optional separately bootstrapped GCP federation legs were also disabled; the earlier isolated real-project federation/permission verification remains a separate passing result.

The existing `--quiesce` path deliberately refuses tagged browser traffic. Hosted files now require a `files` tag, so it is not currently a usable maintenance path without a reviewed correction. It also inventories revision resources, which omits the already-deleted but demonstrably active revision in this incident. A safe drain must account for actual old processes, preserve/restore the exact files routing and IAP policy, and establish quiescence before claiming the next gate is isolated. Do not bypass those guards or regard deletion alone as proof.
