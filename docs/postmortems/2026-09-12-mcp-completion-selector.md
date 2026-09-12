# MCP E2E completion selector fails during output retirement

## First failure

GitHub Deploy [34711432756](https://github.com/schani/pi-orb/actions/runs/34711432756)
at commit `279ba07407543d3427dd5bc52fc1409822bd0a6b` failed in checks on
2026-09-12. The durable release record is
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789237915-5a9d985c-26c3-49f1-a620-f965c1306fb2.json`.
It records `failed-before-apply`, `applyAttempted: false`, and no built artifacts.
Production was unchanged. The original workflow and attached record remain
failed; no blind retry was made.

The full downloadable workflow log identifies
`e2e/mcp.e2e.test.ts:358`: `getByText('MCP_CHECK_COMPLETE', {exact: true})`
resolved to two paragraphs, causing a Playwright strict-mode failure in
`toBeVisible()`. Seven other E2E files passed (90 passing tests, one failure).
The subsequent browser-body diagnostic already contained only one completion.
MCP diagnostics contained exactly two `tools/call` requests, one per orb; model
request diagnostics showed each completion rule (1 and 4) consumed once.

## Initial diagnosis (superseded): test synchronization, not duplicated durable output

The protocol deliberately publishes committed history **before** sending
`output_retired` for the corresponding transient block. The browser applies
separate frames. Between those frames its state contains one committed assistant
record and one live block with the same text. `HistoryView` can briefly render
both; after retirement only the committed paragraph remains. React batching or
network timing can hide this intermediate DOM but does not guarantee that it
will never be observed. The single-element assertion incorrectly depended on
that guarantee. This is not an MCP duplicate invocation, replayed model response,
or retained duplicate history record.

`apps/web/src/pages/output-handoff.test.tsx` reproduces the exact ordering with
the real reducer and renderer, holding each frame boundary explicitly. It
asserts paragraph counts 1 → 2 → 1, one durable record throughout the handoff,
and zero live blocks after retirement. Existing `live-output.test.ts` exercises
the real Pi adapter/outbound writer and establishes the same frame ordering over
all four immediate/backpressured and next-response-before/after schedules.
`e2e/output-handoff.e2e.test.ts` holds the two-paragraph DOM in a real browser,
reproduces the old strict-selector failure, verifies the new matcher still
rejects persistent duplicates, and then explicitly delivers the one-copy DOM.
No timing-dependent model replay or sleep is necessary to reproduce the defect.

## Initial selector-only fix and validation (superseded)

The three MCP completion checks now use a visible-element filtered locator and
an array `toHaveText([expected])` assertion. Unlike single-element visibility,
the list matcher can retry an intermediate count mismatch without a strict-mode
selector failure. It still requires **exactly one visible paragraph with the
exact completion text**, with the original 60-second bound. It neither selects
`.first()` nor accepts multiple matches. The durable-history, exact MCP-call
counts, credential rotation, shared project reuse and isolation checks remain.

Changing the runtime protocol or restoring text-equality deduplication was not
necessary: history-before-retirement is intentional, and a later response can
legitimately repeat prior text. The retirement identity rules remain as recorded
in `docs/runtime-protocol.md` and
`docs/postmortems/2026-09-09-stale-thinking.md`.

Validation: `npm ci`; typecheck; Biome on the three changed test files; the new
reducer/render regression plus all four adapter retirement schedules; and
`npm run test:e2e -- e2e/mcp.e2e.test.ts e2e/output-handoff.e2e.test.ts` all passed.
The MCP browser/real-Pi/HTTPS test passed in 106 seconds, including both orbs,
credential rotation and foreign-project isolation. No production retry or full
release is claimed by this focused validation.

## Corrected diagnosis and atomic implementation (2026-09-12)

The user correctly challenged the test-only diagnosis: lack of duplicated durable
history does not make duplicated presentation acceptable. The renderer really
could show both copies, and tolerating that window in tests hid a protocol/UI
oversight. The stream block IDs and native history IDs existed, but the frame
omitted their replacement relationship. Preserve the earlier investigation as
evidence of the misclassification, not as the current design decision.

Tests were changed first. They required one rendered paragraph across commit,
no retiring blocks in any post-commit browser/reconnect snapshot, and survival
of a newer response (including repeated text). All five initial assertions
failed deterministically against the old handoff. Additional explicit tests
exposed snapshot-before-microtask and HTTP-repair-before-socket races. Failure
logs are preserved locally as `/tmp/atomic-handoff-red-controlled.log`,
`/tmp/atomic-snapshot-red-controlled.log`, and
`/tmp/atomic-http-prepatch-red.log`; reproduction is the committed finite
schedule matrix, not a random trace. The original snapshot fixture lacked the
SDK baseline-append method and was corrected before attributing its readiness
failure to the product.

Each history frame now carries a required `retiredBlockIds` array. The browser
inserts history and removes these exact block IDs atomically. Pi's adapter binds
the native message object to its message-scoped IDs at `message_end`, then
consumes that association only after successful mapping/publication. The SDK
passes that same object to SessionManager; a real SDK contract test verifies
identity across append and mapping even when two messages have identical text.
No new persistent ledger, text comparison or timing-based buffer is required.
The runtime removes matching reconnect blocks before broadcasting the frame.
Snapshot reads drain pending publication before supplying the history/live pair;
failed mapping leaves live output intact. While a socket is open, its ordered
frames exclusively own history updates. Disconnected HTTP repair clears stale
transient blocks rather than showing them alongside repaired committed history.

The separate `output_retired` event, overlap-tolerant MCP assertions and browser
test that enshrined the duplicate DOM are removed. Strict MCP assertions are
restored. The deterministic adapter/writer/reducer matrix covers sixteen
combinations: next response before/after commit, immediate/backpressured delivery,
explicit snapshot/microtask publication, and a blocking mapping failpoint. It
records every observable frame state rather than relying on React batching.
Renderer tests require a single copy through handoff and preserve a legitimately
repeated later response; replica-repair tests include the before-first-patch
case. This is a direct POC contract change; older runtimes must restart, not use
a compatibility event alias.

Final validation: typecheck and lint passed; 43 targeted protocol, publisher,
renderer and finite-schedule tests passed; the complete Docker-backed E2E suite
passed all 91 tests with strict MCP selectors restored, including after the
final HTTP-before-first-patch fence. The full unit/DST run had 1,651 passing tests
and five skips but also exposed an independent deletion/discard scenario-ordering
failure. Its trace was preserved and targeted replay reproduced it; see
`docs/postmortems/2026-09-12-delete-discard-dst-ordering.md`. The earlier full
unit run was green, but it does not clear this later failure. No deployment was
performed, and the separate DST blocker remains in `TODO.md`.
