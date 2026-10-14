# Audit #4 — outbound coalescing

2026-10-14, America/Los_Angeles. Synthetic product regression; no fixture-first failure. Curated traces/logs: `test-failures/dst-audit-2-4-5/4/`; original paths and hashes: `test-failures/dst-audit-2-4-5/MANIFEST.md`.

## First red and replay before fix

Test-first composition: real `OutboundWriter` → JSON transport → real `OrbPage` reducer, using `determined` via `runDst`. Socket starts backpressured; drain waits for six enqueues, then each send fills the socket again. Ordered input:

`start A / busy A / finish A / idle / start B / busy+compaction B`

Actual pre-fix delivery:

`start A / busy+compaction B / finish A / start B`

Browser ends `operationId=B, activity=busy, compacting=false`. B's status replaced A's queued status across critical operation transitions; A's finish cleared compaction. Product defect, not scheduler/fixture ambiguity.

- First red (07:33 PDT), iteration 0: `test-failures/outbound-compaction-boundary-6-1791988407116-0.json`.
- Runner's immediate replay reproduced; explicit `DST_REPLAY` also failed before production edits.
- Logs: `.context/dst-audit/4-outbound-coalescing/outbound-audit-4-first-failure.log`, `.context/dst-audit/4-outbound-coalescing/outbound-audit-4-before-fix-replay.log`.
- Additional test-first unit red: 24 failures, 8 passes; `.context/dst-audit/4-outbound-coalescing/outbound-audit-4-unit-before-fix.log`. Same cross-boundary defect for status, output and tool state; no fixture correction.
- Original trace retained unchanged. Full-hold producer/drain gating forces singleton scheduling after the initial task choice; prefix-race cases explore concurrent enqueue/drain choices.

Reproduction command (red before fix, green after):

```sh
DST_REPLAY=test-failures/dst-audit-2-4-5/4/outbound-compaction-boundary-6-1791988407116-0.json \
  npx vitest run apps/web/src/pages/outbound.dst.test.ts -t 'after 6 enqueues'
```

## Fix and qualification

Backward coalescing stops at the first critical queued frame; matching transients still coalesce in the trailing segment. No persisted state or wire fields added.

- Original explicit replay passes: `.context/dst-audit/4-outbound-coalescing/outbound-audit-4-after-fix-replay.log`.
- 71 tests pass across `outbound.test.ts`, `outbound.dst.test.ts`, `compaction.test.ts`, `live-output.test.ts`: `.context/dst-audit/4-outbound-coalescing/outbound-audit-4-validation.log`.
- DST: seven drain prefixes × 80 schedules; asserts B busy+compacting, UI compaction visibility and exact wire order.
- Unit: three transient kinds × seven critical boundaries, plus trailing-segment coalescing and existing budget/drain tests.
- Runtime/web TypeScript and scoped Biome pass; `git diff --check` passes. Logs: `.context/dst-audit/4-outbound-coalescing/{runtime-typecheck,web-typecheck,biome}.log`.

Full normal-suite and runtime E2E validation are running; the final gate remains pending. Local, undeployed.
