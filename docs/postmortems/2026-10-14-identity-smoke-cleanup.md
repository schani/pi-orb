# Redirect deleted; identity fixture cleanup failed

## Release outcome — 2026-10-14, PDT

[PR 92](https://github.com/schani/pi-orb/pull/92) merged as `53d72dcbb84f5d1533a632195c55d14f9a26e040`. [Deploy 38596107385](https://github.com/schani/pi-orb/actions/runs/38596107385) deployed source `310def9658c2fe58125494b2ca57b6e0fdf41974` as `r-1791994953-bf23941b-9113-42c7-851d-a9f60281de8f`. Exact-source CI/E2E/Durable passed on attempt 1. Build, schema, apply, repair, retirement, activation and lifecycle passed. Old issuer `00055-dr2` reached active/idle zero at 10:17.

Cloud Audit Logs record successful `google.cloud.run.v2.Services.DeleteService` for `projects/playground-dev-6ae7/locations/us-central1/services/pi-orb` at 09:37:18.407726, by `pi-orb-amp-deployer@playground-dev-6ae7.iam.gserviceaccount.com`. Independent reads at 10:33 found only `callout` and `pi-orb-issuer`; issuer `pi-orb-issuer-00056-qmd` was Ready at 100% traffic, `/health` returned `ok`, discovery matched the pre-release document and JWKS remained available.

Identity assertions, including signature verification, STS, impersonation, peer preview and negative mint admission, passed. The script announced `WORKLOAD-IDENTITY SMOKE PASSED` at 10:26:28 before its EXIT cleanup. Both identity fixtures then recorded `cleanup-failed`; the transaction exited 1 at 10:26:52. Authoritative outcome: **applied-but-unvalidated**, identity gate **failed**. The independent monitor was skipped, not passed.

## Diagnosis and limits

No `Fixture cleanup not confirmed` message appeared. That narrows the failure to the initial DELETE command/rejection branches, not the subsequent polling deadline. Those branches are silent; `api.sh` suppresses authentication stderr, transport diagnostics and HTTP status. The scoped 10:26:25–10:27:05 DELETE request query returned zero rows; both fixture rows were stopped without deletion intent. No authentication audit rows were found in that window.

Missing rows do not distinguish authentication, transport or ingress/application rejection. **The historical cleanup cause remains unproven.** The premature success banner and missing diagnostics are established harness defects, not a proven cause of the failed deletion requests. The PR 92 historical CI waiver does not cover this failure. Nothing was rerun or manually marked validated.

**User-approved exception (2026-10-15):** “I waive that, continue with the deployment!” waives only the historical cleanup-cause explanation. Diagnostics remain deferred (`TODO.md`); original failed record unchanged, no root-cause fix claimed. Normal new-deployment gates, assertions and verified fixture cleanup remain mandatory.

## Authorized fixture cleanup

The user authorized one ordinary service-API DELETE per exact owned fixture after fresh ownership/state checks:

- `37b222a3-7aef-45df-9ff3-a93739c940b4`: DELETE 202 at 10:42:23; GET 404 `not_found` at 10:43:38.
- `f1a2dfaa-922c-4673-af5d-381571961c28`: DELETE 202 at 10:42:30; GET 404 `not_found` at 10:43:44.

Both belonged to project `eacd1d25-2825-4c3a-a26b-3923baa86801` and were stopped. Read-only Compute checks confirmed their instances and data disks absent; the release lock was absent. At 10:47 the authoritative release record still matched the downloaded original artifact, including its failed identity gate and fixture outcomes. Cleanup proves current absence, not the historical cause or release validation. No direct database or cloud-resource deletion was used.

## Evidence and invariant

Authoritative record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1791994953-bf23941b-9113-42c7-851d-a9f60281de8f.json`; GitHub release artifact in the linked run. Local evidence: `.context/pr92-release/38596107385/` (first logs/artifact and scoped diagnosis), `.context/pr92-release/final-verification/` (service, routing, public endpoints and deletion audit), `.context/pr92-release/owned-cleanup/` (202→404 and Compute absence), `.context/deploy-progress.json`.

Complete smoke success requires verified fixture cleanup; assertion success is not the final verdict. Retain the original transaction outcome separately from later cleanup. Follow-up work lives in `TODO.md`. Diagnostic candidate `43f059be` on `fix/identity-smoke-cleanup-diagnostics` is unmerged and deferred; review found it rejects successful array responses. That candidate regression is not present in the deployed source and does not explain this failure.
