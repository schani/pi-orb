# E2E relay upgrade socket ownership

**2026-10-16, America/Los_Angeles.** Local fixture defect; corrected relay units and whole affected process E2E files pass. No production or native SDK change.

## Evidence

- `164-first-full-process-e2e-frozen-native-13.log`: 555 passed, seven failed, five skipped, one uncaught `read ECONNRESET`, exit 1. Its socket and error timestamp are unknown. The notification JSON consumer failure is separate; Vitest's last-test attribution does not establish socket provenance.
- `176-once-econnreset-owned-socket-diagnostic.log` and `.context/pi13-validation/econnreset-diagnostic176/events.jsonl`: socket-19 has one HTTP error listener at row 49, zero after raw upgrade at row 54. Row 56 records owner `relay-http-upgrade`, `ECONNRESET`, syscall `read`, zero error listeners at **4:00:55.671 PM PDT**, phase `case:start`; row 57 closes with an error. The intentional receipt fault/finally starts at **4:01:06.576 PM PDT**, 10.905 seconds later. **Teardown causality is rejected for this reproduction.** The same error now has a proven owner; this does not invent historical 164 ownership/timing.
- `178-first-real-upgrade-peer-reset-red.log`: actual TCP peer `resetAndDestroy()` after the complete original 426 response; all three test bodies pass, but one uncaught `read ECONNRESET` makes exit 1. This is a real transport RED, not an import, setup, artificial-fault or timing failure.

Logs remain under `/tmp/pi-upgrade-logs/` with ignored `.context/pi13-validation/` observations/source snapshots. First failure bundles remain under `test-failures/durable-process-ef2e36f1-b75e-498c-9417-e266618df582` (164) and `test-failures/durable-process-00af7ee5-ec48-4e34-8063-639abe34b4e8` (176). No DST failure identified.

## Boundary rule (decision 2026-10-16)

Node detaches HTTP's error listener before emitting `upgrade`. The rejecting relay must own the raw Duplex's error and close events **before** writing its unchanged 426 response, retain it until actual close, and stop acceptance before destroying/joining pending upgrades and normal HTTP shutdown.

Only a peer `read ECONNRESET` on this deliberately rejected upgrade is a typed normal `peer_reset` outcome. Other stream/write faults and synchronous rejection-write failures are typed errors retained by the fixture's existing `check`/`close` failure contract. No global suppression or production fallback change.

The three RED regressions remain intact; additional tests hold a real half-open peer through relay close and use controlled Duplex destruction to require an unexpected `EIO` result only after actual close. Temporary diagnostic imports, observers, flag and injected fault are removed; the consumer-fixed process test is restored byte-for-byte.

**Validation checkpoint, 2026-10-16, 16:23:04 PDT:** `180-owned-relay-full-five-unit-green.log`/`.exit` passes all five relay unit cases without unhandled errors; `182-whole-affected-process-e2e-ten-cases.log`/`.exit` passes all ten tests across the three whole affected process E2E files, zero skips/unhandled errors, 391.41 s, exit 0. This qualifies the corrected boundary, not historical 164 socket attribution or the separate required full browser/runtime E2E gate. Later gate completion is recorded in PR checks/body.
