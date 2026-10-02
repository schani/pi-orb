# Native image SSH startup dependency — 2026-10-01

Image build 2 failed fresh-VM validation: IAP SSH could not connect to port 22, although the runtime later became ready. This was a boot dependency failure, not evidence of missing keys or a network-policy failure. The first exit reason of `google-guest-agent-manager.service` remains **unproven**.

## Evidence and mechanism

- At 20:00:42 UTC the manager first exited 1. systemd canceled the `pi-orb-host-key-ready.service` start job and then `ssh.service` as dependency failures (`.context/finish-20261001/native/validator-serial.txt`, lines 1288–1297). The gate previously had `Requires=google-guest-agent-manager.service` and `After=`; SSH had `Requires=` and `After=` on the gate.
- The manager restarted at 20:00:42; Google's plugin generated ECDSA, Ed25519 and RSA host keys at 20:00:45–46, and the manager reached Started at 20:00:51. Runtime was ready by 20:01:01. No later SSH start appears in the preserved serial evidence (`validator-serial.txt`, lines 1373–1376, 1428, 1447). IAP connection failures are retained in `build-2/094-validate-gcloud.log` and later validation attempts. The canceled SSH job remained latched despite the producer's recovery.
- The image-2 failure was retained, not cleared by a passing rerun. Its owned validator/builder VMs, disks and images were deleted with successful operations (`.context/finish-20261001/native/build-2/cleanup.json`).

## Correction and qualification

**Decision (2026-10-01):** The host-key gate orders after the Google manager but *wants*, rather than *requires*, that producer. SSH still requires the gate. `infra/native-vm/seal.sh` changes only this dependency edge; `After=` remains. The gate alone waits at most 90 seconds for the real instance ID, Google's three private/public key pairs, and matching published guest attributes. It neither generates competing keys nor starts SSH on mismatch or timeout; timeout emits `PI_ORB_HOST_KEY_READY_FAILED=google_host_keys_timeout` in the guest diagnostic path. Do not add blind SSH retries or extend the bound to conceal a failed producer.

Deterministic host-key and unit-graph tests in `packages/native-image/src/host-key-boot.test.ts` and the shell suite cover initially missing keys that arrive later, mismatch, timeout and ordering; the targeted host-key suite passed 15 tests. The final full local gate passed 2,396 unit/DST tests and 110 infrastructure tests. A new image (build 3) passed canonical fresh-validator acceptance: image ID `2509850247943126983`, workspace image ID `650165164377865784`, source archive SHA-256 `42e11c615e376bb3a4459ee93499cf6e4649e4dd0e9ae0a31198e097b6069109` (`.context/finish-20261001/native/build-3/manifest.json`, status `accepted`). This validates the corrected image, not the failed image-2 boot or the manager's unknown initial exit cause.

The resulting boot invariant and separate browser qualification are recorded in `docs/native-vm-prototype.md`.
