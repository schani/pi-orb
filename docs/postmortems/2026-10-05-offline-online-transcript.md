# Transcript missing after offline→online (2026-10-05)

## Report and limits

After going offline and returning online, the browser remained without the newest transcript. A poll returned HTTP 200 with a tiny body; reloading restored the transcript. The poll URL was not confirmed. No field diagnostic dump or original frame capture is available. The field socket state, initiating transport failure and exact cause remain unproved.

## Reproduced defect

The live client previously recovered only after a socket close callback. A transport that remained locally OPEN without delivering frames or close callbacks retained authority across browser offline/online events. Returning online therefore sent no new hello and replayed no missing records.

This is a reproduced client recovery gap, not proof that the field incident followed this path. Proxy heartbeat detection remains necessary when browser connectivity events do not fire.

`POST /messages/poll` reads the durable inbox, not conversation history. Its cursor tracks insertions; tracked IDs request delivery metadata. An empty delta says nothing about a missing assistant suffix. Transcript catch-up belongs to the runtime's cursor-based live handshake; HTTP `/history` reads the replica.

## Why existing DST missed it

`apps/web/src/pages/transcript-cache.dst.test.ts` schedules loader/cache/reducer races but injects live frames directly, bypassing `openLiveConnection`. Inbox DST covers mutation/navigation and delivered-message handoff, not assistant-only catch-up. Original transport fakes closed immediately and invoked `onclose`; separate proxy-heartbeat tests did not prove that a disconnected browser receives close.

No scenario modeled browser offline→online while a socket stayed OPEN and silent. More schedules cannot explore an omitted failure mode. `apps/web/src/lib/live-cache.dst.test.ts` now composes the actual live client, OrbPage reducer, transcript cache and inbox poller under `determined`; transport delivery and browser timers are simulation-owned, not a second live state machine.

## Narrow correction

Offline revokes socket ownership before closing it, cancels retries and reports retrying. Online replaces the transport and resumes from the latest applied record cursor, even without an earlier offline/close callback. Retired callbacks cannot publish frames/status, send hello or schedule retries. Disposal removes connectivity listeners and cancels retry timers.

Pending commands retain the existing instance/session fences: identical requests replay only to the same runtime; changed runtime/session reports loss rather than resending. Content-free connectivity reasons enter the bounded browser diagnostic ring. No polling or history protocol is added. The rule is in `docs/runtime-protocol.md`.

## Local evidence

- `/tmp/offline-online-red.log`: three new unit cases failed against the prior client, including offline retaining `open` and online creating no replacement.
- `apps/web/src/lib/live-cache.test.ts`: strengthened cases keep the retired socket OPEN without a close callback and cover latest-cursor recovery, late callbacks, pending-command replay/loss and disposal.
- `/tmp/half-open-baseline-final-red.log`: Chromium and WebKit each retained only the initial hello with connectivity listeners disabled.
- `/tmp/half-open-review-green.log`: both browser cases passed with the correction. `e2e/half-open-live-frontend.e2e.test.ts` uses the real app with a controlled half-open transport and empty inbox, observes a new hello from the applied user cursor, then renders the missing assistant suffix without navigation or another history read. It does not exercise a real network outage or proxy heartbeat.

## Composed DST proof

The new scenario passes 80 entropy schedules. An initial hello uses `one`; an applied user record advances state/cache to `two`. The old socket stays OPEN without message/close delivery across offline→online. The actual inbox poller's publication callback filters against current records through `messagesAwaitingHistory`, stores the UI rows and verifies that the empty result leaves state/cache untouched. This publication races recovery independently. The replacement hello uses `two`, replays two ordered assistant records and leaves exactly one copy of each record in state/cache. After every frame/status cache publication, and at offline, retired-callback, inbox-publication and disposal boundaries, assertions require the ordered parent chain, tail/cursor/head agreement and matching state/cache records, session, cursor and head. A queued pre-outage record and eventual old close race the replacement handshake, replay cursor advancement and disposal; neither may change state/cache/status or create a retry. Disposal fences further connectivity and socket callbacks. Diagnostics retain identifiers/reasons, not fixture text; scheduler logs are silent.

Baseline was the **entire exact pre-fix file**, temporarily installed with `git show HEAD:apps/web/src/lib/live.ts > apps/web/src/lib/live.ts`, not a listener-disable mutant. It failed the hello invariant: `[one]` instead of `[one, two]`. The full recorded trace was explicitly replayed red before restoring the saved patched bytes; SHA-256 and `cmp` verified byte-for-byte restoration. That same trace replays green with the fix:

```sh
DST_REPLAY=test-failures/live-cache-half-open-1791218837599-0.json npx vitest run apps/web/src/lib/live-cache.dst.test.ts
```

Original evidence: `.context/live-cache-dst/{head-complete-red,head-complete-red-replay,fixed-complete-replay,fixed-schedules,focused,typecheck,lint}.log`. Review-strengthened invariants and UI inbox publication add no checkpoints or scheduling decisions. The same canonical trace again reproduces the hello failure on exact HEAD before byte-for-byte restoration, then replays green with the fix: `.context/live-cache-dst/review-{head-red-replay,fixed-replay}.log`. The strengthened focused gate passes 29 tests in six files, including 80 recovery schedules, existing loader/cache DST and live/inbox/cache units; web typecheck and scoped Biome pass (`review-{focused,typecheck,lint}.log`). Independent validation also passes canonical fixed replay, 80 schedules, all 512 web tests, repository typecheck and lint (existing warnings). No production source change remains from this proof. The full repository unit/E2E suites were not rerun for the added scenario.

The first red trace, `test-failures/live-cache-half-open-1791218684827-0.json`, is also retained. Its assertion stopped before later scheduling decisions, so fixed replay exhausted the trace; that exhaustion was replayed before changing the scenario. Moving the recovery assertion after schedule completion produced the full red/green trace above. Initial logs remain in `.context/live-cache-dst/{head-red,head-red-replay,fixed-replay,fixed-short-trace-replay-confirmation}.log`; the short trace is historical evidence, not a green replay target.

This models application callback ordering, not real browser network detection, proxy heartbeat, runtime server replay implementation or React effect timing. Owned WebSocket messages are never reordered; old close delivery occurs only after a local close request. The reproduced recovery gap still does not establish the field incident's exact cause.

## Earlier qualification

`npm test` passed: 2,697 unit/DST tests, 12 environment-dependent skips, and infrastructure checks (`/tmp/offline-online-unit-full-2.log`). Typecheck and lint passed; lint retains existing warnings. Targeted process-backed E2Es passed all eight cases: new half-open recovery and existing cached catch-up on Chromium/WebKit, plus the real Pi login/tool/replication/drain and lifecycle slice (`/tmp/offline-online-e2e-real.log`). The full E2E suite was not run. No deployment.
