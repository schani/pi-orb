# Image-validation Buffer comparator OOM

**2026-10-16, America/Los_Angeles.** New non-UI validation failure during Pi 1.3/native code-mode migration; no historical crash exception applies. Local test correction is qualified below, not deployment or final-head qualification.

## First failure and cause

`/tmp/pi-upgrade-logs/42-resource-integration-green-first.log` records an image-validation Vitest fork aborting with `SIGABRT` near the stock Node 24 heap limit (~4 GiB). The migration added decoded `Buffer.toEqual` to a full 20 MiB image test; the prior baseline compared the encoded image object, not decoded Buffers.

Isolating the exact installed Vitest 5.0.5 equality implementation and its helpers on Node 24.22.0 at a fixed 4096 MiB heap reproduced the crash with two **equal** 20 MiB Buffers. After byte iteration, `iterableEquality` materializes `Object.entries` for each Buffer: 20,971,520 tuples each, about 42 million total. Heap usage after the second collection was 4,032,285,368 bytes; fatal GC reached 4094.9 MiB. The process exited by signal 6, with peak RSS 5,722,492 KiB. Comparator source SHA-256: `77a6c71c6938b7d3942672693a05eea8fe3964a7e11f9a863b176ab3f358d1a4`.

No decoder, formatter, Harness, journal or failed-assertion diff participates in that reproduction. The same-buffer `Buffer.equals` control passes at the same heap budget. This establishes comparator allocation, not unequal bytes or image decoding, as the reproduced crash mechanism.

## Correction and qualification

The decoded assertion now checks explicit byte length and `Buffer.equals`: every byte remains compared. Full base64 equality, image count, error status, subsequent committed-store assertions, payload, caps, heap and test timeouts remain unchanged.

- `66-native-full-image-after-comparator-fix.log`: actual native 20 MiB test passes with the **original decoder still installed** (one selected, four unselected). This separates the comparator correction from decoder changes.
- `72-published-native-full-images.log`/`.exit`: 14 image/callback tests pass after the published clean installation; the actual full-image case completes in 8.757 s. This is a correctness receipt, not a performance comparison.

A separate controlled native profile also reaches nested execution, formatting, full encoded/decoded equality, subsequent committed-store read and Harness close at the same heap budget.

## Separate decoder allocation improvement

Both the original `Uint8Array.from(atob(data), mapper)` decoder and a preallocated `Uint8Array` with an indexed byte-copy loop pass identical full-byte controls. Isolated peak RSS was 894,992 KiB versus 195,552 KiB; the actual formatter controls likewise both pass (869,728 versus 166,276 KiB). These measurements justify the separate bounded portable decoder hunk in the existing sixth dependency patch, not the comparator crash correction. `61-bounded-image-decoder-contract-red.log` retains its expected source-contract failure; `62-bounded-image-decoder-isolated-green.log` passes the portable replacement.

Publication followed explicit installer-input ownership transfer. `69-clean-root-ci.log` applies all six patches from a clean root install; `70-published-installer-contracts.log` passes 64 source/application tests and `71-published-installer-script.log` passes 21 installer tests. The decoder is the fourth file in the Durable patch; provenance and seals: `patches/pi-durable.PROVENANCE.md`, `scripts/apply-dependency-patches.mjs`.

These isolated allocation controls are not throughput/latency benchmarks. Neither correction establishes a fix for historical production incidents or a host-wide 256 MiB memory bound. Other qualification gates remain independent and in progress.

## Evidence and harness limits

Raw profiles live under `/tmp/pi13-image-oom-evidence/`, mirrored in ignored `.context/pi13-validation/image-oom/`; test logs and exit receipts live under `/tmp/pi-upgrade-logs/` with ignored validation mirrors. Retained distinctions:

- `comparator-v2-{vitest,bytes}-executed-first.*`: exact comparator crash and full-byte control. The earlier extraction's missing `isSubsetEqualityTester` caused exit 1; its evidence remains, and the corrected extraction includes actual helpers plus equal/unequal sanity checks.
- `{original,bounded}-executed-first.*` and `format-{original,bounded}-executed-first.*`: decoder and actual-formatter controls. Initial `*-first` exit 127 occurred before Node startup because `/usr/bin/time` was absent; a Python standard-library RSS launcher replaced only that measurement harness. Exit 127 is not a decoder result.
- `native-executed-first.*`: bytes pass, but exit 13 leaves the subsequent store read and close unqualified. `native-v2-executed-first.*` adds only a profile-owned referenced `MessageChannel`, closed in `finally`; it passes all stages. This corrects standalone-runner liveness, not a product deadlock, and does not recast the original attempt as passing.

No snapshots/cores, heap/timeout inflation or shared testkit patch was needed. Root/workspace free space remained approximately 12/43 GiB during profiling.

## Testing rule

Compare large binary payloads using explicit byte lengths and full byte comparators, not per-byte object-entry enumeration. For new non-UI crashes, preserve the first failure and isolate candidate phases with identical bytes and heap budgets before changing production code or assertions. Keep runner startup/liveness failures separate from product evidence.
