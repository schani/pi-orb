# Pi Durable policy patch

Package: `@earendil-works/pi-durable@1.4.0` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable
Published artifact: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz
Artifact SHA-256: `6d4dedd7a342151bca8b962f35a6231312cb10e5226796734e6644ad02f48224`.
Artifact integrity: `sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==`.
Patch SHA-256: `3e6600e43005a0d474f3941ac80a8b9541c393bab4a9e08f3274612615221bd5`.

**Decision (2026-10-16):** retain upstream native execution, task identity, journal and replay. Export the existing `CodemodeRunDoc` and `CodemodeJournalDoc` through the public code-mode JavaScript/declaration barrels so chart replay reads native successful journal entries and completion decoration updates native `run.result` in the same commit. Private imports, copied document tokens and a second task document/journal are rejected.

Initialize native namespace snapshots from all supplied namespaces, including resource-only MCP servers with no callable tools. Preserve optional descriptions/instructions and canonical names; existing longest-prefix assignment fills real tools. Discovery accepts canonical, normalized and final `__` suffix names. Empty tool lists already fit the native snapshot schema; no synthetic callable tools or new schema.

Three display sites use one bounded preview: JSON-encoded object keys (first 16), otherwise the argument's type, truncated to 256 characters. Native started rows and earlier/current divergence descriptions must not expose argument values. Display previews do not alter execution arguments, nested inputs, native journal arguments or structural replay comparisons. Live internal slots and arbitrary tool error text still require first-party public-projection sanitization.

**Decision (2026-10-16):** preserve explicit null in native tool calls for existing schema validation before hooks, authorization, credential acquisition or effects. Only omitted or undefined arguments default to {}; null must not become an effectful parameterless-object call. Actual native MCP coverage checks caught/uncaught null rejection, sanitized outcomes and exactly-once valid {}, omitted and undefined calls.

Decode image saves into one preallocated `Uint8Array` with an indexed byte copy. This avoids string-iterator materialization before the scoped writer can decline binary saves. Controlled Node 24.22.0 profiles at a fixed 4096 MiB heap preserved every byte of a 20 MiB image: decoder peak RSS fell from 894,992 to 195,552 KiB; actual formatter peak RSS fell from 869,728 to 166,276 KiB. Base64, image blocks and save-failure labels are unchanged. This is a host allocation bound for the decode step, not a host-wide 256 MiB limit. The separate validation-worker SIGABRT came from Vitest's new full-buffer deep-equality assertion, not this decoder.

Root and packaged control-plane installs run `node scripts/apply-dependency-patches.mjs` without arguments and require all four patches: Pi AI, coding-agent, codemode and Durable. Missing inputs fail preflight. Execution/native-Claude guests install unmodified locked dependencies without the runner or patch files; loaded-closure checks verify zero patched files. Installation contract: `docs/stack.md`.

File SHA-256 pairs are pinned in `scripts/apply-dependency-patches.mjs`. Regression contracts: `apps/orb-runtime/src/dependency-patch.contract.test.ts`, `apps/orb-runtime/src/dependency-patch-application.test.ts`, `scripts/apply-dependency-patches.test.mjs`. Native behavior/reopen/chart coverage lives under `apps/control-plane/src/adapters/durable/tools/`.

**Decision (2026-10-18):** add input-only `Conversation.submitMany(inputs, context)`. One Session commit validates and looks up all request IDs before table writes, queues each distinct input through the shared admission helper, then applies one idle boundary. Empty and duplicate-only snapshots advance an idle inbox without minting replacement submissions. Pi configures both queue modes as `all`; receipts and entries remain per input. No persisted document or submission schema changes.

Terminal provider and blocking-compaction `model_error` settle failed inputs before a final boundary starts queued input. This drains already-admitted input even during Sleep, when SQL dispatch is gated. Duplicate-only `submitMany` also advances idle queued input without replaying failed input. Writable reopen guards unfinished submissions with the existing recovery budget before an empty snapshot advances the queue; passive reopen stays inert. Regression coverage: `apps/control-plane/src/adapters/durable/{agent-backlog,queued-model-error,operation-identity}.test.ts`.

The 1.4 rebase preserves upstream OpenCode session headers and optional telemetry contracts. Batch admission adds one content-free span; single-submit statuses and per-input identity remain native. Model-error draining uses native continuation helpers; no-model retains upstream `afterFailedRun` (default `keep`).
