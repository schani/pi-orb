# Validator cleanup command timeout — 2026-09-16

## Outcome

GitHub [run 35137220634](https://github.com/schani/pi-orb/actions/runs/35137220634) for `56078c097428f038c83eb070dbeb818033a2cdb6` passed checks, all 149 E2E tests, native installation, image capture, validator readiness, the acceptance probe, and its Cloud Logging gate. It then failed during validator cleanup, before container publication, migration, plan, or apply. The durable outcome is `failed-before-apply`; no retry or validation-only run was attempted.

Release record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789584866-1d4f375a-1f26-4a67-b266-d42b8b4e1470.json`. GitHub artifact `release-35137220634-1` contains the same record. Recovered copies are `.context/release-blockers/deploy/release.json` and `gh-artifact-release.json`; full logs, final operation evidence, and the read-only cleanup/serving snapshot are in that directory.

## Timeline (UTC)

- 18:54:33: release record started.
- 19:25:33: checks and E2E passed; native build began.
- 19:33:21: native acceptance probe passed.
- 19:33:23: validator Cloud Logging gate passed; `cleanup: delete-validator` began.
- 19:33:27: GCE accepted delete operation `operation-1789587206998-65b9ebdc489ea-8c6aa947-305f93bf` for validator `pi-orb-validator-v-56078c0-c1202b836ff84938`.
- 19:38:26: the local `gcloud compute instances delete` command failed after its 300-second command deadline; cleanup continued for the other owned resources.
- 19:39:09: the final `failed-before-apply` record was written. The lock was removed at 19:39:14.
- 19:41:35: GCE marked the validator delete operation `DONE`, 8m08s after its start and 3m09s after the local command had timed out.

## Diagnosis

`GcloudImageBuildEffects.execute` gives commands a default 300,000 ms deadline. `deleteOwned` first checks for older in-flight operations, then invokes synchronous `gcloud compute instances delete`. That command submitted the delete successfully but waited longer than its local deadline for GCE completion. Killing the CLI produced only a command failure; it did not cancel the accepted cloud operation.

The evidence separates the two outcomes: the workflow logged the command failure at 19:38:26, while the exact operation later reached `DONE` without an error at 19:41:35. This was neither validator rejection nor cloud cleanup failure. It was loss of operation ownership/observation after a successful asynchronous cloud admission.

Increasing the generic command timeout would only move the ambiguity. Cleanup must capture and durably expose the exact asynchronous operation, then reconcile its terminal status independently of one CLI process.

## Correction implemented locally — 2026-09-16

The cleanup adapter persists target intent before predecessor inspection and preserves any exact blocking operation. It waits at most 60 seconds for a predecessor; a terminal predecessor error does not prevent rechecking ownership and deleting the owned partial resource. A dedicated, non-logging `gcloud auth print-access-token` process is bounded to 30 seconds with caller abort and `SIGKILL`; authentication failure never reaches deletion. The adapter then sends exactly one plain Compute REST `DELETE`, bounded by its own 30-second abort signal, with redirects rejected and no authentication replay or generic retry. It validates HTTP status and JSON, then persists the exact operation target and zonal/global scope before polling. The deletion-only poll budget is 12 minutes; `DONE` with an operation error is `failed`, while malformed responses, lost submission receipts, cancellation and poll interruption are `uncertain`. Token-free `submitted`, `failed`, and `uncertain` outcomes are allowlisted into the release record and GitHub artifact, including beside a primary build failure. There is no automatic recovery, blind resubmission, or indefinite global lock; pre-apply cleanup releases the lock.

The initially proposed `gcloud ... delete --async --format=json` contract does not exist in pinned gcloud 583.0.0: all three relevant commands reject `--async`, and exact source tag `9b659d8b1efff08d32974041fd4b96d0988333e6` uses synchronous `MakeRequests`. The implemented REST boundary returns the Compute Operation directly. Its required fields are pinned by tests against the observed incident shape in `validator-operations-final.json`: `name`, `operationType=delete`, `status`, exact `targetLink`, and scope-matching `selfLink`. A read-only query of the old successful operation using the poller's exact format confirmed that `DONE` success returns the expected links and omits `error`; private evidence is retained at `.context/native-cleanup-fix/real-success-operation.json`.

This is an implementation and focused-test result, not live REST or deployment validation.

## Qualification and DST causal ledger

Focused cleanup adapter, evidence, operation, release-state, and release-report regressions pass. Full typecheck and lint pass; `npm test` passed 1,886 tests with six conditional skips, plus infrastructure suites. Logs are retained under `.context/native-cleanup-fix/`. No new deployment was attempted; the separate application-identity gate remains pending user action.

Every new DST failure was replayed before its test model was corrected, and every trace remains under `test-failures/`:

- 20:02 UTC: `native-image-late-create-cleanup-log-{0,25}-1789588967*.json` exposed stale empty CLI delete receipts.
- 20:12 UTC: `native-image-late-create-cleanup-log-{0,25}-1789589567*.json` omitted the injected REST submitter, leaving an unmanaged promise/deadlock; `native-image-slow-delete-1789589568151-0.json` retained the old mock flag and livelocked.
- 20:14 UTC: `native-image-late-create-cleanup-log-{0,25}-1789589657*.json` retained a stale `deleted` flag and old CLI-log assertion.
- 20:26 UTC: `native-cleanup-post-receipt-cancellation-1789590389468-0.json` omitted the injected command-log writer.

These were test-model and assertion defects, not evidence of product defects. Their corrected focused scenarios are green. The production finding remains the original five-minute CLI deadline versus an eight-minute accepted GCE operation.

## Why no retry

At workflow failure, the delete outcome was uncertain: the CLI had failed while GCE still owned a running operation. A blind cleanup retry could race that operation, and a full release retry would repeat an accepted build while obscuring the first failure. Validation-only recovery is inapplicable because no apply occurred. Read-only reconciliation established the actual terminal state instead.

## Final verification

Read-only `gcloud` inspection found no operation-owned builder, validator, data disk, workspace disk, native image, or workspace image with suffix `v-56078c0-c1202b836ff84938`. All recorded delete operations are `DONE`; the global release lock is absent.

All four latest-ready revisions and images still equal `previousServing` in the failed record:

- `pi-orb-00058-rbm`
- `pi-orb-ops-00055-26v`
- `pi-orb-runtime-api-00060-tns`
- `pi-orb-issuer-00020-gjx`
- image digest for all four: `sha256:a1bc1e20f7e7473f3e1d4a16d97b4950e465d0149e0035454c79532e4829bcb6`

Production therefore remains the last validated release, `7d53024a1f3d52932bb2bd192dea06166f10946a`.
