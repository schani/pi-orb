# Native image capture: client 502 after successful insert

2026-10-24; all times PDT (America/Los_Angeles).

## Outcome

After [#174](https://github.com/schani/pi-orb/pull/174) and [#163](https://github.com/schani/pi-orb/pull/163) merged, [Deploy 40101258304](https://github.com/schani/pi-orb/actions/runs/40101258304) selected `378f3a63ae933865496e6e195dee9f435f5f3bd9`. All ten exact-source push/main qualification jobs succeeded on attempt 1: CI `40101192167`, E2E `40101192163`, Durable `40101192199`. Deploy used default inputs: validation empty, first consolidation false, migration timeout override false (300 seconds).

Release `r-1792852291-30ec3b9d-b65e-4b67-aa39-7cce6c121232` records `failed-before-apply`, phase `build`, exit 1. No migration, apply or activation occurred. That attempt had no retry or waiver; Google's underlying cause remains unknown.

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

## Correction (2026-10-24)

Native runtime/workspace capture now submits create once. An explicitly classified transient create response permits only exact-resource describes: one monotonic 60-second budget, at most 12 reads, five-second waits and at most ten seconds per read. One injected deadline aborts the read-only recovery and its child command; read responses and private log persistence must finish within the budget to succeed. Recovery returns on deadline/cancellation even if a private log write finishes later; late results cannot succeed or trigger another read. Transient reads, exact-resource absence and owned `PENDING` images may retry. Acceptance requires the exact image name/project/selfLink, build/version labels, source disk/zone, numeric ID and `READY`; an observed owned ID cannot change. Successful create responses use the same checks. Other failures terminate recovery; boot acceptance and cleanup are unchanged.

Blind create replay was rejected: this recovers an ambiguously successful mutation, not an uncommitted mutation. Classification is restricted to the gcloud image-command error envelope and explicit HTTP statuses/Google error-page title, excluding cancellation, process termination and log-write failures. Recovery decisions/errors contain only fixed safe messages, image kind and allowlisted HTTP status; raw recovery output stays in private command logs. Neither Google's failing request nor its underlying cause is established or fixed.

Tests were written before implementation. RED: `/workspace/deploy-monitor/capture-recovery-red.log` (21 failures), `capture-recovery-additional-red.log` (29 failures) and `capture-recovery-dst-red.log` (three failures). All initial DST traces were replayed before the fix: capture returned the lost response immediately, before materialization, cancellation or deadline. Intermediate implementation failures and their replays remain under the same directory: an unflattened `Result` incorrectly reported recovery, and the read cap initially ended at 55 seconds instead of allowing the last bounded wait. Both were corrected; the last-wait cancellation regression and HTTP-status telemetry also have separate RED logs. Review added strict-budget RED/replay cases (`capture-recovery-strict-budget-red.log`, `capture-recovery-strict-replay-*`): the initial implementation awaited a noncooperative read/log until 90 seconds. The single deadline/abort-result race corrects that gap, returning at 60 seconds or the one-second cancellation while the adapter completes later. A public-error sentinel regression (`capture-recovery-public-error-red.log`) guards raw stderr disclosure. Traces remain in `test-failures/native-image-capture-*.json` and `test-failures/native-capture-*.json`, copied to `/workspace/deploy-monitor/capture-recovery-traces/`.

GREEN: `/workspace/deploy-monitor/capture-recovery-green.log`, 112 targeted adapter/unit/DST tests, including delayed materialization, transient reads, fixed deadline, cancellation during read/wait/log persistence, late successful reads/logs, ownership, ID replacement, nontransient errors and no duplicate create. The full native-image suite also passed: 207 tests (`/workspace/deploy-monitor/capture-recovery-native-suite-final.log`). Native-image typecheck and scoped Biome passed. This is synthetic/local qualification, not a cloud recovery or deployment result.
