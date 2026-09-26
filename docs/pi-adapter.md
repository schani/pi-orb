# Pi integration

How Pi is embedded in the orb runtime and how its persisted session maps to the harness-agnostic history model (`docs/history-replication.md`).

**Thinking policy (revised and implemented 2026-09-14).** Fresh sessions default to `high`, clamped by Pi. Resumed sessions restore native model/thinking settings explicitly, including sessions with no assistant messages. Browser changes are per-session, not global Pi defaults. The former unconditional `high` override (2026-09-08) is superseded because it erased user choices. Luna summary/naming calls retain their separate minimal-reasoning policy. Runtime authority, mutation admission and failure semantics: `docs/agent-settings.md`.

**User-selectable settings (implemented locally 2026-09-14):** `pi/settings-persistence.ts` exclusively reserves the fresh session's path and invokes public SDK empty-file initialization, which owns eager serialization and flushed state. File/directory fsync precedes settings success. This avoids the originally proposed SDK patch while retaining SDK file ownership. `pi/restore-settings.ts` supplies explicit restoration inputs because the SDK's automatic restore skips settings-only sessions. Native setting entries retain history identity; `pi-orb.settings-fallback` custom entries map to visible, non-model-context `agent.settings_fallback` events. `docs/agent-settings.md` records the real-SDK contracts and async setter/guard details.

**Personal instructions (implemented locally, 2026-09-14).** Each boot reads the account-wide snapshot after project-secret bootstrap authentication and fails readiness visibly if unavailable. `orbResourceLoaderOptions` captures its content string and prepends `pi-orb:personal/AGENTS.md` through the SDK's public `agentsFilesOverride`, preserving all native context files and never writing guest/repository files. Empty content omits only the managed source. Reloading resources uses that boot's captured value, not a live account fetch. After successful session/extension initialization, changed applied revision/SHA-256 metadata is appended as `pi-orb:personal-instructions`, then flushed with the existing session durability boundary before readiness. The generic custom-entry mapping preserves it for replication without adding model context or a healthy-state UI row. Initial empty revision 0 and unchanged restarts are silent. Full contract and test-first evidence: `docs/personal-instructions.md`.

**Additional project instructions (implemented locally, 2026-09-15).** The same boot path reads the caller's project-scoped snapshot, failing readiness visibly if unavailable. The loader captures both scopes by value: virtual personal source, untouched native sources, then virtual `pi-orb:project/AGENTS.md` when nonempty. `pi/instructions-adoption.ts` shares the edge-only revision/SHA-256 decision for the separate personal/project custom entry types, flushed before readiness. Default local children already inherit the parent's effective prompt; real subagent E2E pins that a child launched after a save retains the parent's boot snapshot without a fork or new loader hook. Custom replacement/portable prompt modes retain normal extension semantics. Full contract: `docs/project-instructions.md`.

## Embedding decisions

