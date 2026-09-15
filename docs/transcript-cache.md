# Bare browser transcript cache

## Scope selected and implementation authorized (2026-09-15)

The user selected **bare caching first**, approved the plan, and explicitly required DST/tests first. The frontend implementation is locally qualified; no deployment is included. Evidence: `docs/postmortems/2026-09-15-long-transcript-navigation.md`. The broader alternatives remain in `docs/web-ui.md`; transcript navigation question 64 in `docs/open-questions.md` records scope selection.

**Goal:** returning to a recently visited running orb avoids downloading and parsing its full transcript again. The view still remounts, so this does not promise to remove DOM/layout, Markdown, accessibility or 1Password costs. Cold opens remain unchanged.

**Explicitly excluded:** pagination, virtualization, lean history DTOs, new HTTP/runtime contracts, IndexedDB/localStorage transcript persistence, prefetching, background sockets for inactive orbs, hidden mounted conversations, scroll-anchor restoration and 1Password changes. Keep today's tail-on-open/autofocus behavior and separate composer-draft persistence. This deliberately narrows the earlier cache brainstorming, which included scroll restoration and a stopped-orb delta endpoint.

## Smallest useful design

### Ownership and contents

One app-owned, injectable cache survives orb and dashboard route changes in the current browser tab and is discarded on reload. Tests construct isolated instances; avoid an unresettable module singleton or a general query-cache framework.

Cache only a coherent transcript snapshot:

- orb ID and harness session ID;
- immutable, ordered complete history records;
- last-applied record cursor and associated head ID.

Records, cursor and head are published atomically. Reuse existing record objects/map snapshots; do not stringify, clone, or schema-validate the entire cached history again on a hit. Cache admission checks the record IDs/cursor/head and sums memoized per-record sizes; it does not rerun the history JSON schema. Feed cache publication from applied committed-history changes, not token patches, typing or metadata polls. A reducer remains pure; a narrow integration boundary publishes accepted snapshots outside render/reduction. Publishing only an older applied prefix during unmount is safe because reconnect resumes from that prefix; publishing a cursor beyond retained records is not.

Never cache pending requests, connection/capability authority, settings, busy state, operation IDs, live text/reasoning/tool blocks, timers, terminal sessions or errors as successful history. Restore transcript fields into otherwise fresh conversation state. Outstanding inbox state continues through its existing refresh path.

**Implemented fixed limits:** three cached conversations and 128 MiB of conservatively estimated retained data, evicted least-recently-used. These are internal constants, not user settings. Account for record payloads including duplicated native strings/images, with per-record accounting reused by object identity and bounded bookkeeping. No whole-transcript serialization on every append. The estimate is not a guaranteed JavaScript heap/RSS cap. A single oversized entry is not cached and any prior stale entry for that orb is removed; its active UI still works normally. Eviction releases cache references, not the active UI's own records. No TTL: freshness is established on entry, not inferred from elapsed time.

### Navigation and freshness

1. **Always fetch fresh orb metadata.** On a hit, that small request replaces—not accompanies—a blocking full-history request. Reuse the current pending-navigation behavior: the old conversation stays visible and inert until destination metadata resolves. This is simpler and safer than showing cached lifecycle controls immediately. Cache is a transcript optimization, not a missing-resource or lifecycle authority.
2. **Miss:** use the current parallel metadata + full-history fetch. Cache only a valid successful snapshot for the requested orb, provided the load still owns the navigation.
3. **Hit + running:** initialize from cached records after metadata confirms the resource; connect through the existing live hello with the cached last-applied cursor. Skip the ordinary full-history GET. Live replay supplies missed records and reconstructs current ephemeral state. Initial live catch-up owns ordinary inbox gaps, including while the connection is still `closed`/`connecting`; only a `retrying` running transport admits automatic replica repair. Existing disconnected-history/inbox repair remains available when actually needed; do not promise zero history requests under every fault.
4. **Hit + not running:** show cached records after the metadata check, then revalidate once using the existing full-history endpoint in the background. This intentionally still downloads history for stopped/failed/transitional/archived orbs: no new delta API in this slice. Do not block display, nor silently consider stale history fresh. Also revalidate on non-running lifecycle changes, including final `stopping`→`stopped` and `archiving`→`archived` edges: the first transitional snapshot can precede the final drain, so refreshing only on departure from running misses that suffix. Share/coalesce this request with the current delivered-inbox repair path; no new polling or retry loop.
5. **Lagging replica:** for the same session, merge the replica prefix ahead of a newer locally received live suffix without dropping or duplicating records. A response started before a newer live synchronization may not overwrite it. Extend the existing `history-refresh.ts` and refresh ownership rather than adding a parallel merge implementation.
6. **Failure:** a failed refresh keeps valid cached records with scoped failure + Retry. A failed metadata lookup does not authorize lifecycle/live actions from cache. A confirmed 404 invalidates cache and renders the orb-specific missing page at the requested URL, never a redirect. Confirmed deletion/deleting state also evicts; late callbacks cannot recreate the entry. Known project deletion evicts that project's entries using existing project ownership information at the integration boundary.

