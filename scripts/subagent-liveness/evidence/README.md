# Subagent qualification evidence

Keep the decisions, regression tests and concise qualification ledgers in Git. Generated execution logs and full scheduler traces are downloadable artifacts, not source-review material. This preserves the first-failure evidence without adding roughly 41,000 generated lines to PR #44.

## Ledgers

- [Initial integration](integration-2026-09-14.md)
- [Continuation](continuation-2026-09-14.md)
- [Final qualification and PR rerun](final-qualification-2026-09-14.md)

Historical log/trace filenames in those ledgers refer to archive members below.

- [N1/C2/P1 live rail, terminal and notification validation](live-rail-2026-09-14.md) — separate checksum-indexed download, including the Docker export failure that blocked four full-slice scenarios. This later UI/protocol slice is not covered by the earlier complete PR run.

- [Independent upstream draft preparation](../upstream-prs/README.md) — four isolated branches, tests-first package qualification, and a separate checksum-indexed archive.

- [Main integration](main-merge-2026-09-15.md) — settings/fence and child-admission regressions, full process E2E, final focused qualification, and preserved failure/replay evidence.

## Archive

[Download the evidence archive](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/subagent-evidence.tar.gz) (pi-orb authentication required).

- Source commit: `c0e4156d3b88c2b669ccc56ac41282c1a00c3c0e` (before evidence cleanup).
- 59 previously tracked logs/traces, 125,248 compressed bytes; no private `.context` dumps or browser cores.
- Archive SHA-256: `fb8373036b339553553094efb172e05ef2abb004ccf7c436c8d43b561183087c`.
- `manifest.json` records each member's SHA-256 and its original repository-relative path. Every member was checked byte-for-byte before removing the tracked copies.
- Published Git history is not rewritten; the source commit also retains the originals.

After downloading, verify and extract outside the checkout:

```bash
printf '%s  %s\n' fb8373036b339553553094efb172e05ef2abb004ccf7c436c8d43b561183087c subagent-evidence.tar.gz | sha256sum -c -
evidence=$(mktemp -d)
tar -xzf subagent-evidence.tar.gz -C "$evidence"
```

For example, replay the corrected deadline-assumption regression from the repository root:

```bash
npm ci
DST_REPLAY="$evidence/scripts/subagent-liveness/evidence/archive-compute-timeout-first.json" \
  npx vitest run apps/control-plane/src/domain/orb-archival.dst.test.ts -t 'late timers: true'
```

Older traces capture pre-repair schedules; use their corresponding historical code/fixture revisions described in the ledgers rather than assuming compatibility with today's scheduler checkpoints. The archive does not replace executable regression coverage or clear any unresolved release gate.