- Pi will be embedded through `@earendil-works/pi-coding-agent` rather than launched through `pi --mode rpc`. Pi packages use [0.87.1](https://github.com/earendil-works/pi/releases/tag/v0.87.1) for GPT-6 Sol support (upgraded 2026-09-23).
- Pi SDK upgrades are routine and may be made whenever needed (user decision 2026-09-08). The pinned version makes validation reproducible; it is not a constraint on new integration designs. Its verified `openai-codex` catalog supplies image-capable `gpt-6-luna`; shared naming/summary inference pins that exact catalog model and preserves only the runtime transport override rather than relabeling the active conversation model. Pi 0.87.1 passes providers a normalized transcript context; the subagent qualification stream reconstructs active tools from its system messages rather than reading the former top-level `tools` field. It also starts an extension-queued wake after the current run's `agent_settled`; the adapter samples aggregate readiness in the following microtask, after Pi starts any deferred continuation, avoiding a false idle edge without retaining claimed child outcomes or using a timer.
- **Production transport evidence (2026-09-16):** persisted `WebSocket closed 1006` errors sampled in two active orbs came from Pi's OpenAI Codex response-stream leg after streaming began, not the browser live socket; each first retry began about two seconds later and continued successfully. The UI preserves both failed and later successful assistant records. Measured rates, exact UTC evidence, transport-policy history, and limits are in `docs/postmortems/2026-09-16-codex-websocket-closures.md`.
- **Codex diagnostic patches (implemented locally 2026-09-26; not deployed):** pinned 0.87.1 `patch-package` patches root and coding-agent-nested `@earendil-works/pi-ai` Codex streams plus coding-agent `ModelRuntime`/provider types. `ModelRuntime` resolves the bearer, calls the provider's `getRequestDiagnostics(apiKey)` hook, and passes only broker generation/expiry as request options. On failure the stream appends sanitized `codex_failure` facts for WebSocket and SSE attempts; it does not alter the existing error message or retry policy. The adapter maps the last `codex_failure` into typed `failure.context` and preserves preexisting native diagnostics losslessly; new Codex diagnostic payloads are whitelisted in native overflow, including an earlier WebSocket fallback leg. A deterministic history-backfill regression showed that stripping new diagnostics from native overflow before extraction erased the typed failure context; extracting first and filtering only the retained native copy preserves both the typed facts and safe overflow. The original `errorMessage` and `provider_transport_failure` remain. No healthy log or new UI suffix. Contract tests cover a real `AgentSession` WS 1011 → auto retry → HTTP 401 with one tool execution and two persisted failures. Clean `npm ci` applied all three patches. Process E2E passed; full `npm test` exited 1 on an unhandled Vitest worker RPC timeout, with no failed assertions. Deployment remains blocked (`docs/testing.md`, `docs/postmortems/2026-09-26-unit-worker-rpc-timeout.md`).
- The orb runtime is a Node.js service that owns the Pi SDK session and exposes a harness-agnostic HTTP/WebSocket protocol.
- The Pi adapter translates Pi-native persisted session entries into the shared history schema.
- A Pi extension may still be useful for Pi-specific instrumentation, but it is not the infrastructure supervisor.
- The orb runtime cannot restart itself reliably from inside its own failure domain. Docker initially, and GCE later, provide process/host supervision.
- If the runtime enters an unrecoverable state, it should exit so its host can restart it.
- User-shell commands call the Pi SDK's `AgentSession.executeBash()` directly. pi-orb does not reproduce the Pi TUI's separate `InteractiveMode` `user_bash` extension-interception layer (decided 2026-08-05).
- The runtime always appends a concise tool-baseline section to Pi's system prompt: Python 3 and rustup are available; no Rust toolchain is installed by default, while explicit installs and repository `rust-toolchain.toml` selections persist in the orb home; `agent-browser` plus Chromium are installed for browser automation, with its basic `open` and snapshot/ref workflow; and `pi-orb orbs [query]` / `pi-orb transcript <orb-id>` expose sibling metadata and replicated prior work. This composes after discovered `APPEND_SYSTEM.md` content and before the optional port-exposure section without replacing Pi's normal resource discovery (tool baseline decided 2026-08-09; inspection commands added 2026-08-27; tool details in `docs/host-provider.md`).
- Completed agent turns are summarized asynchronously by OpenAI's Luna model through a separate inference call. The turn-summary prompt requires one plain-text, past-tense sentence of no more than 15 words (and at most 180 characters), without a preamble or Markdown. The orb runtime resolves request authentication through its existing `ModelRuntime`, while the shared `@pi-orb/luna` package owns Luna model selection, no-tool/minimal-reasoning request policy, response parsing, and typed provider failures for both turn summaries and control-plane orb auto-naming. The adapter captures a bounded turn view after Pi settles, excluding reasoning and raw tool output, broadcasts completion/idle first, and only then queues Luna. The call never touches `AgentSession`, session history, operation outcome, or runtime health; failures are error-logged and produce no notification (decided 2026-08-06). Runtime logs record summary queued, completed (including live-connection count), skipped, and failed boundaries without logging transcript or summary content, so a missing browser notification can be localized to capture, inference, live delivery, permission, or browser construction (observability added 2026-08-07).

**Boot notification extension (implemented 2026-09-05).** Session attachment now invokes the pure `pi/boot-notification.ts` decision for every boot: silent baseline for a fresh conversation, a combined restart/interruption resume, a visible non-triggering crash-loop decline, or an immediately turn-triggering between-turn restart notice. `pi-orb.host-restarted` is a visible Pi custom message; Pi converts it to **user role**, not system role, in model requests. Execution identity determines whether it can say all old processes died (`docs/host-provider.md`). The notification claims the existing operation/turn-start barrier before the SDK call, so concurrent inbox input steers that operation rather than starting a competing one. Full session history retains boot identity and the automatic-turn budget across compaction; notification turns do not get another auto-resume attempt. Details and rationale: `docs/lifecycle.md`.

**Pi 0.87.1 custom-turn correction (implemented 2026-09-23).** An idle `sendCustomMessage(..., { triggerTurn: true })` originally bypassed the prompt/tool reconciliation used by `AgentSession.prompt()`. A restart notice could therefore infer with the previous transcript-backed instructions even though the current resource loader had loaded new instructions. Upstream [issue #5581](https://github.com/earendil-works/pi/issues/5581) classifies this as a bug: custom messages bypass user-input processing, not agent-run preparation. Until an upstream release contains the fix, the exact Pi 0.87.1 dependency is patched through `patch-package`. Normal prompts and idle or deferred custom-triggered turns now share model/auth/compaction, `before_agent_start`, current prompt and active-tool preparation; in-run steering/follow-up delivery is unchanged. Prompt and tool changes use Pi's canonical transcript deltas, exactly like ordinary prompts. Providers without mid-conversation system support collapse those deltas; supporting providers may retain historical leading instructions plus framed updates. Tests fold that protocol representation and assert the effective state rather than requiring historical strings to disappear. Custom preparation is active and abortable before the core agent run: auth receives the preparation signal, cooperative hooks see it as `ctx.signal`, checkpoints suppress later work, and idle waits for preparation to settle. A hook that ignores cancellation still delays abort until it returns. The original custom message remains the durable model input with its type, visibility and details; hook injections remain custom messages, and no synthetic user entry is added. The rejected `context_with_system` shim corrected only one request and could not restore tool or hook semantics. Root, control-plane-image, runtime-image and native-image installs all apply the version-specific patch after locked installation and fail if it no longer applies. The isolated subagent characterization intentionally retains its separately installed unmodified SDK; runtime-mode tests import the patched root SDK. Evidence and qualification: `docs/postmortems/2026-09-23-pi-system-history-replication.md`.

**Sleep-wake boot integration (decided 2026-09-17; implementation in progress).** Before session attachment, the runtime reads only a FIFO-head sleep context and feeds it to the same boot decision. A normal wake persists one visible `pi-orb.sleep-wake` event containing generic restart/interruption wording, sleep context, boot identity, and inbox IDs before inference. It is not a human message and does not reset crash-loop/resume authority. Read failure fails readiness closed; the existing guard may persist a visible non-triggering decline. Local session identity deduplicates append-before-replication crashes, while replication performs the sole inbox acknowledgement. Full contract and tests: `docs/orb-sleep.md`.

## First-party Pi extensions (implemented 2026-09-08)

The user approved a pi-orb-owned MCP extension and requested a principled mechanism for subsequent first-party extensions, without a new plugin framework. MCP scope, implementation and client-library findings are in `docs/mcp.md`.

Use **Pi's existing named inline extension factories**, registered through our existing `DefaultResourceLoader`. Layout:

```text
apps/orb-runtime/src/pi/extensions/
  index.ts        # explicit composition list, not filesystem discovery
  mcp.ts          # Pi tool/lifecycle adapter
```

`createOrbExtensions(deps): InlineExtension[]` returns named factories, for example `{ name: "pi-orb:mcp", factory: createMcpExtension(deps.mcp) }`. Pass the array to `DefaultResourceLoader.extensionFactories`, preserving normal user/project resource discovery. These are ordinary statically imported TypeScript modules shipped with the runtime, not separately installed packages or files copied into persistent guest settings. Adding a first-party extension means adding its module and one entry to this list. No registry database, manifest schema, dependency container, version negotiation, extension settings UI or hot reload layer is needed.

Factories close over only the services they need; do not expose the whole runtime or a generic service locator. Keep Pi-specific tool schemas/content/event translation in the extension. MCP connection ownership and typed errors belong in the runtime's normal domain modules with transport adapters beside them, so DST exercises those services without mocking Pi itself. Use real Pi contract tests to verify the thin extension and its loading, not a second custom extension API.

Register tools synchronously in the factory; do not open connections or start timers there. Bind the session's extensions explicitly with `bindExtensions` before admitting input; `session_start` initializes session-local state and `session_shutdown` closes it. Lazy MCP I/O starts only on a tool call. The host owns bounded, awaited shutdown through the Pi lifecycle API rather than assuming synchronous `dispose()` awaits asynchronous cleanup. The runtime awaits `extensionRunner.emit({type: "session_shutdown", reason: "quit"})`, closes MCP ownership idempotently, then calls `dispose()` before closing Fastify. SDK network operations have deadlines; supervisor termination remains the final bound for misbehaving discovered extensions. All entry points into cleanup must be idempotent, with no parallel independent connection owner.

MCP inventory is appended by the resource loader, not only a `before_agent_start` handler: custom messages queued inside an existing run do not start another prepared run or hook invocation. Configuration-adoption edges and extension handler errors are retained in session history (`docs/mcp.md`).

Use namespaced platform extension/tool names and an explicit collision policy: a first-party tool must not silently replace a discovered user/project tool or vice versa. Report first-party load/bind failure as a visible runtime initialization failure, not a silently absent capability; an upstream MCP connection failure remains a connection-level error and does not fail the whole runtime. Errors must be sanitized and durably observable. No TUI context is fabricated: first-party extensions use ordinary tool results and existing product status/history paths. Contract tests pin additive discovery, exactly-once startup binding, tool-name collision handling, shutdown ordering, and visible failure behavior.

## Local subagents: fork-first integration (2026-09-14; under validation)

The complete design, evidence limits and DST-first acceptance plan are now in `docs/subagents.md`; implementation steps live in `TODO.md`, and resolved product choices in `docs/open-questions.md` (62–64). The local implementation loads a pinned 21.7.0 fork, with runtime-owned activity and cancellation; it is not deployed. The original proposal's no-resume restriction was rejected: normal shared-checkout editing and agent-facing package tools, no user-facing child transcripts or child-file cloud replication, cooperative whole-operation cancellation and interrupted reporting without automatic child replay.

The discussion in orb `b18fc524-632d-42cd-ab90-8b2ac55de80d` favored `@gotgenes/pi-subagents`. Its recorded experiment against gotgenes 21.4.2 / Pi 0.85.1 found public-API aggregate busy reporting feasible, but cancellation during startup could still execute child work, drain APIs could finish before cleanup, and cancelled-child notifications could restart the parent. Those are findings from that pinned experiment, not a fresh audit of upstream. The experiment is now recovered in `scripts/subagent-liveness/`; fresh runtime, fork and browser evidence is recorded in `docs/subagents.md`.

**Decision:** maintain a narrow fork of `gotgenes/pi-packages`, prove the changes in pi-orb, then propose them upstream. This replaces the earlier recommendation to submit upstream first. The five commits are published at `schani/pi-packages` on `pi-orb-integration`, pinned at `6d333b00670d778812b79bce2dd2e1db3f5f9692` (2026-09-14). pi-orb retains the immutable vendored artifact and a recipe that builds that fork commit, not duplicate patch exports. The user created the fork after the orb integration's fork-creation request returned HTTP 403. Keep startup cancellation correctness, actual-delivery wake control, explicit child extension factories, embedded checkout cwd and opt-in coherent child loading in the fork; retain pi-orb operation ownership, aggregate activity, history and UI integration in our adapter. Pin an immutable fork build rather than a moving branch, preserve upstream licensing, and keep changes separately reviewable. No private-state monkey-patching or compatibility layer is needed.

**Minimal fork scope (proposal refined 2026-09-08):** two behavior changes, not a lifecycle redesign. First, latch and honor cancellation across asynchronous startup boundaries, including an already-aborted signal at binding, and never prompt a cancelled run; release acquired resources normally. Second, add an optional host predicate at the actual automatic parent-wake boundary, evaluated for both immediate and previously queued delivery, with existing behavior as the default. Suppression must not skip terminal outcome persistence. The host predicate uses pi-orb-owned operation correlation and cancellation state; operation IDs and a new notification subsystem need not become extension concepts. The installed fork exposes `shouldWake({id})` at actual delivery, including withheld notifications. Keep the tested admission-to-terminal activity hold in our adapter, so correcting `hasRunning()`/`waitForAll()` semantics or introducing a public `cancelling` state is not required for initial integration. Those APIs must not be used as proof of drained execution. Explicit resume is preserved and contract-tested with fresh cancellation ownership and operation identity; terminal callbacks are pinned by real-SDK contracts to follow execution/cleanup before they release the host hold. This narrows the earlier three-repair recommendation: premature status/drain reporting remains a known package limitation rather than requiring an unrelated public lifecycle change.

Proof means correctness regressions for zero child execution after startup cancellation, host draining through actual cleanup, and no new parent inference after whole-operation abort, followed by runtime DST/E2E and real use. Persist terminal outcomes even when wakes are suppressed; cancellation must remain visibly active until execution drains. In-process tools that ignore cancellation cannot be declared stopped merely because an abort was requested. Upstream bug fixes and the more experimental host wake-control API can be proposed separately once supported by evidence; upstream acceptance is not a prerequisite for using the validated fork.

## In-orb spawning (decided and implemented 2026-09-08)

The runtime environment prompt also documents `pi-orb spawn --prompt ...` / `--prompt-file <path|->`, URL/JSON output, fresh default-branch checkouts, independent lifetime, explicit same-ID recovery after unknown acceptance, and no recursive delegation without user direction. The installed shim calls a narrow authenticated control-plane API; normal lifecycle/inbox delivery runs the new orb's prompt, with no new Pi SDK path. Contract and validation: `docs/orb-spawning.md`.

## In-orb orb inspection (decided and implemented 2026-08-27)

The `/usr/local/bin/pi-orb` dispatcher gained three command families on 2026-08-27: workload identity (`id-token`), sibling discovery (`orbs`), and replicated conversation reading (`transcript`). The last two are small enough to document directly in the always-present environment prompt: exact syntax, a warning that transcripts can be very long, `--json`, and replica-lag semantics fit in a few sentences and are broadly useful when an agent is asked to continue or compare work. A third baked skill was rejected as unnecessary progressive disclosure; unlike cloud federation and boot-hook authoring, there is no multi-page procedure to load.

These inspection commands are read-only and talk to the control plane's runtime-only routes with the same provider-injected URL and incarnation bearer used by the broker. Human-readable transcript output renders normalized history and deliberately omits duplicated `overflow.native`; `--json` preserves the replica's native overflow subject only to the system-state confidentiality exception below. The process provider prepends the repository's `apps/orb-runtime/docker` directory to `PATH`, while the image installs the same shim at `/usr/local/bin`, so the prompt tells the truth on both supported compositions.

**Self-archival added 2026-09-05:** plain `pi-orb archive` is a fourth command family, restricted to the authenticated caller. The environment prompt adds only: use it when the user requested archival of this orb, and push/export needed files before irreversible deletion. The CLI returns at durable acceptance so the tool call can finish and the agent can produce its final reply before archival seals history; it does not add a Pi tool, extension, or skill. Full lifecycle and authorization contract: `docs/orb-archival.md`.

## In-orb agent skills (decided and implemented 2026-08-22)

Some capabilities of an orb are undiscoverable from inside it. Workload identity is the first: nothing in the user's checkout mentions `pi-orb id-token`, so an agent asked for "deploy this" or "read that bucket" reaches for a stored key it will never find. The mechanism chosen to teach it is a **Pi skill baked into the runtime image**.

- The skills live in the repository at `apps/orb-runtime/skills/<name>/SKILL.md` (Agent Skills format: YAML `name`/`description` frontmatter plus markdown body) and the Dockerfile copies the directory to `/opt/pi-orb/skills`.
- **Provider-owned launch path (decided 2026-09-07).** Every host launch sets `PI_ORB_SKILLS_DIR`: image-backed providers use `/opt/pi-orb/skills`; the process provider uses the repository source directory selected by control-plane composition. The runtime passes that exact path through Pi options to `additionalSkillPaths`. A configured missing directory fails session initialization instead of silently dropping platform skills. Tests may explicitly pass `null` to isolate the loader. The option remains additive to the SDK's user (`<agentDir>/skills`) and project (`.pi/skills`) discovery.
- `/opt/pi-orb/skills`, deliberately **not** anything under `/workspace`. The orb's persistent volume mounts over `/workspace`, so image content placed there is shadowed at runtime.
- **Discovery rides entirely on the `description` field.** Pi puts only each skill's name, description and path in the system prompt and expects the model to `read` the body when a task matches; the `/skill:<name>` slash command that would force it is interactive-mode-only and pi-orb does not run Pi's interactive mode. A description that does not name the situations it applies to is therefore a skill that never loads.
- The first skill is `cloud-identity` (`docs/workload-identity.md`, `docs/workload-identity-recipes.md`). Because it instructs the agent to point a Google external-account credential file at a *reviewed* helper, the Dockerfile also bakes `scripts/pi-orb-gcp-identity` at `/usr/local/bin/pi-orb-gcp-identity`; without it the agent's only option is writing its own credential helper, which is what "repository setup must not download an unreviewed credential helper" exists to prevent.
- The second is `boot-hooks` (added 2026-08-26, `docs/orb-setup-hook.md`): the authoring guide for `.agents/setup` and `.agents/resume`. Same reason as the first — the always-appended tool baseline states only that the convention exists, and an agent asked to *write* a hook needs the split, the budgets, the idempotency pattern, and the log and status paths, which is body-sized content most turns never need. `cloud-identity` emits both hook files and defers to it.
- Pinned by `apps/orb-runtime/src/pi/resource-loader.contract.test.ts` (an explicit provider path discovers bundled skills through `getSkills()` against the pinned SDK, the loader otherwise matches the control loader, and a missing configured directory fails), `apps/orb-runtime/src/pi/skills.test.ts` (frontmatter parses; every `/usr/local/bin` path a skill names is installed by the image; and the hook paths, budgets, and scrubbed variables the skills quote are read out of `apps/orb-runtime/src/hooks/runner.ts` at test time so a skill cannot drift from the runner), and `apps/orb-runtime/src/dockerfile.contract.test.ts` (both COPY lines).

Rejected alternatives:

- **Runtime probing for image and source directories.** Install layout belongs to the host provider. Probing can silently choose the wrong install; the provider therefore supplies one required path.
- **Another system-prompt fragment** beside `environment-prompt.ts` and the port-exposure section. Those are short and apply to every turn; this content is multiple pages of provider-specific recipe that most turns never need, and a system prompt pays for its whole length on every request. Progressive disclosure — description always resident, body loaded on demand — is the right shape for it.
- **Writing the skill into the persistent workspace at boot** (for example `/workspace/repo/.pi/skills/`). It would be agent-writable and user-committable state, so a corrupted or stale copy would silently outlive an image upgrade, and ownership of the file would be ambiguous between pi-orb and the user's repository.
- **Putting it in the repository's `AGENTS.md`.** That file is the *user's* project instructions; pi-orb appending platform documentation to it muddies whose voice it is and would follow the repository out of the orb.

## User shell API and persistence

The pinned Pi SDK 0.87.1 exposes the required public API:

```ts
session.executeBash(command, onChunk, { excludeFromContext }): Promise<BashResult>;
session.abortBash(): void;
session.isBashRunning: boolean;
```

`executeBash` runs in the session cwd using Pi's configured shell, streams sanitized output through `onChunk`, supports cancellation, and truncates retained output using Pi's bash limits. Normal completion, including cancellation and nonzero exit, appends a native `bashExecution` message to agent state and the persistent session. `excludeFromContext` changes only later model-context conversion: ordinary shell results are transformed into a user-context message, while excluded-shell results are skipped by `convertToLlm`. Both modes therefore remain in Pi history and replicate to PostgreSQL; exclusion does not mean ephemeral or absent from the history log.

Abort dispatch depends on the active operation kind: agent work calls `session.abort()`, while shell work calls `session.abortBash()`. A nonzero command exit is a normal `BashResult`, not an SDK failure.

`executeBash` appends its history entry directly and does not produce the prompt path's ordinary `message_end`/`agent_settled` persistence boundaries. After it resolves, the adapter must explicitly scan/publish the newly appended entry before broadcasting `operation_finished`. A cancelled result follows the same persistence ordering. If the SDK call rejects before producing a `BashResult`, the adapter reports a failed operation and must not invent a history record.

## Operation identity across concurrent submitters (decided and implemented 2026-08-11)

Two ingress paths can hand Pi a new turn: the live WebSocket `message` action and the control plane's inbox delivery (`docs/runtime-protocol.md`). Each is answered with an operation ID before the turn exists, and everything afterwards — `operation_started`/`status`/`operation_finished`, the browser's abort, the Luna turn notification, and the delivery note the control plane persists for the batch — is correlated by that ID. The contract is therefore: **the operation ID promised to a submitter is the ID the turn its message started actually runs under, and a message that joins a running turn is answered with that turn's ID.**

The first implementation broke that contract because it deferred the claim: each submitter wrote its ID into one `pendingOperationId` slot and Pi's `agent_start` consumed whatever was there. Both submitters gate on `activity`, which only became `busy` in that same `agent_start` handler, so during the window between accepting a submission and Pi announcing its turn the runtime still reported itself idle and a second submitter was admitted. Whichever wrote last won the slot, and the loser's promised ID named no operation at all — its abort was rejected as `stale_operation`, its status frames referred to somebody else's turn, and the control plane recorded an operation ID for the batch that nothing ever ran under.

The fix is to claim the operation synchronously with acceptance, exactly as a shell submission already did: `submitMessage` and a `turn`-classified delivery set the operation ID, kind, summary start index, and `busy` activity, and broadcast `operation_started` before returning to their caller. `agent_start` no longer allocates for a claimed operation — it only confirms it. That also stops Pi's in-run continuations (auto-retry, auto-compaction re-enter `runAgentLoop` and re-emit `agent_start`) from silently re-broadcasting a *new* random operation ID mid-turn. Only a turn nobody submitted — the boot interrupted-turn resume (`docs/lifecycle.md`) — allocates an ID in the event handler.

Claiming eagerly opens the mirror-image window, and it must be closed too: the runtime is `busy` from acceptance, but Pi marks itself streaming only when it begins the turn. `AgentSession.sendUserMessage` reaches `_runAgentPrompt` behind an async prologue (`prompt()` runs extension `input` hooks, the auth check and the compaction check first), while `sendCustomMessage` has no prologue and flips streaming synchronously. A delivery classified `steer` inside that window would be handed to a Pi that still looks idle to itself, which starts a second, competing turn and makes Pi refuse the loser with "Agent is already processing" — an accepted submission silently lost. Deliveries therefore wait for the in-flight submission to reach `agent_start` (or fail) before sampling activity. The live path needs no such wait: its gate is synchronous and rejects the second submitter with `busy`.

A submission Pi refuses releases the operation it claimed and reports `operation_finished` with outcome `failed`, so a rejected turn cannot leave the runtime wedged in `busy` and is visible to the browser instead of silent.

`apps/orb-runtime/src/pi/operation-correlation.dst.test.ts` pins all of this under `determined` schedules in both submission orders, driving a fake `AgentSession` that reproduces the SDK ordering above (`PiSession`/`PiSessionManager` narrow the SDK objects to the calls the adapter makes so it can be substituted). Reverting the claim to the deferred slot fails both scenarios at the first iteration.

## Pi history behavior

Pi session files are append-only JSONL trees. Each entry has an `id` and `parentId`; the session header is separate.

Pi compaction does not delete earlier entries. It appends a `compaction` entry containing a summary and information about the retained context boundary.

The embedded runtime can access complete persisted history through the retained `SessionManager`:

```ts
sessionManager.getHeader(); // session metadata
sessionManager.getEntries(); // all entries, including pre-compaction
sessionManager.getTree(); // full tree, including abandoned branches
```

The following APIs are model-context views and must not be used as the replication source:

```ts
sessionManager.buildContextEntries();
sessionManager.buildSessionContext();
```

They intentionally apply compaction and active-branch selection. Similarly, model-facing `session.messages` is not the lossless full session log.

Therefore:

- the Pi runtime/SDK can read and replicate full pre-compaction history;
- the LLM itself does not automatically receive that full history after compaction;
- a future history-query tool could let the model explicitly retrieve older records if desired.

### Session metadata

The Pi `SessionHeader` is not a `HistoryRecord`. It has no entry parent and does not participate in Pi's entry tree. Map it to `HarnessSessionMetadata`:

```ts
{
  id: header.id,
  timestamp: header.timestamp,
  overflow: { native: header }
}
```

Store its complete JSON in `orbs.harness_session_header` and its ID in `harness_session_id`. It never advances the history cursor and never becomes an invented root parent. Repeated pulls require JSON-semantic equality with the stored header.

### Entry mapping

For every entry, preserve `entry.id`, `entry.parentId`, and `entry.timestamp` exactly and put the complete JSON-safe original in `overflow.native`, except for Pi system state. Pi 0.86+ persists full prompt sections and tool declarations in `message` entries with role `system`, and can repeat the complete checkpoint at `compaction.systemMessage`. Those values are execution configuration, not conversation history: the authoritative local Pi JSONL keeps them, while the history adapter retains only the system role and nested message timestamp in native overflow. The record itself and a compaction's ordinary fields remain present, preserving cursor identity and ancestry. Incident and first release failure: `docs/postmortems/2026-09-23-pi-system-history-replication.md`.

**Typed fields instead of native reads (decided and implemented 2026-09-16).** Every field a client needs is derived here, once, into normalized record fields; no code outside this adapter reads `overflow.native`. A second client (a native macOS app) would otherwise have to copy the web UI's coupling to undocumented Pi-native JSON shapes. Except for the narrow system-state projection above, `overflow` is unchanged and stays lossless — the typed fields duplicate it, as normalized fields always have. Transcripts persisted before the fields existed are backfilled from the native blob by `022_typed_history_fields.sql`; there is no dual read in TypeScript.

**Schema evolution (decided 2026-09-17; supersedes the 2026-09-16 manual-stop rule).** Supported old runtimes must be able to continue temporarily across migrations. A changed write contract must either remain compatible through optional/defaulted fields with behavior-preserving handling, or reject incompatible writes at the boundary with a typed, durable, user-visible outcome. The protection and migration/backfill form one atomic release boundary. `inboxMessageIds` is behavior-sensitive because replication uses it for delivery correctness; treating every promoted field as optional presentation data is unsafe. No generic framework, dual-write scheme, or concrete guard is selected or implemented.

Migration 022 missed the former stop-before-backfill instruction while one old runtime kept writing. Five later `ToolResultBlock.patch` projections are absent, but `patch` is optional in `packages/protocol/src/history.ts` and each raw diff remains in `overflow.native.message.details.patch`. `ToolActivity.tsx` uses it only for `+`/`-` counts and falls back to call status when absent. Thus the observed impact is five missing display statistics, not broken conversation, native-data loss, or SQL schema corruption. Existing-row repair is not planned; the optional statistics are accepted and raw diffs remain retained. Incident: `docs/postmortems/2026-09-17-typed-history-runtime-fence.md`; release contract: `docs/deployment.md`.

| Pi persisted entry         | Normalized record                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `message` / system         | Hidden `EventRecord`, `eventType: "pi.message.system"`; identity-only native projection, with prompt sections and tool declarations retained only in local Pi JSONL. |
| `message` / user           | `MessageRecord`, role `user`; text/image blocks.                                                                                |
| `message` / assistant      | `MessageRecord`, role `assistant`; text, thinking→reasoning, and tool-call blocks; provider/model, usage, stop reason; a failed stop reason with an error message nonempty under ECMAScript `trim()` also yields `failure` with the original message, diagnostic types, and optional allowlisted Codex `context` (`docs/runtime-protocol.md`). |
| `message` / tool result    | `MessageRecord`, role `tool`; one typed `tool_result` block containing call ID, nested text/image content, error flag, and `details.patch` as `patch`. |
| `message` / bash execution | `EventRecord`, `eventType: "pi.bash_execution"`; normalized textual content where useful, plus `shell` with command, output, exit code, cancellation, truncation, and context exclusion. |
| `thinking_level_change`    | `EventRecord`, `eventType: "pi.thinking_level_change"`.                                                                         |
| `model_change`             | `EventRecord`, `eventType: "pi.model_change"`.                                                                                  |
| `compaction`               | `CompactionRecord`; summary as a text block, with first-kept ID/token/details retained natively.                                |
| `branch_summary`           | `EventRecord`, `eventType: "pi.branch_summary"`, with summary text content.                                                     |
| `custom`                   | `EventRecord`, `eventType: "pi.custom"`.                                                                                        |
| `custom_message` / `pi-orb.user-message` (send-anytime envelope) | `MessageRecord`, role `user`; text/image blocks, plus `inboxMessageIds` with every durable client message ID in the squashed delivery batch, in order. |
| `custom_message` / `pi-orb.system-message` or `pi-orb.sleep-wake` | Visible `EventRecord`, `eventType: "pi.custom_message"`; content, custom metadata, and `inboxMessageIds` from native `details.messageIds`. Never a human message. |
| other `custom_message`     | `EventRecord`, `eventType: "pi.custom_message"`, with text/image content and `custom` carrying `customType` and `display`; the subagent extension's three receipt types also yield `subagent`. |
| `label`                    | `EventRecord`, `eventType: "pi.label"`.                                                                                         |
| `session_info`             | `EventRecord`, `eventType: "pi.session_info"`.                                                                                  |
| unknown future entry       | `EventRecord`, `eventType: "pi.<native-type>"`.                                                                                 |

Content conversions are direct and lossless through native overflow:

- Pi text → `ContentBlock { type: "text" }`;
- Pi image `mimeType`/base64 data → normalized `mediaType`/data;
- Pi thinking text → `ContentBlock { type: "reasoning" }`;
- Pi tool call ID/name/arguments → typed `tool_call`;
- Pi tool-result call ID/content/error → typed `tool_result`;
- assistant provider/model/usage/cost/stop reason → normalized model, usage, and `finishReason` fields;
- `subagent-notification` / `subagent-update` / `subagent-workspace-notice` details → `subagent` with kind `notification` / `update` / `workspace_notice` and the receipt's description, status, message, notice, error, result preview, duration, and child ID.

An unknown message role maps to a generic event rather than inventing a shared role. System is the explicit confidentiality case above, not an unknown-role fallback. A mapping/validation failure returns a typed history error and makes `pullHistory` fail; it must never silently omit an entry.

### Completeness and cursor continuity

`SessionManager.getEntries()` is the sole Pi replication source. Pi appends user/tool/assistant messages on awaited `message_end`; streaming `message_update` state is not present there and is never synthesized into persistence. Pi's `AgentSession` notifies SDK subscribers of `message_end` immediately before it appends the ordinary message entry, and its `entry_appended` event covers extension-created custom entries rather than ordinary messages. The adapter therefore schedules a session-entry scan after each `message_end`, deduplicates by native entry ID, and performs a final synchronous scan at `agent_settled` before emitting `operation_finished` and clearing transient output. Adapter tests reproduce this exact notify-then-append ordering; mapping-only tests are insufficient to verify live-history delivery. **Atomic output handoff (2026-09-12):** the same native message object passes from `message_end` into the persisted entry. A weak map binds it to only that message sequence's streamed block IDs; publication consumes that identity association and sends the IDs in the required `history.record.retiredBlockIds` array. The normalized record remains unchanged and does not persist transient IDs. A real SessionManager contract test pins object identity even for messages with identical text. Snapshot reads flush the publisher synchronously before returning history for pairing with reconnect live state. Mapping failure cannot retire output without its committed record. The former separate retirement event is removed (`docs/runtime-protocol.md`).

Every returned persisted entry maps one-to-one to exactly one record and advances the native-ID cursor exactly once. This includes labels and hidden custom entries. Unknown future types still become generic events, preserving cursor continuity across Pi upgrades.

The `pi-orb.user-message` special case is intentionally semantic rather than a presentation-only exception. Pi converts custom messages to user-role model input, so one native custom entry can carry the durable identities of a squashed FIFO batch while remaining the actual user message. Using a hidden marker followed by an ordinary user entry was rejected because it doubles records and creates a crash gap between the marker and message. Existing ordinary Pi user records remain mapped unchanged.

### Initial UI visibility

Visibility is presentation policy, not persistence filtering:

- show user and assistant messages normally; show tool names and states while keeping tool inputs and outputs collapsed by default;
- show compaction as a collapsed boundary;
- show `pi.custom_message` only when `custom.display` is true;
- show a record's `shell` block as preformatted command/output; show exit, cancellation, and truncation status, and mark excluded-shell entries as excluded from model context;
- hide model/thinking changes, branch summaries, labels, session-info entries, ordinary custom entries, and unknown events by default.

The UI still traverses hidden records when reconstructing parent chains. Hidden records remain available for diagnostics and future richer renderers.

## Rejected: Pi over tmux or subprocess RPC

Rejected for the first slice:

- tmux as UI/session transport;
- running a remote Pi TUI;
- running `pi --mode rpc` behind a gateway child process.

Decision: embed Pi through the SDK in the orb runtime and build a web UI.
