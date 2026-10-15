# Poll commit-boundary DST: history pull owned the held commit (2026-10-15)

**Classification:** scenario assumption, not a product defect. No production source changed.

## Failure

`apps/control-plane/src/domain/poll-concurrency.dst.test.ts`, `composes poll … at the commit boundary` (added by PR #105) failed intermittently on `main` in the commit-first cases:

- `poll-boundary-after-stop-commit-first` iteration 6, local: `test-failures/poll-boundary-after-stop-commit-first-1792076864692-6.json` (1,898 records).
- `poll-boundary-cas-delete-commit-first` iteration 0, GitHub CI run 38758911288; the trace stayed on the runner.

Both recorded the same edges: `port-entered a-first → guest-accepted a-first → guest-durable a-first → public-commit-observed a-rec-1 → held-store.commit.after → inbox-queued a-later → port-entered a-later → guest-accepted a-later (version 0, running) → guest-durable a-later`. The driver's `expect(entered).toEqual(["a-first"])` failed. This happened **before** the lifecycle command; the trace has no `fence-version-observed` edge. `a-later` was therefore accepted while the orb was `running` with its admission version still open. No Stop/delete fence was crossed.

## Interleaving (replayed before any change)

1. A's input lane (`central:a`) delivers `a-first`. The test port flushes it into the guest history and calls `commitAgentHistory`. That function first awaits `store.getOrb` (`apps/control-plane/src/domain/agent-history.ts:22`), which yields on store latency.
2. During that yield, A's independent history lane (`poll:a`, `PollDispatcher` in `apps/control-plane/src/domain/loops.ts`) pulls `a-rec-1`. Its `commitPullBatch` (`apps/control-plane/src/domain/replication.ts:309`) reaches the store first. The scenario captures it as *the* boundary commit and holds it at `store.commit.after`, after the commit is already public. A stack-tagged instrumented replay confirmed that the captured commit came from `pollOrbUntilCaughtUp`, not `commitAgentHistory`.
3. The input lane resumes, reads cursor `a-rec-1`, and finds nothing to project (`agent-history.ts:31-35` → `initOrVerifySession`). The delivery completes and the input lane is free.
4. The next dispatcher tick delivers `a-later`. FIFO permits it because `a-first`'s canonical receipt is committed.

The scenario assumed that the held commit always occupies A's input lane. That holds when the input projection owns the commit. It also holds when the projection must commit and therefore parks behind the scenario's recovery gate, which covers every lifecycle-first schedule. In commit-first, though, the history pull can own a commit that is already public. The decided polling isolation (`docs/history-replication.md`, 2026-10-14: "Naming/history also cannot occupy A's input lane; FIFO still waits for A's earlier canonical receipt") explicitly permits the admission seen here. The prior `docs/testing.md` bullet ("later queued work remains unaccepted") overstated the property.

## Correction

The scenario now records which lane owns the held commit (by task identity inside the input projection). It also records whether A's input lane parks in a commit or goes free while the commit is held, and waits for one of those outcomes explicitly. It asserts that `free` occurs only when a history pull owns a commit-first boundary, and in that case it waits for and expects `a-later`'s pre-fence acceptance. The terminal fence assertions are unchanged: receipts equal the version-tagged acceptance before Stop, there is no acceptance after the fence, and `a-fenced` stays queued. A free input lane now requires `a-later` to be `delivering` before the command and `delivered` after Stop.

New `history` owner cases force this interleaving deterministically for after/cas × stop/delete. With the old `["a-first"]` expectation, all four fail at iteration 0 with the recorded edge sequence.

## Replay evidence

Strict `DST_REPLAY` of the saved trace now consumes all 1,898 records without divergence. It passes the former failing assertion and then reports `Replay trace exhausted` at the lifecycle-command wait, because the recording ends at the original failure. A temporary, uncommitted prefix-replay harness replayed every recorded event strictly and then continued with fresh entropy. It passed 20 of 20 runs.
