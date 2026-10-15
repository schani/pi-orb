# Claude success result, failed operation

2026-10-15 (PDT). Orb `d12f4204-2d7c-442d-92e3-2da5b4813440`, operation `c54e643a-c151-444f-bcb9-0d3fc4ba5492`, query `ec486cea-7ccb-428f-a964-ad902e6cee37`. SDK 0.3.300; deployed `agent.ts` matched the checkout.

| Time (PDT) | Evidence |
| --- | --- |
| 07:48:13.530 | Human steering arrives. |
| 07:48:13.600 | `claude.steering_result` (`0339c76c-d740-4a31-bae8-99b7bb75e508`): no answered inputs, one pending input, `queuedTurns: 1`. Runtime index only; absent from exported transcript. |
| 07:57:01.273 | `claude.handoff_result` (`1d3e9182-865a-41c2-aa71-89fd25d7e964`): `subtype: success`, `isError: false`, `stopReason: end_turn`, no pending handoffs. |
| 07:57:01.831 | `claude.operation_finished`: `outcome: failed`, `Claude turn failed.` |

The result handler sets this terminal error on `is_error`; later success does not reset the aggregate outcome. The initiating error's identity and cause are unknown: steering diagnostics lacked error status. An interrupted restart result is only a hypothesis; a shutdown error is not excluded. Temporary investigation artifacts: `/tmp/d12-*` (not durable evidence).

Correction: retain visible, bounded, redacted SDK error diagnostics independently of terminal outcomes. Contract: `docs/claude-agent-sdk.md`. This improves future attribution; it does not establish this incident's cause.
