# Sleep notice admitted as human input

## Evidence

Orb `5847a002-b3a2-475c-92db-1b8606931578` persisted sleep-wake record `0b9eb811` at `2026-10-08T00:05:22.098Z`, then user-message steer `394ab2e0` two milliseconds later. Both named inbox ID `7ded1b39-619b-4bd2-a1f6-c25aaec5fbe1` and operation ID `28f55fb7-7400-45dd-949a-a3178eba87e5`. The same pattern occurred on other wakes. A running sleep-expired notice also appeared as a user message.

## Causes

Two independent defects:

- `FetchRuntimeClient.deliverMessage` omitted optional `system` provenance from its HTTP body. Absence means human input, so ordinary sleep deliveries became `pi-orb.user-message` records.
- Boot submission owned an operation and turn-start barrier, but not a pending inbox claim. Pi persists triggering custom messages on `message_end`, after `agent_start` releases that barrier. A retry in this interval found neither a persisted record nor a pending claim and queued another steer. Persisted dedup checks sleep-wake records regardless of incoming provenance; missing provenance alone did not bypass it.

The existing boot fake appended synchronously during submission, concealing this interval. A delayed-persistence regression reproduced the duplicate even with provenance preserved. Its recorded DST schedule was replayed before fixing the product.

## Correction and validation

Serialize provenance unchanged. Claim the boot notice in the existing pending inbox map before submission; persisted history takes over dedup, and submission failure releases the claim.

Adapter regressions cover human, sleep-wake, and sleep-expired bodies. The boot DST passes the FetchRuntimeClient HTTP body into delivery, checks duplicate suppression after `agent_start` but before persistence, then checks persisted dedup. It exercises 30 schedules without external I/O. History retains notice provenance and inbox/operation identity as durable diagnostic evidence.