The cached metadata check may still take a network round trip. The expected win is removing the multi-second full-history dependency, not claiming a zero-latency switch.

### Synchronization and stale-response rules

Use one explicit navigation/load ownership token and per-entry writer ownership; keep the synchronous cache primitive free of transport/retry machinery. HTTP and socket adapters carry the owner/session they belong to. Completion checks apply to both visible publication **and cache writes**, including A→B→A, not merely matching the current orb ID. Cancellation is discard-only in this slice: a superseded cold HTTP transfer may finish, but cannot publish. No abort/retry framework is added. Explicit resource invalidation also advances one app-wide invalidation epoch; a load spanning that edge returns a visible retryable-in-practice history error rather than reinstalling an older success. This deliberately conservative fence can reject a concurrent load for an unrelated resource. It is preferred to retaining per-orb/project deletion tombstones indefinitely; ordinary reads/evictions do not advance the epoch. The final consumer checks load ownership again before changing the selected view.

- A cached cursor is null for empty history or names the final retained applied record; a non-null head must name a retained record. Histories are full prefixes in this slice, not paged windows.
- `sync.started(mode: full)` invalidates the old snapshot and clears records before applying the new stream. Do not publish an incomplete replacement as a fresh cache entry: admit it after `sync.completed`. An interrupted full sync remains a miss unless a subsequent successful, consistent full HTTP refresh independently establishes a cacheable prefix while disconnected. Apply the same rule on cache misses so a prior successful replica prefix cannot accidentally be labeled with a replacement session.
- A differing session ID from a fresh snapshot or welcome invalidates the old session. Never concatenate two sessions. Resynchronize from null when required, using existing full synchronization rather than changing the wire contract. A changed runtime instance with the **same** session does not itself invalidate complete history.
- A null-session/empty replica must not erase known newer live history merely because replication has not initialized yet. Treat it as lagging/unconfirmed; current-runtime full synchronization remains authoritative for session replacement.
- Delta replay is ID-deduplicated; persist a newer cache snapshot only from the actual applied state. Stale HTTP, disposed sockets, deletion and interrupted full sync may neither advance its cursor incorrectly nor revive an invalidated entry.
- Cached state never restores request replay or marks the runtime synchronized; existing live readiness and HTTP inbox admission remain authoritative.

## Local qualification evidence (2026-09-15)

Tests were written before integration. The initial missing-module failures established the unimplemented baseline; after the cache primitive existed, both composed DST regressions failed against the old reducer, were explicitly replayed before changes, and now pass the same traces:

- `test-failures/transcript-cache-navigation-1789488550628-1.json` — restoration absent when navigation wins before cancellation;
- `test-failures/transcript-cache-full-sync-1789488550635-0.json` — no cache-ready/full-sync publication boundary.

Both small traces are retained in version control. Normal DST runs explore 40 schedules for each scenario; replay uses `DST_REPLAY=<path> npx vitest run apps/web/src/pages/transcript-cache.dst.test.ts -t <scenario>`. Five focused files currently contain 23 tests for the primitive, actual loader/reducer composition, response/session fencing, byte-accounting reuse, and real browser-transport adapter driven by owned fake sockets. Cache publication projects only transcript fields even if passed a structurally wider object.

Additional tests exposed and fixed implementation defects before completion, rather than treating a rerun as clearance:

