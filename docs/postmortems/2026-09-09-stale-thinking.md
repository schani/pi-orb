# Stale green thinking below newer commands — 2026-09-09

## Evidence and impact

In orb `84f9cef7-5509-4ba5-9adb-7f5929039c72`, screenshots showed repeated green thinking rows below newly committed commands. Replicated history confirmed commands completed at 17:16:01, 17:16:15, 17:18:01 and 17:19:36 UTC. The display falsely suggested continuous thinking with no tool progress. The earlier ten-minute E2E shell timeout was a separate event, not an explanation of this display.

## Cause

The Pi adapter keyed streaming blocks by operation ID and content index. An operation contains many assistant responses; later responses reuse indices and can contain fewer blocks. Old higher-index blocks remained in both runtime reconnect state and the browser until operation completion. HistoryView rendered saved records before all retained live blocks, colored the latter green, and tried to suppress duplicates by exact text equality. Final normalized reasoning need not equal the intermediate stream, so this heuristic did not retire all stale blocks. It could also hide a legitimate new response repeating earlier text.

## Correction and evidence

Use message-scoped block IDs and explicit critical `output_retired` events after complete history publication. Capture retiring IDs before the persistence microtask, deleting only those IDs from runtime and browser state. Remove text-equality suppression. Existing complete history remains the durable evidence of what executed; transient retirement remains presentation state.

`apps/web/src/pages/live-output.test.ts` drives the real Pi adapter, outbound writer, and browser reducer. The original regression failed with three stale blocks after message completion. Four explicit deterministic schedules cover the next response starting before/after retirement and immediate/buffered transport; final text differs from streamed text. These exhaust the relevant boundaries without adding a randomized state machine. Assertions cover history-before-retirement ordering, unique identities, and runtime reconnect state.

Validation also exposed an unrelated deterministic E2E selector defect: the session-expiry test selected every alert while its fixture now contains three persisted model-error alerts. Scope its assertion to `.session-ribbon`, retaining the expected expiry text and sign-in behavior. The first failure is recorded in `/tmp/e2e.log` in the investigation workspace; it is not treated as a passing rerun or resolved by extending a timeout. After this selector correction, all 13 frontend E2E tests passed. The initial process-backend E2E run passed full-slice, MCP, hosting-security and harness-startup tests; two Docker-only cases were skipped because no Docker daemon was available. The unit/DST suite passed 1,564 tests (five skipped), with typecheck and lint passing. No deployment was performed.
