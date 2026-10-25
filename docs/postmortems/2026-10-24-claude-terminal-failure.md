# Claude terminal failure retained busy ownership

2026-10-24 (PDT). GlideOS orb `f7d37f60-57e5-40d4-b3ce-90f676aaa232`. Correction implemented locally, not deployed; broader qualification remains in progress.

## Evidence

- **10:33:49.332:** native assistant `13711d42…` reports `rate_limit`, `apiError: usage_limit_reached`, `isApiErrorMessage: true`, HTTP 429. Structured quota evidence identifies the five-hour limit, reset at **10:50 PDT** (`resetsAt: 1792864200`), with overage rejected as `out_of_credits`.
- Existing `claude.result_error` `3eb5c083…` identifies result `2cf207b3…`: `subtype: success`, `isError: true`, status 429. The operation did detect failure.
- **10:33:58.091:** the final `claude.handoff_result` is a zero-turn successful acknowledgment, not an inference result. Handoff `w5gg08yha` remains pending and awaiting inference.
- No transcript activity follows **10:33:58.250**; the VM remains running at approximately **17:14 PDT**.

Source inspection matches the retained state: the failed outcome blocks fresh ingress, but late task notification creates a synthesis handoff without subsequent inference. A zero-turn acknowledgment cannot consume that handoff. Detecting the error alone did not settle operation ownership.

## Decision and rejected approach

Treat a root result as failing when `is_error || subtype !== "success"`. SDK 0.3.310 `sdk.d.ts:5992` describes results as turn-complete while allowing later notifications; `success` with `is_error: true` represents an API error. Assistant errors remain diagnostics, not termination proof. Error text, `stop_sequence` and HTTP 429 alone do not authorize shutdown. No quota-reset scheduler or automatic retry is added.

When no accepted steering or queued user turn remains, cancel queued synthesis explicitly through native `interrupt({ cancelQueued: true })`. Preserve failed outcome; explicit Abort wins. Pending accepted input can continue, and a later successful result must not trigger cancellation merely because the aggregate operation already failed.

**Rejected:** plain `interrupt()`, clearing all ownership on error, or treating input closure/interrupt receipt as drain. In `.context/terminal-failure/characterize-during.log`, plain interruption returns `still_queued: []` while UUID-less task notifications survive; input closure is followed by two extra provider requests and late root activity.

Cancellation retires only terminal synthesis handoffs after supervised drain, with durable interruption and ownership save before live release. Independent Workflow children retire only on exact current-invocation proof, also scanned after drain under the ready-health/no-late-root gate. Independent child/task/inventory/hook ownership otherwise remains guarded. Late root activity, uncertain ownership or failed publication must remain visibly recovery-required. Contract: `docs/claude-agent-sdk.md`.

## Native evidence and limits

`.context/terminal-failure/cancel-queued-{during,after}.log` records the pinned native runtime's `cancel_queued: true` behavior, advertised as `interrupt_cancel_queued_v1`. The SDK runtime accepts the option despite its omission from the public method signature. Receipts include `still_queued: []` and `cancelled: []`; both fields are required to distinguish this cancellation from plain interruption.

Initial characterization observed two provider requests and no late root activity, not a request-count guarantee. Tasks finishing during the held 429 exited 0; blocked Bash tasks stopped after failure reached real stdout EOF and exited 1, surfaced as `process_exited_nonzero` with `exitCode: 1`. That error exit is not clean EOF.

Production-spawner qualification exposed an already-dequeued prewait race: after queue cancellation, a turn can emit `requesting`, then `error_during_execution` without a third provider request or assistant response. The SDK can wrap this as `error_result`; real native exit is 1. Evidence: `.context/terminal-failure/{exact-red,production-spawn-red}.log` and matching JSON artifacts. An empty cancellation receipt is not a consumption fence. Any requesting edge after closing still triggers visible recovery-required containment, never idle. Expected SDK wrappers are accepted only for the same confirmed-cancelled query during closing/SDK iteration, with observed direct exit 1 and no signal, raw SDK signal absent/null, and `process_exited_nonzero` with exact `exitCode: 1` or `error_result`. They cannot bypass the late-root guard. No unconditional native parity is claimed.

The first `.context/terminal-failure/qualified.log` run disproved the test's exact-two-request assumption: the during-response schedule made request 3 after interruption was requested but before its receipt and shutdown. Its JSON evidence remains under `.context/terminal-failure/qualified/`. There is no pre-inference fence. The controlled schedule now holds request 3 without SSE or tool output, awaits its arrival before forwarding the failed result to the adapter, and requires real cancellation to abort it: exactly three requests, two responses, no fourth request, receipt before shutdown. The after-failure blocked-task schedule requires exactly two requests and clean failed/idle completion. Native output after closing remains conditional: late root activity retains busy, nonadmitting `claude_rotation_uncertain` health and handoff IDs, with no operation-finished edge; otherwise supervised drain permits failed/idle completion. Evidence: `.context/terminal-failure/final-qualified.log`; production spawning, real EOF/exit and exact SDK iterator errors remain exercised.

