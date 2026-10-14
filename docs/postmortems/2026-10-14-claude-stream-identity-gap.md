# Claude terminal stream identity gap — 2026-10-14

Historical root cause unresolved; no cause or recovery fix claimed. Confirmed evidence below predates the diagnostic change; no target changes.

## Evidence

Orb `4647f261-2126-4f20-a61c-51095d222a47`, incarnation 2; native session `72e576bd-05f2-4410-a58e-2909afa7c8a6`. All times October 14, PDT (UTC−07:00).

| PDT | Confirmed observation |
| --- | --- |
| 11:14:43 | Incarnation 2 running. |
| 12:05:21 | `reconcile-retry`: Claude session is not accepting work. |
| 13:15:06.531 | SDK task notification: background task `bzghsc1cu`, local dev control plane, killed at its two-hour time limit. |
| 13:15:09–13 | Assistant performed two Bash log checks. |
| 13:15:13.060 | Replica ends at `claude.attachment`; 811 records, no final reply. |
| 13:15:24.035 | Failed state transition, `stateVersion=20`. |
| 13:15:24.045698 | Production poller recorded `runtime-failed`, incarnation 2. |
| 13:15:25.396322 | Control plane initiated VM deletion. |
| 13:15:46.736372 | VM deletion completed. |
| 13:15:46.975 | Orb `updatedAt`. |
| 13:15:46.978632 | `compute-discard`, outcome `ok`. |

`lastError`: `runtime_failed: claude_stream_identity_gap: Native history and streamed output could not be correlated; inspection is required.`

VM lookup returned 404. The retained 50 GiB disk was `READY`, unattached. The replica endpoint is not proof of the native disk's final contents.

## Failure boundary and limits

The terminal guard in `apps/orb-runtime/src/claude/agent.ts` fails after drain:

```ts
blocks.size > 0 || published !== history.view.length
```

Terminal completion requires both no remaining live blocks and publication of the entire native view. The historical message cannot distinguish leftover live blocks from an unpublished native suffix; the incident replica contains no diagnostic counts.

The background task notification preceded failure, but causation is unproven. This was not a token-usage SQL error or preemption: control-plane deletion followed runtime failure.

Related evidence does not establish this incident's cause: [docs/postmortems/2026-10-06-claude-publication-order.md](2026-10-06-claude-publication-order.md) and [docs/postmortems/2026-10-13-claude-query-rotation.md](2026-10-13-claude-query-rotation.md). The same orb's earlier [docs/postmortems/2026-10-13-claude-history-nul.md](2026-10-13-claude-history-nul.md) incident was independent.

## Recovery limits

No automatic recovery exists for `claude_stream_identity_gap`. Manual Start may restore the retained session or fail again; it is not a demonstrated repair. Native disk inspection before resume is needed for root-cause attribution. Follow-ups: `TODO.md`. No production restart or disk inspection was performed. The retained-session inspection item remains in `TODO.md`.

## Diagnostic change (2026-10-14)

The guard retains its code and fail-closed behavior. Its existing message now includes bounded, content-free counts and identity/ownership samples; `docs/claude-agent-sdk.md` specifies the fields and limits. Existing health → `lastError` persistence makes the evidence user-visible without new journal state or schema. This improves attribution of future failures, not the historical cause or recovery.

Tests precede implementation: eight real-agent publication/terminal cases failed on the missing diagnostics. Coverage includes each guard branch, both conditions, missing UUID, unmatched UUID, wrong role, unbound blocks, bounded block/owner samples, exact 96-character IDs (including three blocks × two matched owners with duplicated native IDs), omitted oversized and short malformed IDs, and exclusion of content/signatures/metadata. The native-length-only branch injects a scan/view mismatch through the history seam; ordinary zero-block flushing publishes the whole view. Health-client and runtime-failure persistence regressions preserve messages longer than 1,024 characters and deny identity-gap replacement.

The new persistence test initially compared raw JSON against a JSON-quoted lifecycle field. Recorded DST replay reproduced the assertion error; the trace shows the complete escaped message and confirms the test assumption, not truncation, was wrong. The assertion now compares the JSON-quoted field; corrected replay passes. Evidence: `test-failures/claude-identity-gap-diagnostics-1792016394415-0.json` (local retained trace). No historical cause fix is inferred.
