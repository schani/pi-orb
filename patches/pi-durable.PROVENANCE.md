# Pi Durable policy patch

Package: `@earendil-works/pi-durable@1.5.0` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.5.0/packages/durable
Published artifact: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.5.0.tgz
Artifact SHA-256: `7e95b160ebebb7059dd5f5502419b85d52f1e0432a9e914e608364ae9b2b2a69`.
Artifact integrity: `sha512-xeBP2vIo5NvsCMQ4Y/V+Z164xQEi9JWiBWHdjn4Z15EnFqV3c0FxJAX26FqyyyintrYyk+Enre94GNcvRlBA5g==`.
Patch SHA-256: `837bbe87cc9001e189e875d2bf123e65dea49a23463f70a23d37d64c24bbebd6`.

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

Exact stable 1.5.0 retains three patch sets, 16 files and 40 hunks. Durable keeps eight files/14 hunks. Both code-mode barrels still omit the existing native run/journal tokens, so their export hunks remain necessary for chart replay. Resource-only namespaces, canonical/normalized discovery, value-free previews, explicit-null validation and the low-allocation decoder retain their guards.

`Conversation.submit(tx, draft)` remains native: it rejects admission after the transaction's first table write, including a previous admission. It cannot replace the atomic multi-input snapshot. `submitMany` retains pre-read request deduplication and empty/duplicate-only idle advancement; its final boundary now passes native `{ inputs: users, first }` to `startRun`, preserving the first-entry token used by native run hooks. New inputs honor native `whenIdle: "reject"`; known request IDs still return their receipts. No documents, journal format, task identity or recovery algorithm are patched. Native `afterFailedRun: "continue"` remains Harness configuration.

The lock adds transitive `pi-schema@1.5.0`. Upstream coding-agent pins `undici@8.12.3` and `minimatch@11.0.3`, replacing the scoped coding-agent override. Minimatch requires `@isaacs/nonrecursive-glob-match@^1.0.3`. Chord's optional exact `ws@8.21.0` peer conflicts with first-party `ws@^8.22.1`; a scoped `@earendil-works/chord@1.5.0` override retains `ws@8.22.1` instead of downgrading or ignoring peer resolution. Static/glob and metadata/gaxios overrides remain. All unrelated package versions, including `pglite-pg_textsearch@0.0.14`, remain fixed.

Registry tarballs for chord, pi-ai, pi-codemode, pi-coding-agent, pi-durable, pi-mcp and pi-schema were fetched at exact 1.5.0 and checked against published SHA-512 integrity and SHA-1. Fresh root `npm ci` applied all three seals, installed 680 packages and audited 688 with zero vulnerabilities. Node installer coverage passed 23/23; Vitest installer contracts/application coverage passed 53/53. These are installation checks, not full runtime qualification.

## Pi AI diagnostic patch

Package: `@earendil-works/pi-ai@1.5.0` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.5.0/packages/ai
Published artifact: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.5.0.tgz
Artifact SHA-256: `e320fe7bd2b927782ba9a37d356fe5837f1aa96a46432610e1b3b9ccb748ea5c`.
Artifact integrity: `sha512-VeWxNqTHSqRCf8AcY/6kvNwh+neRL6MPxZPePVztIQy6qqK9MR/YoCSN/ZgDnIyCD3pqEXgRyQbzk4KV4uvjbg==`.
Patch SHA-256: `f7d82a2a5b31d2d2ea11ce3674bb9adcd726bafd1cce43a0de62eada03ccaa37`.

Two files/17 hunks retain typed, bounded Codex failure facts and request-bound safe broker metadata. Rebase follows the native catch block after upstream removed obsolete custom-input cleanup; transport selection and request behavior remain native. Runtime errors expose only valid WebSocket close codes; typed diagnostics keep allowlisted codes, validated request IDs and bounded numeric fields. Pristine/patched file hashes are sealed by `scripts/apply-dependency-patches.mjs`.

**Decision (2026-11-06):** `Waiters.add` marks its already-aborted rejection handled. Callers return that promise across the Session line, so an in-flight commit could leave it unobserved past a macrotask and Node would exit. Evidence: `docs/postmortems/2026-11-06-control-plane-blackouts.md`.
