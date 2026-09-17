# Delivered message rendered after its assistant turn (2026-09-17)

## Finding

Orb `fdb2cb22-b9d2-4e22-bcf5-16ce40c02738` showed its first prompt, marked `delivered`, below the agent's tools and commentary. This was a browser reconciliation failure, not saved transcript order.

The lossless replicated transcript has the correct parent chain:

- user record `67c155eb`, `2026-09-17T01:47:23.823Z`, carrying inbox ID `896338b9-6cf3-4a39-95f5-be17a09a2f0b`;
- assistant record `289c1641`, `2026-09-17T01:47:30.193Z`, whose parent is `67c155eb`.

No private transcript content is reproduced here.

## Browser interpretation

`HistoryView.tsx` renders inbox messages whose IDs are absent from committed history after every committed turn. The screenshot therefore shows that this browser had the delivered inbox row and assistant output, but had not reconciled the matching user history record.

The initiating loss or mismatch is unproven: no original browser frame capture exists. Current code can amplify such a gap: `OrbPage.tsx` accepts `history.record` frames in arrival order and advances its cursor without checking parent closure; `live.ts` silently drops malformed or schema-invalid frames; replica repair is suppressed while the socket is open. These are possible persistence paths, not confirmed causes of this occurrence.

## Required invariant and status

An applied transcript prefix must remain ordered and parent-closed. A browser must not advance its resumable cursor beyond a missing ancestor; a delivered inbox row remains provisional until its matching user record is applied, repaired, or a visible synchronization failure is shown.

No fix was implemented or deployed. Repair and deterministic coverage are tracked in `TODO.md`. The design invariant is in `docs/transcript-cache.md`.
