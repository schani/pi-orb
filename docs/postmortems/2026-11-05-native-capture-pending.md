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
Sol approved the frozen behavior in two rounds. Prerequisite
`df7084ce7cbb5faa0551441cac15623a43a2860b` precedes refresh
`2d5c8e3c2218326e48ed049c410cb4e6713bd51b`.

## Accepted fresh qualification

Operation `fff7addc415246dd` (`q87-native-b9e57f31`), November 5,
18:07:57–18:20:22 PST, accepted clean exact source `2d5c8e3c`
(`sourceDirty: false`). All 390 uploaded and 32 tooling hashes matched the
frozen inventories, accepted manifest and final source; the receipt commit
changes docs only. Archive SHA-256:
`bddb07306d038004e6269a044bd68518fc8f4a60ea55187b3de3c32da0668c14`.
Base ID `1253207937433879378`, runtime `4363597010943641246` and workspace
`4129969387249632967` were verified. All four target versions matched; the
554-package inventory is unchanged from the first operation.

Installation, PTY, 34 guest contracts, boot graph, sealing, workspace integrity,
captures, fresh boot, host-key stability, guest acceptance, default-disabled
daemons and exact-validator Cloud Logging passed. Synthetic Claude/native
Bash/MCP and isolated network sandbox gates passed. Both create responses were
READY: this is not live PENDING coverage or proof of why the first response was
PENDING. Deterministic unit tests establish the corrected recovery behavior.
[Accepted-image receipt](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/55be2793-d9e4-48c3-8574-6a2f84ddf39e/evidence/q87/native-image-accepted.md);
full gate and retained-store receipts: `docs/testing.md`.
Normal CI/full-suite/E2E/PostgreSQL results remain pending in PR checks.

## Cleanup and limits

Failure cleanup removed both captured images, builder VM, workspace template
disk and builder boot disk. Exact-resource absence and operation-filtered zero
instances/disks/images were confirmed; the local operation key was removed.
Validator and validation disk were never created and were confirmed absent.
Accepted-operation cleanup additionally fenced exact names/IDs,
operation/version and source-disk/source-disk-ID ownership against its receipt.
All eight exact resources are absent; operation-filtered instances/disks/images
are empty. The operation key, process and owned SSH host-cache entries are
absent; unrelated cache entries were preserved. Disk remained 6% used, 45 GiB
free. Every private first-failure evidence hash remains unchanged.

No production resource was changed. Fresh image and separate 164-assertion
retained-daemon-store acceptance do not qualify VM reboot/stop-start,
full-image replacement, full-system native acceptance or rollback. Production
release boundaries remain deferred in `TODO.md`; no merge or deployment is
authorized.
