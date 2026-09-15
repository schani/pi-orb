# Independent upstream drafts

Prepared 2026-09-15 for `gotgenes/pi-packages`, targeting `main`. These are **four independent, single-commit branches**, not a stack. Each starts at upstream `045213317de608c04a7b6052b2b843e3a0f2176f`; no branch contains another proposal's changes.

GitHub still rejects draft creation with `Resource not accessible by integration`. No draft PR was created by this preparation. The branches are pushed; brief requirement/solution bodies are linked below and ready for an authorized account to submit as drafts.

| Scope | Branch / comparison | Commit | Diff, including tests/docs | Package tests | Body |
| --- | --- | --- | --- | --- | --- |
| Startup/resume cancellation | [subagents-cancellation](https://github.com/gotgenes/pi-packages/compare/main...schani:subagents-cancellation) | `816188bac07e7fcf1549f7ec3a11271b34db9008` | +112/−13, 8 files | 1,768 | [cancellation.md](cancellation.md) |
| Delivery-time wake veto | [subagents-wake-veto](https://github.com/gotgenes/pi-packages/compare/main...schani:subagents-wake-veto) | `e71828286072579583213f6050469237c85f2b43` | +65/−1, 5 files | 1,767 | [wake-veto.md](wake-veto.md) |
| Explicit child extensions and fail-fast loading | [subagents-child-extensions](https://github.com/gotgenes/pi-packages/compare/main...schani:subagents-child-extensions) | `4013935c8accc61ccc1e30a0357ed79f3ca16cce` | +77/−4, 4 files | 1,768 | [child-extensions.md](child-extensions.md) |
| Explicit working directory | [subagents-session-cwd](https://github.com/gotgenes/pi-packages/compare/main...schani:subagents-session-cwd) | `8c434e4d830720073808f0c2428673e0649abe95` | +86/−6, 4 files | 1,767 | [session-cwd.md](session-cwd.md) |

The child-factory option and its strict loading check stay together: an independent loading-only PR would need another option or depend on the factory PR. The three options proposals touch the same entry point and may need ordinary conflict resolution as they land, but do not require one another's behavior or commits.

## Submission commands

Run from this repository with a GitHub credential authorized to open upstream PRs:

```bash
gh pr create --repo gotgenes/pi-packages --base main --head schani:subagents-cancellation --draft --title 'fix(pi-subagents): honor cancellation during startup and resume' --body-file scripts/subagent-liveness/upstream-prs/cancellation.md
gh pr create --repo gotgenes/pi-packages --base main --head schani:subagents-wake-veto --draft --title 'feat(pi-subagents): allow automatic wake vetoes at delivery' --body-file scripts/subagent-liveness/upstream-prs/wake-veto.md
gh pr create --repo gotgenes/pi-packages --base main --head schani:subagents-child-extensions --draft --title 'feat(pi-subagents): configure child extensions with fail-fast loading' --body-file scripts/subagent-liveness/upstream-prs/child-extensions.md
gh pr create --repo gotgenes/pi-packages --base main --head schani:subagents-session-cwd --draft --title 'fix(pi-subagents): accept an explicit working directory' --body-file scripts/subagent-liveness/upstream-prs/session-cwd.md
```

## Validation and provenance

Each isolated worktree installed upstream's frozen pnpm lockfile with pnpm 11.25.0, including its pinned Pi SDK 0.84.4, rather than borrowing the integration harness's dependencies. Every branch passes the **full subagent package suite**, package typecheck and package lint (Biome, ESLint and Markdown). This is not a claim that all packages' monorepo suites or downstream release gates ran again.

Tests were applied before production changes: cancellation had 7 expected failures, wake veto 3, child extensions 3, and working-directory selection 3. Added probes separately cover explicit empty/nonempty factory forwarding and all three directory consumers: profiles, settings and workspace preparation. The cancellation tests retain explicit promise gates; lint-required corrections use `Promise.withResolvers<undefined>()`, and narrow overrides explain why cancellation must be rechecked after awaited acquisition despite TypeScript's stale narrowing. The cancellation PR also corrects the service/README claim that `abort(id)` cannot reach resumes.

Upstream advanced during preparation to `2427cd9bef863ca06fd678a76c0d1c9d1d3c6455`, changing another package and its documentation, not these package/dependency inputs. All four branches merge cleanly with that revision according to `git merge-tree`; GitHub comparisons still contain exactly one proposal commit each. The tested commit IDs above were not rewritten after publication.

[Checksum-indexed logs and branch manifest](https://files---pi-orb-1077475695242.us-central1.run.app/s/58efed98-b832-4025-a899-7f43fed7ed72/qualification/pr-44/upstream-split-evidence.tar.gz): 9,737 bytes; SHA-256 `4d14aab8aba3b5633d66e9a59c61413dcea01fa0f844502a7cd266df80b56d3b`. Every archive member was byte-verified. Includes first failures and final checks; excludes private history and credentials.

The original `pi-orb-integration` branch at `6d333b00670d778812b79bce2dd2e1db3f5f9692` and the application's pinned artifact are unchanged. No preview service, agent work or production deployment was started by this preparation.
