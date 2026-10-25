# Claude quota rejection retained busy ownership

2026-10-24 (PDT). GlideOS orb `f7d37f60-57e5-40d4-b3ce-90f676aaa232`. Correction local, undeployed.

## Incident

- **10:33:49.332:** native assistant `13711d42…` reports `rate_limit`, `apiError: usage_limit_reached`, `isApiErrorMessage: true`, HTTP 429. Retained structured evidence identifies the five-hour limit, reset at **10:50 PDT** (`resetsAt: 1792864200`), with overage rejected as `out_of_credits`.
- Existing `claude.result_error` `3eb5c083…` identifies result `2cf207b3…`: `subtype: success`, `isError: true`, status 429. Failure was detected.
- **10:33:58.091:** the final `claude.handoff_result` is a zero-turn successful acknowledgment, not inference. Handoff `w5gg08yha` remains pending and awaiting inference.
- No transcript activity follows **10:33:58.250**; the VM remains running at approximately **17:14 PDT**.

The failed operation rejected ingress, but late task notification created a synthesis handoff without subsequent inference. A zero-turn acknowledgment could not consume it. Failed operation outcome alone did not stop the runtime.

## Decision — 2026-10-24

Contain only the retained structured terminal rejection: `success` + `is_error: true` + `api_error_status: 429`. Before root/handoff release, fail existing runtime health as `claude_rate_limit`, request best-effort native queued-turn cancellation, and immediately start supervised shutdown. Accepted steering/queued turns, explicit Abort, manual compaction and existing closing retain their gates. Contract: `docs/claude-agent-sdk.md`.

The existing control-plane failed-runtime path durably records `lastError`/`lifecycle:runtime-failed` and stops the whole compute. The user sees failure and must wait for quota reset, then restart manually. No automatic retry, reset-time parsing, successful operation finish or healthy/idle recovery. Preserve uncertain ownership; exact native terminal notifications may still retire their own task/inventory edges.

**Rejected:** generalized recovery for every failed result, treating assistant errors/text/HTTP 429 alone as terminal proof, clearing uncertain ownership, or trusting an interrupt receipt as a drain fence. Those policies are not justified by this incident.

## Native findings and retained evidence

Plain `interrupt()` returned `still_queued: []` while UUID-less task notifications survived; closing input led to further provider requests (`.context/terminal-failure/characterize-during.log`). Pinned SDK 0.3.310 accepts `interrupt({ cancelQueued: true })` despite its declaration omitting the argument (`cancel-queued-{during,after}.log` in that directory). Queue cancellation does not fence already-dequeued work. Qualification observed a further `requesting` edge, `error_during_execution`, and native exit 1; no clean-drain guarantee follows (`final-qualified.log`). API-key loopback probes characterize native behavior, not subscription-limit policy.

## Focused regression

`rate-limit.test.ts` checks structured detection, accepted steering/queued turns, cancellation rejection, and 20 deterministic schedules with a held interrupt receipt, late task notification and zero-turn acknowledgment. Handoffs and an independent child remain owned; health is failed, admission closed, and no operation-finished edge is published.

Base `79731b4c` reproduced ready health and no shutdown after rejection/trailing output. Trace `test-failures/claude-rate-limit-containment-1792893060493-0.json` replayed before correction and passes unchanged afterward. Logs: `.context/scope-reduction/{base-red,base-red-replay,base-observation-red-replay,green-final,base-green-replay}.log`. Final local qualification: 483 Claude tests passed across 55 files, workspace typecheck and scoped lint passed; unchanged-trace replay passed (`claude-directory-frozen.log`, `workspace-typecheck.log`, `scoped-lint-final.log`, `frozen-green-replay.log` in that directory). E2E and CI qualification remain required before deployment.
