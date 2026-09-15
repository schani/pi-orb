# Cache catch-up qualification: fixture ownership and completion barriers

## Status (2026-09-15)

Found during tests-first cache implementation, before deployment. This is test/qualification evidence, not a production incident. The resulting cache contract is in `docs/transcript-cache.md`.

## Product defect exposed by the controlled scenario

A returning running orb can have newly delivered inbox messages absent from its cached prefix. The existing repair poll interpreted that gap during `connecting` as a reason to fetch full history, racing the ordinary live hello. This defeated caching precisely when there was new work to catch up with.

A test-only transform holds the actual browser client's `onopen` before hello/status publication. While the gate is held, the real inbox poll displays the delivered provisional turn. Test-only instrumentation counts `fetch` initiation synchronously, avoiding an assertion that races the networking callback. Both Chromium and WebKit recorded one full-history fetch where zero was required (`/tmp/cache-catchup-red-product.log`).

The implemented rule in `canRepairFromReplica` is: an ordinary running-orb inbox gap waits for initial live synchronization (`closed`/`connecting`/`open` do not start HTTP repair); an explicit `retrying` transport may use replica repair. Non-running views retain their existing disconnected repair path. An open socket always owns ordered delivery. Explicit user Retry is separate from automatic inbox repair. No delay, larger timeout or new retry state machine is added.

## Test defects discovered and corrected

The first scenario posted to an orb with no browser attached, then expected the frontend fixture to deliver it. That fixture's `deliverPendingMessage` requires an open `LiveSession`, unlike the real runtime, whose agent is independent of browser lifetime. Both engines consistently remained `queued` (`/tmp/cache-catchup-red.log`). An independently owned observer page now supplies the fixture's agent pump while the page under test is on another orb; this is not a new production connection requirement.

The first run after the product guard change exposed two different assertion/synchronization mistakes (`/tmp/cache-catchup-green.log`, despite that anticipatory filename):

- Chromium found two exact text matches, not one. The fixture deliberately quotes user text in its assistant echo, so global text count is not a duplicate-message oracle. The invariant is now scoped to `.history .rec-you`: exactly one user/provisional turn represents the message.
- WebKit reached live-ready after returning but still showed `Review 100`, not the expected assistant echo. The observer had been closed before the echo was durably appended. Rendered echo text can be transient, and the **Change thinking button is enabled when the picker can open, including while inference is busy**; it is a synchronization-availability check, not an operation-completion barrier. Closing the fixture's owning socket clears its operation timer. The observer now remains alive until a control-plane history read proves the assistant record exists. This controls the actual durability/ownership boundary instead of relying on rendering speed.

The long-history revisit test was tightened for the same reason: it waits for the assistant `history.record` notification and disappearance of its transient cursor before leaving, rather than treating an enabled settings picker as completion. These extra barriers preserve the assertions and do not change or extend timeouts. The final held-hello test passes on both engines, sees zero full-history fetches before/after catch-up, and verifies the durable assistant response plus one user turn.

## Final lifecycle-edge defect

The cold-mounted running case initially refreshed only when departing `running`. Both engines then reproduced a missing final suffix with the explicit sequence running→stopping (first HTTP refresh completes before the tail is replicated)→stopped (final tail becomes available). The old condition never fetched the final stopped snapshot (`/tmp/cache-stop-edge-red.log`). Refresh admission now follows each non-running lifecycle change, with ownership invalidated at the edge. The controlled test passes on both engines (`/tmp/cache-stop-edge-green.log`). This also covers archiving→archived without adding level-triggered history polling. The fixture holds lifecycle/data changes explicitly and does not lengthen any timeout.

The first version of that edge fix revoked HTTP ownership on *every* lifecycle change, including becoming running without starting a replacement HTTP read. The complete frontend suite then failed the existing held-history-404 test in both engines (`/tmp/cache-final-frontend.log`): that authoritative 404 was silently discarded. Ownership is now revoked only when the edge actually starts a replacement non-running refresh. A still-owned request's definitive 404 remains authoritative across a new running/live handshake; ordinary successful/error snapshot application retains its separate connection-epoch fence. The stop-edge and missing-resource tests pass together (`/tmp/cache-stop-and-missing-qualified.log`). This separates resource existence from synchronization freshness rather than using one over-broad cancellation rule.

## Integration qualification: preview-port reuse

After rebasing onto `3eec79a`, the first full E2E attempt failed the existing long-history typing/send case: the last assistant turn stayed at `Review 100`, not the expected echo (`/tmp/cache-rebase-e2e.log`). This was an uncontrolled fixture owner, not a cache or subagent regression. The earlier preview browser remained open on port 5173; the preview process was stopped for the merge, and the test worker subsequently listened on that exact port. Its existing browser could reconnect to the new fixture. `deliverPendingMessage` chooses the first open idle session, and publishes the echo only to that session, so the unrelated preview browser could consume the tested page's delivery.

`ss` identified the test worker owning 5173. Source inspection of Vite 7.3.6's `startServer` showed that `listen(0)`/configured port zero falls back to the default port rather than requesting an OS-assigned port. A focused regression then deterministically observed **5173**, not **0**, passed to the owned Node server (`/tmp/cache-port-red.log`). The first suite was stopped to correct ownership; its failure log was preserved.

All frontend fixture tests now use `e2e/frontend-listen.ts`: bind the already-created, Vite-initialized public Node HTTP server directly with port zero, handle bind failure at the adapter boundary and fail the Vitest setup with the mapped diagnostic. There is no free-port probe/release race, private Vite-field override, fixed test port or delay-based clearance. Tests cover the actual zero-port binding and error-listener release/failure reporting. The original typing/send test passed with the preview simultaneously restored on 5173 (`/tmp/cache-port-qualified.log`). The preview has its own optimizer cache directory, separate from sequential test fixtures. Full merged-tree qualification follows this ownership fix; a passing rerun alone would not have cleared the original failure.

## Resulting testing rules

- Know whether a fixture's work is browser/socket-owned; do not import the real runtime's lifetime guarantees into a cheaper fixture.
- A settings-picker availability indicator is not evidence that a model operation finished.
- Synchronize against the state being asserted: committed history for durability, client transport ownership for cleanup, and role-scoped turns for duplicate input.
- Keep the first failure evidence and correct the uncontrolled boundary; a passing rerun or a larger timeout is not qualification.

Real browser↔runtime cache handoff and subsequent inbox delivery are independently covered in `e2e/full-slice.e2e.test.ts`. The frontend fixture is not a substitute for that test.
