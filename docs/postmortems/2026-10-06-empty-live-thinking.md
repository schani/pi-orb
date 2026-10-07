# Empty live thinking disclosures — 2026-10-06

Investigation and locally qualified approved simplification; GitHub gates pending, not deployed.

## Evidence

- User screenshot: orb `1283364b-e850-45df-9368-d7556c0793ef` showed 13 green thinking disclosures with empty expansions.
- Lossless CLI transcript `/tmp/thinking-transcript.json`: native `ef3097d7`, timestamp `2026-10-06T22:16:47.545Z` (17:16:47.545 America/Cancun), contains 13 `thinking: ''` blocks. Their `thinkingSignature` has `encrypted_content` and `summary: []`; normalized reasoning has `text: ''`. Native `ed275a87` contains 23 such blocks. No encrypted payloads or tokens are reproduced here.
- Read-only production verification identified serving revision `pi-orb-issuer-00043-2k5`, source `404cf7b1d54fff65ca09844e6cd9b2a1af8ff1ca`, including committed suppression introduced by `2af555c3`.
- Fresh authenticated browser history at 2026-10-06 17:29:58 America/Cancun returned zero reasoning blocks for both native records, only tool calls.

## Finding and limits

At investigation time, the live adapter emitted empty thinking patches and the frontend rendered every live reasoning block. This visibility gap is the leading explanation, not an established reconstruction of the screenshot. Its live block IDs/frames and the orb runtime revision were not captured; stale browser state and the exact mechanism remain unproved. The 13-block count matches, but does not establish identity.

Current main retires output at `message_end`: the publisher's `history.record` carries `retiredBlockIds`, atomically removing live rows independently of long-running tool completion. Persistent green rows alone do not prove a retirement bug. Fresh history already demonstrates committed suppression; the completed work is not reopened.

## Later live observation (2026-10-06)

Sanitized evidence: `.context/empty-live-reasoning/stall/summary.json`. During 17:42:01–17:43:11 America/Cancun (22:42:01–22:43:11Z), the same runtime, operation and assistant sequence 90 continued streaming: reconnect snapshots contained 76 → 79 → 81 reasoning blocks, with five new patches 13–16 seconds apart. Live HTTP details were empty for 78/78, then 81/81 blocks. History stayed at 1,033 records, head `ac5b8c75` (tool, 17:24:24 local / 22:24:24Z); no active subagents were reported.

This rules out only stale UI or a completely frozen stream during this interval, not pathological inference; it proves no useful reasoning. All 59 saved reasoning items had distinct provider IDs and nonempty, differing ciphertext, without summaries. Current live APIs expose no ciphertext, so that finding cannot be extended to current live blocks. Earlier screenshot attribution limits remain.

At 17:44:56 local (22:44:56Z), inbox verification found message `7c6f791a…`, created at 17:42:21.179 local (22:42:21.179Z), still `delivering`, classified `steer`, with matching live operation `118fa0be…` and no error. Runtime acceptance was pending, not evidence of application or persistence. Pi core `dist/agent.js` and `dist/agent-loop.js` queue steering until the current model-response boundary; steering does not interrupt in-flight inference.

The user later reported spontaneous recovery without intervention. This supports a transient provider-side explanation, but provider logs were unavailable; the precise cause remains unproved.

## Invariant

Preserve canonical provider reasoning. Public empty, nonredacted reasoning must create no disclosure in either live or committed presentation. Keep headingless nonempty reasoning and redacted notices visible; preserve canonical identities and explicit disclosure aliases. An unexpectedly emptied previously visible block may remain until commit; replay omits it while empty. Local qualification and release limits: `docs/testing.md`.

## Initial correction (locally qualified 2026-10-06; superseded, not deployed)

Reasoning patches carry empty replace text, capped headlines and explicit `reasoningVisible`, true iff `redacted === true` or actual body `trim()` is nonempty. Text and reasoning preserve original `contentIndex`; text omits visibility. Pi emits initial identity and headline/visibility changes, not body-only changes; replay preserves these fields. Claude follows the same semantics, including redacted initial starts. Headline parsing and private-body trimming are reasoning-only, avoiding quadratic parsing on the text hot path; text tests preserve initial nonempty replace, delta append and original indices. Full reasoning remains in live HTTP detail and canonical history.

Runtime/browser retain hidden identities and unchanged atomic retirement; only visible reasoning renders. Disclosure handoff matches the original index to committed `detailKey`, not filtered display position. This closes the identified presentation gap locally; it does not establish which live frames or revision produced the screenshot. Historical local and subsequent CI qualification are recorded in `docs/testing.md`; neither qualifies the simplification below. No deployment is claimed.

## Simplification decision (approved and locally qualified 2026-10-07, America/Cancun; GitHub gates pending)

The visibility flag also handles a readable body becoming empty, but the incident provides no evidence of that transition. PR tests manufacture it; ordinary Claude thinking only appends, and Codex finalization retains streamed thinking when final text is empty. Whitespace-only final replacement remains possible, not observed.

The approved contract suppresses empty/whitespace nonredacted reasoning at live send/replay. First readable reasoning emits a content-free replace even with an empty headline; subsequent patches report headline changes only, while body-token updates remain HTTP-only. Redacted starts are visible. Canonical state retains all blocks and exact-ID retirement. An unexpectedly emptied visible block receives no new patch and stays until commit; replay omits it while empty. Reversible visibility is rejected as unsupported incident scope, so public `output_patch` returns to its original fields without `reasoningVisible` or `contentIndex`.

Message ownership and retirement already use native message identity and exact live IDs. Only disclosure-open-state handoff used ordinal pairing; `contentIndex` moved that pairing to source indices but unnecessarily exposed adapter correlation to the browser. Instead, optional `history.record.detailAliases: Array<{blockId:string,detailKey:string}>` names explicit live-to-committed reasoning matches from the exact native-object/UUID-owned retirement group before private blocks are deleted, filtered to retained display reasoning. Empty, synchronization and unrelated frames omit it. The browser inserts `detailKey → blockId` directly without ordinal pairing or index parsing. Source indices remain runtime-private. Pi emits zero or one canonical block per source block without expansion or reordering; the equal source/canonical count guard omits unsafe aliases when malformed blocks compact. This does not claim full malformed-source matching.

This decision supersedes the initial extra-field contract, not the incident evidence or attribution limits. Focused unit/component, scoped DST and targeted browser checks now qualify the reviewed frozen local code, including narrow redacted-metadata forwarding through the existing live HTTP DTO. Full suites were not rerun locally; updated normal GitHub CI/E2E remains pending (`docs/testing.md`, `TODO.md`).
