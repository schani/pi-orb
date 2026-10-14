# DST audit #5: detail-loader ownership

2026-10-14 (America/Los_Angeles). Local, undeployed. Curated traces/logs: `test-failures/dst-audit-2-4-5/5/`; original paths and hashes: `test-failures/dst-audit-2-4-5/MANIFEST.md`.

## Retry race

Test added before production edits. Open a running detail, retry twice at scheduling checkpoints, then resolve the one coalesced request. Assertions capture publishes, timers before close and timers after close together.

- Trace: `test-failures/detail-repeated-retry-1791988983532-0.json`.
- Red: 3 publishes, 3 timers, 2 timers after close (expected 1/1/0).
- Explicit pre-fix replay reproduced the same failure.
- Cause: retry callbacks shared the original generation. All three accepted the result; timer assignment overwrote the handles needed to cancel earlier timers.
- Fix: advance generation on retry. The request still coalesces; only the latest callback owns publication/polling.

```sh
DST_REPLAY=test-failures/dst-audit-2-4-5/5/detail-repeated-retry-1791988983532-0.json npx vitest run apps/web/src/lib/detail-loader.dst.test.ts -t 'DST: repeated retry'
```

## Publish reentrancy

Five parameterized DST regressions added and run red after the retry fix, before the publication fix. Publication synchronously closes, disconnects, reconnects, opens another detail or retries. Every recorded trace was explicitly replayed before the fix.

| Action | Recorded trace | Red timers after publication / current response / close |
| --- | --- | --- |
| close | `detail-publish-close-1791989035262-0.json` | 1 / 1 / 0 |
| disconnect | `detail-publish-disconnect-1791989035298-0.json` | 1 / 1 / 0 |
| reconnect | `detail-publish-reconnect-1791989035302-0.json` | 1 / 2 / 1 |
| open | `detail-publish-open-1791989035307-0.json` | 1 / 2 / 1 |
| retry | `detail-publish-retry-1791989035309-0.json` | 1 / 2 / 1 |

Expected: 0 timers after publication; 0 for closed/disconnected owners or 1 after the new owner's response; 0 after close. Reads/publications stayed 1 for close/disconnect and 2 for ownership replacement.

Cause: the response validated ownership only before calling `publish`; the callback changed ownership before the old response armed its timer. Fix: recheck generation/key/connection immediately after publication.

Replay each curated trace with its matching test:

```sh
DST_REPLAY=test-failures/dst-audit-2-4-5/5/<recorded-trace> npx vitest run apps/web/src/lib/detail-loader.dst.test.ts -t 'DST: publish reentrancy via <action> '
```

## Qualification and evidence

All six explicit replays pass after their respective fixes. Full detail-loader suite: 11 tests pass, including 30 iterations per DST scenario (180 iterations across the six new cases). Targeted Biome check passes after formatting. PR head `705b8d8` qualified on merge `92ede4c` against `224a38d`: [final receipt](dst-audit-2-4-5/final-validation.md). Final current-head CI is pending; the prior 11 greens are historical integration proof; no release qualification.

Original traces remain intact. Raw logs: `.context/dst-audit/5/retry-red.log`, `retry-replay-red.log`, `retry-replay-green.log`, `publish-red.log`, `publish-<action>-replay-red.log`, `publish-<action>-replay-green.log`, `detail-green.log`, `biome.log`, `final-detail-green.log`, `final-replays-green.log`.

No persisted-state changes. Existing scoped detail failures/Retry and content-free diagnostics remain authoritative; no per-poll telemetry was added.