1. A history 404 after successful metadata initially remained a generic history failure. The loader now treats either authoritative 404 as the missing orb, invalidates the cache, and preserves the URL.
2. Both browser engines reproduced a lost stopped-orb refresh: a one-shot ref was consumed in StrictMode's first setup, whose cleanup cancelled the response. Re-entering setup saw the consumed ref and never revalidated. Deriving refresh initiation from the cache-hit/lifecycle inputs, rather than consuming that ref, restores idempotent effect setup. The held 503 then appears and Retry applies the new tail.
3. Both engines reproduced a live socket surviving a history 404 when a newer metadata poll still reported running. History-driven absence now clears resource state and independently gates `shouldConnect` on non-absence; the controlled test observes the single live socket close, without waiting for the server to correct stale metadata. The test holds a stopped-orb refresh, admits a running metadata update/live handshake, then releases the definitive 404. No assertion or timeout was weakened.
4. An unseen delivered inbox message during the initial cached reconnect could trigger the old full-history repair path before hello completed. A held-hello test exposed one redundant history fetch in both engines; repair now defers to initial live synchronization, with HTTP fallback reserved for transport retry/non-running views. This test also exposed fixture-lifetime and completion-selector mistakes, which were corrected using an independently owned fixture observer, durable-history barriers and role-scoped assertions. First evidence and rationale: `docs/postmortems/2026-09-15-cache-catchup-fixture-ownership.md`.

Browser qualification uses two large responses (approximately 26 MB and 6 MB of extra native data), preserves a completed live record and draft across A→B→A, holds fresh metadata to prove the old view stays inert, blocks repeat history GETs, checks the exact hello cursor and a successful subsequent send, and covers phone/dashboard return, reload misses and LRU eviction. Separate stopped/missing scenarios cover refresh paint ordering, Retry, scoped errors, canonical missing URLs and live ownership. All new browser scenarios run on Chromium and WebKit. The real full-slice test adds a cached visit to the independent spawned orb, switches to its source and back, blocks repeated history reads, verifies the actual runtime hello cursor, then successfully submits the existing upload notification through the durable message inbox and completes real Pi/mock-model inference. This reuses the ordered inference script instead of adding an uncontrolled extra model consumer.

**Local performance sample, not a field-latency promise:** a headless Chromium development-fixture run served a 26,290,567-byte history response. The cold accepted load took 2,153.5 ms; three warm returns took 24.9, 11.3 and 12.8 ms for metadata/cache loading, with **zero additional history reads**. StrictMode caused two initial cold HTTP reads; cancellation remains discard-only. Accounted cache data for the long orb was 52,679,278 bytes. Recorded mount-to-live intervals remained substantial (cold 2,657 ms; two recorded warm intervals 2,135 and 1,314 ms), confirming that caching does not eliminate remount work. The third warm interval was not captured by the diagnostic consumer before it closed, so no value is inferred. This ran locally without 1Password, in a development build and alongside validation work; these numbers are diagnostics, not benchmark thresholds or claims about cloud/Zen performance. Content-free output is retained at `/tmp/cache-profile-results.json` in the implementation workspace; the important findings are recorded here.

Whole-suite final results are recorded in `docs/testing.md` after qualification; no deployment is included.

The final lifecycle-edge test additionally reproduced a missing post-drain suffix on a cold-mounted running orb in both engines. Refresh admission now follows non-running lifecycle changes, not just the first departure from running; the final stopped snapshot replaces/coalesces the earlier stopping refresh. The same rule covers archiving→archived and adds no periodic history polling.

## Main integration (2026-09-15)

Rebased onto `3eec79a` after the local-subagent work landed. The welcome reducer preserves both contracts: clear the live child roster on every welcome, and independently invalidate cached records only for a changed session. Cache restoration has no live roster. Focused integration regressions cover same-session and replacement-session welcomes. The merged question-number collisions are retained and topic-qualified rather than renumbering published questions. The preview was restarted after integration because main also changed the shared runtime protocol and Playwright version. Integration qualification additionally corrected Vite's zero-port fallback so a preview browser cannot reconnect into an E2E fixture; the listener regression and full merged-tree suite pass (1,775 unit tests plus infrastructure, 73 process-backend E2E tests, typecheck/lint). Evidence and expected platform skips are recorded in `docs/testing.md`. The user subsequently authorized the main push.

## Implementation sequence (tests first; completed)

1. **Cache primitive:** add `apps/web/src/lib/transcript-cache.ts` and focused unit tests for coherent snapshots, reference reuse, fixed LRU/admission accounting, oversize bypass, invalidation and fresh instances. Keep cache errors/misses explicit rather than exception control flow.
2. **Applied-history boundaries:** extend the actual `OrbPage` reducer/history-refresh helpers for session-aware snapshot restoration/publication and full-sync invalidation, preserving existing transcript/live-output/inbox rules. Write regressions before wiring navigation.
3. **Navigation integration:** wire the app-owned cache through `App.tsx` and `OrbPage.tsx`; factor only the small load/refresh ownership logic necessary to exercise it independently of React. Existing API adapters remain typed `Result` boundaries. No new lifecycle or transport state machine.
4. **Composed scheduling tests:** drive that production load/refresh logic, cache and reducer with `determined`, injected metadata/history completion and runtime-frame delivery. React lifecycle wiring is separately tested in the browser. Preserve/replay failure traces before fixes.
5. **Browser and real-runtime qualification:** add held-response/socket fixtures and run the checks below; measure the cache hit path without inventing a brittle wall-clock acceptance threshold.

