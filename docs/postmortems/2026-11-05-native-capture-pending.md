# Successful native image capture returned PENDING

2026-11-05, PST. Qualification only; no deployment.

## First failure

Fresh-image operation `28c3734e36034ee6` (`q87-native-a8f46d2c`) failed
before validator creation. `gcloud compute images create` succeeded with exact
owned runtime-image ID `5764779311865302407`, status PENDING. Name, source disk
and operation/version ownership matched. The success parser required READY and
returned `invalid image response shape`; existing transient-command recovery
already handled PENDING. Rejecting valid pending success is the product defect.
Why Google returned PENDING is not established.

Base `1253207937433879378`, installation, sealing and workspace capture
(ID `3999812297424932290`, READY) passed. All four target packages were verified
installed; the inventory contains 554 packages. No accepted manifest was emitted;
validator boot, guest acceptance, runtime/Cloud Logging readiness, PTY, sandbox,
host-key stability and synthetic Claude gates did not run.

[Safe failure receipt](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/55be2793-d9e4-48c3-8574-6a2f84ddf39e/evidence/q87/native-image-first-failure.md).
Private evidence: `.context/native-platform-security/fresh-image-a8f46d2c/`
(`056-capture-gcloud.log`, `summary.md`, source/cleanup/absence receipts).
The dirty snapshot was based on `c181b798`; all 390 uploaded files still matched
at final comparison. This failed operation does not qualify changed tooling.

## Reproduction and correction

The tests-first successful-PENDING regression failed on the old parser:
`.context/native-platform-security/capture-pending-first-failure.log`.
The minimal correction routes validated PENDING success through existing
12-read/60-second recovery. It fences the create ID before the first describe,
retains name/source/operation/version checks, and accepts only READY. There is
no second insert, new persisted state or new deadline machinery. Existing
command logs and recovery decisions retain the polling outcome.

Focused 60 tests and full native 226 cases / 19 files, including DST, pass;
native typecheck, scoped lint and diff checks pass. No new failure or DST replay.
Receipts: `.context/native-platform-security/capture-pending-*.log`.
The prerequisite awaits Sol round-2 approval. No second live operation has run;
fresh qualification and exact-source normal CI remain pending (`TODO.md`).

## Cleanup and limits

Failure cleanup removed both captured images, builder VM, workspace template
disk and builder boot disk. Exact-resource absence and operation-filtered zero
instances/disks/images were confirmed; the local operation key was removed.
Validator and validation disk were never created and were confirmed absent.
No production resource was changed. The installed-package receipt is not native
image acceptance, E2E, retained-workspace replacement or rollback qualification.
