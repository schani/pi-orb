# Missing SDK beta component after successful application apply

## Evidence (2026-09-09)

Deploy run `34407362332`, source `32d82e5`, passed checks/E2E, native VM acceptance,
container publication, protected-plan review and the same-image migration job.
OpenTofu completed at 22:07:54 UTC: zero resources added/destroyed, four Cloud Run
services changed. The subsequent IAP helper needed `gcloud beta iap`, but the
GitHub SDK installation contained no beta component. Its interactive installation
prompt failed in the noninteractive runner. Finally-path IAP reconciliation met
the same missing dependency.

The run remained `applied-but-unvalidated`, phase `apply` failed. It did not reach
retirement, activation or smoke. The serving snapshot had not yet been recorded.
The successful migration job was deleted and the release lock was released.

Independent reads confirmed the accepted control-plane digest
`sha256:1dbb23aa18b8e6d299fa78401cb77be55f5169910752991ed5524a1c9a2f950c`
and generation `1788991246` on the lifecycle roles:

- browser `pi-orb-00050-c4w`;
- ops `pi-orb-ops-00047-md9`;
- runtime API `pi-orb-runtime-api-00052-xg4`;
- issuer `pi-orb-issuer-00012-9s2` (same image, deliberately no lifecycle generation).

Native IAP remained enabled and the accessor was still exactly
`domain:heyglide.com`. There was no deliberate UI pause. New autonomous browser
loops remained behind the activation barrier. This was successful infrastructure
apply followed by failed orchestration, not a validated release.

Original logs and the failed record are preserved under
`.context/workflow-release/apply-failed-run.log` and in
`static-plane/releases/r-1788989505-04be8133-56ac-4126-86ef-ceb28ecaf0e5.json`.

## Correction and recovery rule

Install the beta component explicitly with the pinned SDK. A read-only IAP policy
request now proves both command availability and scoped access in preflight,
before builds, migrations or apply. Do not discover required SDK components through
an interactive prompt after changing serving services.

Post-apply IAP reconciliation and old-revision pruning have their own `repair`
phase, shared by normal release and validation-only recovery. Recovery still does
not build, migrate or apply an infrastructure plan. It checks all four serving
identities against the original accepted artifacts before repair and verifies
those identities again afterwards.

The record reader already supports a post-apply failure before the initial serving
snapshot: it obtains the actual revisions only after proving their images and
generations match the accepted artifacts. Added regression coverage verifies this
case, rejects mismatches, and leaves the original failure untouched. Full live
recovery is a separate verdict; this correction alone did not establish it.

## Verified recovery

Run `34411745647`, runner `95118b4`, finished validated at 23:10:45 UTC without
rebuilding, rerunning migrations or reapplying infrastructure. IAP repair and
revision pruning passed; the old browser remained active after deletion until
explicit zero active/idle samples at 23:00 permitted activation. Lifecycle,
identity, real GCP federation and peer-preview gates passed. All smoke fixtures
were verified deleted, serving identities were unchanged, and the release lock
was absent. The original `34407362332` failure record remains unchanged.
