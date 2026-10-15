# Claude success result, failed operation

Date: 2026-10-15 (America/Los_Angeles). Sticky operation-failure aggregation is confirmed; the triggering error's identity and cause remain unresolved. Diagnostic implementation below is local and undeployed.

## Evidence

- Orb: `d12f4204-2d7c-442d-92e3-2da5b4813440`.
- Operation: `c54e643a-c151-444f-bcb9-0d3fc4ba5492`.
- Query: `ec486cea-7ccb-428f-a964-ad902e6cee37`.
- SDK: **0.3.300**. The deployed `agent.ts` SHA was verified to match the checkout.

All times below are PDT on October 15.

| Time | Evidence |
| --- | --- |
| 07:48:09 | Restart prompt. |
| 07:48:13.530 | Human steering arrives. |
| 07:48:13.600 | `claude.steering_result`, result `0339c76c-d740-4a31-bae8-99b7bb75e508`: `answeredInputs: []`, pending input `bd2579e5-2641-42cf-8b7f-5ee2b44c8ae4`, `queuedTurns: 1`. Present in the runtime index, absent from the exported transcript. |
| 07:57:01.273 | `claude.handoff_result`, result `1d3e9182-865a-41c2-aa71-89fd25d7e964`: `subtype: success`, `isError: false`, `stopReason: end_turn`, `pendingHandoffs: []`. |
| 07:57:01.831 | `claude.operation_finished`: `outcome: failed`, text `Claude turn failed.` |

Local investigation evidence remains in `/tmp/d12-*`, including `d12-index-events.txt`, `d12-transcript.json`, `d12-events.json`, `d12-cloudlogs.json` and native/SDK inspection summaries. These temporary paths are investigation artifacts, not durable evidence storage.

## Confirmed mechanism; attribution limits

The SDK result handler in `apps/orb-runtime/src/claude/agent.ts` marks the operation `failed` and sets `operationError = "Claude turn failed."` on any SDK result with `is_error`, unless already aborted. A subsequent successful result does not reset that aggregate outcome. The terminal message therefore proves that an error result was observed somewhere in this operation, despite the retained final success result.

The retained diagnostics do not identify which result carried the error or why. In particular, the early steering record retains input accounting, not its error status. An interrupted restart result is a hypothesis, not a finding; an error during later query shutdown is not excluded. The final success establishes neither aggregate operation success nor the initiating failure's cause.

## Diagnostic correction (2026-10-15; local, undeployed)

The user requested visible categories and durable category/error-string/error-text/HTTP-status diagnostics for every SDK error, including those followed by success. Existing replicated platform history now records root assistant errors separately from error results, with query/operation/native identities, credential redaction and explicit bounds. No category is carried across turns; aggregate failure/Abort semantics remain unchanged. A trailing root assistant error after Abort shutdown begins still triggers the existing fail-closed rotation guard, not a guaranteed aborted terminal. Contract: `docs/claude-agent-sdk.md`.

Tests first reproduced missing result diagnostics and missing assistant categories. Coverage includes all four result error subtypes, `success` with `is_error` and HTTP status, multiple errors followed by success, next-operation reset, Abort, trailing root assistant errors after Abort shutdown begins (diagnostic persistence and unchanged fail-closed rotation), child exclusion, redaction/bounds, publication failure, history reopen and display projection. This preserves evidence for future failures; it does not establish this incident's original cause.

Local validation: 372 tests passed (`npx vitest run apps/orb-runtime/src/claude packages/protocol/src/display.test.ts --maxWorkers=2`), including deterministic simulation and native SDK contracts. `npm run typecheck`, `npm run lint` (existing warnings) and `git diff --check` passed. The prior `npm run test:e2e` attempt could not start: Docker's `/var/run/docker.sock` is absent (`/tmp/claude-errors-e2e.log`); it was not rerun for this docs/test-only follow-up. No deployment.
