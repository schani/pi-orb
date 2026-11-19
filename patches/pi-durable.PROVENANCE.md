# Pi Durable policy patch

Package: `@earendil-works/pi-durable@1.5.2` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.5.2/packages/durable
Published artifact: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.5.2.tgz
Artifact SHA-256: `915648ed07c48ca4a2cf8bde97e9b1693a0127cb1332225b6883bf0d5f6f9082`.
Artifact integrity: `sha512-zDB3anbI/yD0IG+VVY+g5tU+c5XOVqQAFwLkXRMiqZb4p/afWro0voZtLNoRAWcDA2r73kvmH6kKin9Ka8l55g==`.
Patch SHA-256: `96e628bdd02a7b5700ffff23fda8643156262ba8b2ed1ff353ee38bc1c8d5530`.

**Decision (2026-10-16):** retain upstream native execution, task identity, journal and replay. Export the existing `CodemodeRunDoc` and `CodemodeJournalDoc` through the public code-mode JavaScript/declaration barrels so chart replay reads native successful journal entries and completion decoration updates native `run.result` in the same commit. Private imports, copied document tokens and a second task document/journal are rejected.

Initialize native namespace snapshots from all supplied namespaces, including resource-only MCP servers with no callable tools. Preserve optional descriptions/instructions and canonical names; existing longest-prefix assignment fills real tools. Discovery accepts canonical and normalized names. Empty tool lists already fit the native snapshot schema; no synthetic callable tools or new schema.

Code-mode presentation and persistence policy: `docs/pi.md`. Native preview serialization is unpatched.

**Decision (2026-10-16):** preserve explicit null in native tool calls for existing schema validation before hooks, authorization, credential acquisition or effects. Only omitted or undefined arguments default to {}; null must not become an effectful parameterless-object call. Actual native MCP coverage checks caught/uncaught null rejection, sanitized outcomes and exactly-once valid {}, omitted and undefined calls.

Decode image saves into one preallocated `Uint8Array` with an indexed byte copy. This avoids string-iterator materialization before the scoped writer can decline binary saves. Controlled Node 24.22.0 profiles at a fixed 4096 MiB heap preserved every byte of a 20 MiB image: decoder peak RSS fell from 894,992 to 195,552 KiB; actual formatter peak RSS fell from 869,728 to 166,276 KiB. Base64, image blocks and save-failure labels are unchanged. This is a host allocation bound for the decode step, not a host-wide 256 MiB limit. The separate validation-worker SIGABRT came from Vitest's new full-buffer deep-equality assertion, not this decoder.

Root and packaged control-plane installs run `node scripts/apply-dependency-patches.mjs` without arguments and require all three patches: Pi AI, codemode and Durable. Missing inputs fail preflight. Execution/native-Claude guests install unmodified locked dependencies without the runner or patch files; loaded-closure checks verify zero patched files. Installation contract: `docs/stack.md`.

File SHA-256 pairs are pinned in `scripts/apply-dependency-patches.mjs`. Regression contracts: `apps/orb-runtime/src/dependency-patch.contract.test.ts`, `apps/orb-runtime/src/dependency-patch-application.test.ts`, `scripts/apply-dependency-patches.test.mjs`. Native behavior/reopen/chart coverage lives under `apps/control-plane/src/adapters/durable/tools/`.

**Decision (2026-10-18):** add input-only `Conversation.submitMany(inputs, context)`. One Session commit validates and looks up all request IDs before table writes, queues each distinct input through the shared admission helper, then applies one idle boundary. Empty and duplicate-only snapshots advance an idle inbox without minting replacement submissions. Pi configures both queue modes as `all`; receipts and entries remain per input. No persisted document or submission schema changes.

**Decision (2026-10-24):** `DurableAgent.open` sets native `HarnessSettings.afterFailedRun: "continue"`. Terminal provider/blocking-compaction `model_error` and `no_model` settle failed inputs before a final boundary starts queued input. A still-unavailable model settles the finite queued batch `unanswered`; it does not replay failed input or start an empty run. This is nonpersisted Harness configuration. This drains already-admitted input even during Sleep, when SQL dispatch is gated. Duplicate-only `submitMany` also advances idle queued input without replaying failed input. Writable reopen guards unfinished submissions with the existing recovery budget before an empty snapshot advances the queue; passive reopen stays inert. Regression coverage: `apps/control-plane/src/adapters/durable/{agent-backlog,queued-model-error,queued-no-model,operation-identity}.test.ts`.

The rebase preserves upstream OpenCode session headers and optional telemetry contracts. Batch admission adds one content-free span; single-submit statuses and per-input identity remain native. Failed-run continuation uses the public native policy for both failure reasons.

Exact stable 1.5.2 retains three patch sets, 17 files and 38 hunks. Durable keeps eight files/11 hunks. Both code-mode barrels still omit the existing native run/journal tokens, so their export hunks remain necessary for chart replay. Resource-only namespaces, canonical/normalized discovery, explicit-null validation and the low-allocation decoder retain their guards.

`Conversation.submit(tx, draft)` remains native: it rejects admission after the transaction's first table write, including a previous admission. It cannot replace the atomic multi-input snapshot. `submitMany` retains pre-read request deduplication and empty/duplicate-only idle advancement; its final boundary now passes native `{ inputs: users, first }` to `startRun`, preserving the first-entry token used by native run hooks. New inputs honor native `whenIdle: "reject"`; known request IDs still return their receipts. No documents, journal format, task identity or recovery algorithm are patched. Native `afterFailedRun: "continue"` remains Harness configuration.

The lock retains coding-agent's upstream `undici@8.12.3` and `minimatch@11.0.3` pins. Chord 1.5.2 still declares an optional exact `ws@8.21.0` peer. Keep the version-scoped override to match first-party `ws@8.23.0`. Chord's Node HTTP adapter still uses the public `WebSocketServer` upgrade and socket APIs; ws 8.23.0 retains these and bounds queued automatic pongs by default. Pi Orb uses Chord's public context, JSON, watch and delta subpaths, not Chord's HTTP server.

## Pi AI patch

Package: `@earendil-works/pi-ai@1.5.2` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.5.2/packages/ai
Published artifact: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.5.2.tgz
Artifact SHA-256: `d5715efa834c23bfdf10a042b49df4ee169cc99000bf16d7998fab2d533b45f8`.
Artifact integrity: `sha512-2tWPSnV3qzfiDIY3aWluBag3vC++Vs+VsXt/UquSU5onPMohPih72FUhIhaqmDdMYubOgB3Byl9uF4Vk40JLvQ==`.
Patch SHA-256: `5cbc618e470d84997f02f29f0afa1fcfa98f5638320ce8312b618cf5b64f1543`.

Three files/18 hunks supply the [Pi model catalog additions](../docs/agent-context.md) and retain typed, bounded Codex failure facts and request-bound safe broker metadata. Rebase follows the native catch block after upstream removed obsolete custom-input cleanup; transport selection and request behavior remain native. Runtime errors expose only valid WebSocket close codes; typed diagnostics keep allowlisted codes, validated request IDs and bounded numeric fields. Pristine/patched file hashes are sealed by `scripts/apply-dependency-patches.mjs`.

**Decision (2026-11-06):** `Waiters.add` marks its already-aborted rejection handled. Callers return that promise across the Session line, so an in-flight commit could leave it unobserved past a macrotask and Node would exit. Evidence: `docs/postmortems/2026-11-06-control-plane-blackouts.md`.
