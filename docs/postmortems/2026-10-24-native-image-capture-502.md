# Native image capture: client 502 after successful insert

2026-10-24; all times PDT (America/Los_Angeles).

## Outcome

After [#174](https://github.com/schani/pi-orb/pull/174) and [#163](https://github.com/schani/pi-orb/pull/163) merged, [Deploy 40101258304](https://github.com/schani/pi-orb/actions/runs/40101258304) selected `378f3a63ae933865496e6e195dee9f435f5f3bd9`. All ten exact-source push/main qualification jobs succeeded on attempt 1: CI `40101192167`, E2E `40101192163`, Durable `40101192199`. Deploy used default inputs: validation empty, first consolidation false, migration timeout override false (300 seconds).

Release `r-1792852291-30ec3b9d-b65e-4b67-aa39-7cce6c121232` records `failed-before-apply`, phase `build`, exit 1. No migration, apply or activation occurred. No retry, waiver or root-cause fix.

## Evidence

- **07:38:03:** native runtime image capture started with `gcloud compute images create pi-orb-image-v-378f3a63-30a67dc2c46b4ca1`.
- **07:39:21:** insert audit operation recorded its successful final event. Independent operation read `operation-1792852684514-65e970b6523f7-86813db8-96289e27` is `DONE`, without `error`, target ID `2519867829670476835`, end time **07:39:21.536**.
- **07:39:54:** owned-resource cleanup started.
- **07:41:47:** cleanup finished, then the capture failure printed: gcloud “Could not fetch resource” with Google's HTML 502 error page.

The mutation succeeded while the client command failed. The preserved evidence identifies neither the exact request receiving 502 nor the underlying Google fault. Failure-print time is not response-receipt time.

Independent reads around **07:49** confirmed all build-tagged instances, disks and images absent; release lock absent; original `pi-orb-issuer-00072-zbf` Ready at 100% traffic, digest `sha256:16139399dc19586918358255dbf6741cfdc625f6af46c72e382bb68d5ac7eb48`, host generation `1792802558`. Active release remained `r-1792801714-3aa5c751-108e-40e6-9b31-088a6ecb5985`; `/health` returned `ok`. This is a point-in-time observation, not continuous availability proof.

Authoritative record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1792852291-30ec3b9d-b65e-4b67-aa39-7cce6c121232.json`; [Actions artifact](https://github.com/schani/pi-orb/actions/runs/40101258304/artifacts/12563452826).

Preserved under `/workspace/deploy-monitor/40101258304/`: `actions.log`, `image-audit.json`, `image-insert-operation.json`, `current-release.json`, `artifacts/release-40101258304-1/release.json`, `service.json`, `active.json`, `instances.json`, `disks.json`, `images.json`, `health.json`, `state-objects.txt`. Artifact and GCS release copies differ in serialization but their parsed JSON is equal.

## Rule

A failed mutation command does not establish server-side failure or absence. Inspect exact operations/resources and confirm owned cleanup before considering another attempt; retain the failed release evidence.