## Required tests and invariants

### Unit and deterministic scheduling

- Empty and non-empty restore; consistent ordered records/cursor/head; cached maps are not mutated by a mounted consumer; no ephemeral or pending request state restored.
- Exact LRU behavior, byte-accounting updates, oversized entry rejection, eviction/reference release, reload/new-instance miss, and no byte recount/cache publication on typing or token-only frames.
- Cold success/failure; running hit skips history GET and sends correct hello; non-running hit uses one background refresh; live delivery since leaving is included in the next cache snapshot.
- A→B→A with out-of-order reads, superseded loads, StrictMode setup/cleanup, late socket events after disposal, invalidation during fetch and older callback after entry replacement. Assert no wrong-orb/session publication or cache resurrection at every checkpoint.
- Delta overlap/deduplication; lagging replica versus live suffix; HTTP completion before/after live opens; running→stopped during catch-up; coalesced delivered-inbox and lifecycle refresh.
- Session replacement, unknown cursor/full sync, interruption at each full-sync boundary and runtime restart retaining the same session. No mixed sessions, phantom completeness or cursor skipping.
- Confirmed missing/deleting orb/project and failed revalidation: correct eviction, preserved URL, visible failures, retained valid history on retryable errors and no stale live authority.

### Browser tests

Use explicit gates/completion signals, not sleeps, "fast enough" thresholds or requests counted before transports settle. Add two realistically large conversations to the frontend fixture, including bulky tool/native payloads; the current 200-message fixture alone is not representative of the measured 25 MB response.

- Cold-open A and B, receive a complete live record on A, return to A with its history endpoint blocked. After fresh metadata and live synchronization barriers, assert the cached/live record is visible, **no navigation-triggered full-history GET occurred**, and the hello cursor matches the latest cached complete record.
- Withhold destination metadata: preserve the existing pending/inert behavior; then release it and complete the cached switch. Cold navigation, the persistent fleet index and native missing-resource URL behavior stay unchanged.
- Deliver new records after return; confirm exactly-once transcript output and fresh settings/activity. A cached busy orb must not show a phantom live cursor or enable live-only actions before current authority arrives.
- Stopped-orb refresh is gated: cache appears before refresh completes; then the suffix appears. Failure retains the transcript with Retry; a later 404 replaces it with the required missing page.
- Exercise forced eviction, reload, dashboard round trip, rapid switching, draft preservation, desktop autofocus/tail behavior and phone viewport/scroll ownership on Chromium/WebKit. No new scroll restoration behavior.
- Add a real process/runtime E2E A→B→A case proving actual hello/cursor replay and acceptance of a subsequent message, not just fixture-generated frames. Include an authoritative completion barrier before asserting socket ownership or zero unnecessary requests.

### Observability and acceptance

Emit a small content-free navigation diagnostic at cache selection/completion: hit/miss/bypass reason, orb ID, record count/accounted size, metadata/history timing, and sync-ready timing. Bound/clear browser performance entries and expose the same injected diagnostic sink to tests. No transcript text, tool arguments, credentials, busy-state resurrection or healthy-state cache badges. This is ephemeral browser performance state, not a durable autonomous lifecycle decision; no database cache log/table is introduced. User-affecting read failures remain visible at the owning surface.

The key deterministic performance contract is **no ordinary full-history read/JSON reprocessing on a running cache hit**, plus bounded cache retention; rendering time is explicitly unchanged. Profile cold and A→B→A paths after implementation to compare against the field evidence, reporting remount cost separately. Do not declare the entire seven-second incident fixed by a network-cache test.

Install dependencies with `npm ci` before checks. Run focused unit/DST regressions, `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:e2e:frontend` (Chromium/WebKit), and `PI_ORB_E2E_BACKEND=process npm run test:e2e` for the real handshake. The full runtime E2E is required for this plan even though no wire contract changes. Flaky failures block completion until root-caused; passing reruns are not clearance. No deployment is included.