API-key loopback probes establish native rate-limit/cancellation behavior, not subscription `usage_limit_reached` behavior. The incident's structured evidence establishes the subscription-limit diagnosis.

## Deterministic regression evidence

- `test-failures/claude-failed-result-handoff-1792889496859-0.json` reproduced the missing interrupt before the fix: `.context/claude-failure-cancellation/cancel-queued-red-replay.log`. Post-fix replay crosses that assertion but exhausts the prefix at the fifth scheduling record; it is **not green** (`incident-green-replay.log` in the same directory).
- Late-root testing exposed two safety defects: a trailing failed result overwrote the rotation error, and shutdown reconciled handoffs before the rotation guard. `test-failures/claude-failed-cancellation-prewait-after-1792889941214-0.json` reproduced lost handoff ownership before the fix and passed unchanged afterward: `.context/claude-failure-cancellation/{prewait-ownership-red-replay,prewait-ownership-green-replay}.log`. Classification now uses `rotationRootWork` directly; late root work prevents both handoff reconciliations.
- `.context/claude-failure-cancellation/scoped-final.log`: 45 tests passed, including 60 deterministic schedules covering late notifications and root activity before/after closing. Neither recorded trace was deleted.

## Fixture cleanup and final local qualification

The request-3 latch could hang after the watchdog killed native. Tests first reproduced missing-continuation exit/error/deadline failures. A resolved unavailable signal now races request 3 and settles on exit, close, error or the unchanged 20-second deadline. Cleanup joins actual native **close**, including after error; `events.once` would reject early. Controlled failure regressions use explicit events/fake time, not sleeps.

Earlier characterization leaked detached Bash/cat PIDs 6600–6603 on `/tmp/claude-composed-dst-hIc2cf/gate{1,2}`: killing the CLI process group does not reach native's detached Bash groups. Their exact identities were captured, terminated and verified absent in `.context/terminal-failure/fixture-cleanup/leaked-baseline-{before,after}.txt`. After CLI close, cleanup now opens each owned FIFO with `O_RDWR | O_NONBLOCK`, writes `done`, closes it, then unlinks. Blocked readers receive data and EOF; absent readers cannot block cleanup. `apps/orb-runtime/src/claude/task-handoff-cleanup.test.ts` exercises real detached Bash→exec-cat readers, synchronizes readiness through `/proc/.../wchan`, and joins exit 0. No current fixture readers remain; this does not establish unrelated native-process cleanup. No broad process scanning or cgroup framework was added.

Evidence under `.context/terminal-failure/qualification/`:

- `continuation-first-failure.log`, `detached-readers-first-failure.log` and `lifecycle-fixture-first-failure.log` preserve first failures.
- `frozen-helper-qualified.log`: **55/55 passed** (45 lifecycle, six helper, four real-native). `helper-freeze.sha256` verifies the three frozen source files. This supplements the 45 failure/diagnostic/DST tests and 60 schedules above.
- The lifecycle fixture now returns a cancellation receipt; its visible-error selection excludes hidden diagnostics. Existing category, privacy and history assertions are unchanged.
- Whole-workspace typecheck, lint and infrastructure checks passed on current source. Lint retains the 451-warning baseline, with no new scoped warnings. Full local unit qualification is still running in `unit.log`; its known lifecycle-fixture failure is corrected and covered above, not a full-suite green result.

Workflow qualification exposed an undefined interrupt receipt in all 11 existing ownership fixtures and a separate product gap: exact Workflow proof written after the receipt but before EOF was ignored during closing. All 11 original traces reproduced before edits. Fixtures now hold a pinned receipt until the original snapshot assertions finish; shutdown assertions await its explicit request edge. A post-drain proof scan preserves the existing late-root fence and independent ownership guards. `qualification/workflow-replays/` retains logs: ten original traces pass afterward; `preexisting` crosses the original failure but exhausts its recorded prefix (not green). The dedicated `claude-workflow-drain-terminal-1792891000486-0.json` trace reproduced retained ownership before correction and passes unchanged afterward. Intermediate fixture failures were also replayed before fixing request-edge synchronization and narrowing fsync injection to Workflow journals. `scoped.log`: 53 tests passed, including missing proof, independent holds, late root, publication/state/fsync failures and privacy checks.

Broader tests and E2E remain pending. No deployment.
