# Pi integration

How Pi is embedded in the orb runtime and how its persisted session maps to the harness-agnostic history model (`docs/history-replication.md`).

## Embedding decisions

- Pi will be embedded through `@earendil-works/pi-coding-agent` rather than launched through `pi --mode rpc`. Pi packages use [0.85.1](https://github.com/earendil-works/pi/releases/tag/v0.85.1) for GPT-6 Astra support (decided 2026-09-05).
- The orb runtime is a Node.js service that owns the Pi SDK session and exposes a harness-agnostic HTTP/WebSocket protocol.
- The Pi adapter translates Pi-native persisted session entries into the shared history schema.
- A Pi extension may still be useful for Pi-specific instrumentation, but it is not the infrastructure supervisor.
- The orb runtime cannot restart itself reliably from inside its own failure domain. Docker initially, and GCE later, provide process/host supervision.
- If the runtime enters an unrecoverable state, it should exit so its host can restart it.
- User-shell commands call the Pi SDK's `AgentSession.executeBash()` directly. pi-orb does not reproduce the Pi TUI's separate `InteractiveMode` `user_bash` extension-interception layer (decided 2026-08-05).
- The runtime always appends a concise tool-baseline section to Pi's system prompt: Python 3 and Rust are available; Rust uses a persistent rustup installation with stable as the default and supports repository `rust-toolchain.toml` selection; `agent-browser` plus Chromium are installed for browser automation, with its basic `open` and snapshot/ref workflow; and `pi-orb orbs [query]` / `pi-orb transcript <orb-id>` expose sibling metadata and replicated prior work. This composes after discovered `APPEND_SYSTEM.md` content and before the optional port-exposure section without replacing Pi's normal resource discovery (tool baseline decided 2026-08-09; inspection commands added 2026-08-27; tool details in `docs/host-provider.md`).
- Completed agent turns are summarized asynchronously by OpenAI's Luna model through a separate inference call. The turn-summary prompt requires one plain-text, past-tense sentence of no more than 15 words (and at most 180 characters), without a preamble or Markdown. The orb runtime resolves request authentication through its existing `ModelRuntime`, while the shared `@pi-orb/luna` package owns Luna model selection, no-tool/minimal-reasoning request policy, response parsing, and typed provider failures for both turn summaries and control-plane orb auto-naming. The adapter captures a bounded turn view after Pi settles, excluding reasoning and raw tool output, broadcasts completion/idle first, and only then queues Luna. The call never touches `AgentSession`, session history, operation outcome, or runtime health; failures are error-logged and produce no notification (decided 2026-08-06). Runtime logs record summary queued, completed (including live-connection count), skipped, and failed boundaries without logging transcript or summary content, so a missing browser notification can be localized to capture, inference, live delivery, permission, or browser construction (observability added 2026-08-07).

## In-orb orb inspection (decided and implemented 2026-08-27)

The `/usr/local/bin/pi-orb` dispatcher gained three command families on 2026-08-27: workload identity (`id-token`), sibling discovery (`orbs`), and replicated conversation reading (`transcript`). The last two are small enough to document directly in the always-present environment prompt: exact syntax, a warning that transcripts can be very long, `--json`, and replica-lag semantics fit in a few sentences and are broadly useful when an agent is asked to continue or compare work. A third baked skill was rejected as unnecessary progressive disclosure; unlike cloud federation and boot-hook authoring, there is no multi-page procedure to load.

These inspection commands are read-only and talk to the control plane's runtime-only routes with the same provider-injected URL and incarnation bearer used by the broker. Human-readable transcript output renders normalized history and deliberately omits duplicated `overflow.native`; the lossless response remains available with `--json`. The process provider prepends the repository's `apps/orb-runtime/docker` directory to `PATH`, while the image installs the same shim at `/usr/local/bin`, so the prompt tells the truth on both supported compositions.

**Self-archival added 2026-09-05:** plain `pi-orb archive` is a fourth command family, restricted to the authenticated caller. The environment prompt adds only: use it when the user requested archival of this orb, and push/export needed files before irreversible deletion. The CLI returns at durable acceptance so the tool call can finish and the agent can produce its final reply before archival seals history; it does not add a Pi tool, extension, or skill. Full lifecycle and authorization contract: `docs/orb-archival.md`.

## In-orb agent skills (decided and implemented 2026-08-22)

Some capabilities of an orb are undiscoverable from inside it. Workload identity is the first: nothing in the user's checkout mentions `pi-orb id-token`, so an agent asked for "deploy this" or "read that bucket" reaches for a stored key it will never find. The mechanism chosen to teach it is a **Pi skill baked into the runtime image**.

- The skills live in the repository at `apps/orb-runtime/skills/<name>/SKILL.md` (Agent Skills format: YAML `name`/`description` frontmatter plus markdown body) and the Dockerfile copies the directory to `/opt/pi-orb/skills`.
- `apps/orb-runtime/src/pi/resource-loader.ts` passes that path as `additionalSkillPaths` (`BAKED_SKILLS_DIR`). The option is additive: the SDK's own user (`<agentDir>/skills`) and project (`.pi/skills`) discovery is untouched, so a user's own skills still load.
- `/opt/pi-orb/skills`, deliberately **not** anything under `/workspace`. The orb's persistent volume mounts over `/workspace`, so image content placed there is shadowed at runtime.
- The loader filters the path with an existence check before passing it. The SDK tolerates a missing additional skill path — `loadSkills` warns and skips rather than throwing — but `DefaultResourceLoader.reload()` then records a `type: "error"` skill diagnostic for it, and on the process host provider (no image, `docs/host-provider.md`) the directory is legitimately absent. Filtering keeps that case silent rather than permanently "erroring".
- **Discovery rides entirely on the `description` field.** Pi puts only each skill's name, description and path in the system prompt and expects the model to `read` the body when a task matches; the `/skill:<name>` slash command that would force it is interactive-mode-only and pi-orb does not run Pi's interactive mode. A description that does not name the situations it applies to is therefore a skill that never loads.
- The first skill is `cloud-identity` (`docs/workload-identity.md`, `docs/workload-identity-recipes.md`). Because it instructs the agent to point a Google external-account credential file at a *reviewed* helper, the Dockerfile also bakes `scripts/pi-orb-gcp-identity` at `/usr/local/bin/pi-orb-gcp-identity`; without it the agent's only option is writing its own credential helper, which is what "repository setup must not download an unreviewed credential helper" exists to prevent.
- The second is `boot-hooks` (added 2026-08-26, `docs/orb-setup-hook.md`): the authoring guide for `.agents/setup` and `.agents/resume`. Same reason as the first — the always-appended tool baseline states only that the convention exists, and an agent asked to *write* a hook needs the split, the budgets, the idempotency pattern, and the log and status paths, which is body-sized content most turns never need. `cloud-identity` emits both hook files and defers to it.
- Pinned by `apps/orb-runtime/src/pi/resource-loader.contract.test.ts` (both skills are discovered through `getSkills()` against the pinned SDK, with the loader otherwise byte-identical to the control loader, and an absent directory yields no diagnostics), `apps/orb-runtime/src/pi/skills.test.ts` (frontmatter parses; every `/usr/local/bin` path a skill names is installed by the image; and the hook paths, budgets, and scrubbed variables the skills quote are read out of `apps/orb-runtime/src/hooks/runner.ts` at test time so a skill cannot drift from the runner), and `apps/orb-runtime/src/dockerfile.contract.test.ts` (both COPY lines).

Rejected alternatives:

- **Another system-prompt fragment** beside `environment-prompt.ts` and the port-exposure section. Those are short and apply to every turn; this content is multiple pages of provider-specific recipe that most turns never need, and a system prompt pays for its whole length on every request. Progressive disclosure — description always resident, body loaded on demand — is the right shape for it.
- **Writing the skill into the persistent workspace at boot** (for example `/workspace/repo/.pi/skills/`). It would be agent-writable and user-committable state, so a corrupted or stale copy would silently outlive an image upgrade, and ownership of the file would be ambiguous between pi-orb and the user's repository.
- **Putting it in the repository's `AGENTS.md`.** That file is the *user's* project instructions; pi-orb appending platform documentation to it muddies whose voice it is and would follow the repository out of the orb.

## User shell API and persistence

The pinned Pi SDK 0.85.1 exposes the required public API:

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

For every entry, preserve `entry.id`, `entry.parentId`, and `entry.timestamp` exactly and put the complete JSON-safe original in `overflow.native`. Normalized fields intentionally duplicate native data.

| Pi persisted entry         | Normalized record                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `message` / user           | `MessageRecord`, role `user`; text/image blocks.                                                                                |
| `message` / assistant      | `MessageRecord`, role `assistant`; text, thinking→reasoning, and tool-call blocks; provider/model, usage, stop reason.          |
| `message` / tool result    | `MessageRecord`, role `tool`; one typed `tool_result` block containing call ID, nested text/image content, and error flag.      |
| `message` / bash execution | `EventRecord`, `eventType: "pi.bash_execution"`; normalized textual content where useful.                                       |
| `thinking_level_change`    | `EventRecord`, `eventType: "pi.thinking_level_change"`.                                                                         |
| `model_change`             | `EventRecord`, `eventType: "pi.model_change"`.                                                                                  |
| `compaction`               | `CompactionRecord`; summary as a text block, with first-kept ID/token/details retained natively.                                |
| `branch_summary`           | `EventRecord`, `eventType: "pi.branch_summary"`, with summary text content.                                                     |
| `custom`                   | `EventRecord`, `eventType: "pi.custom"`.                                                                                        |
| `custom_message` / `pi-orb.user-message` (send-anytime envelope) | `MessageRecord`, role `user`; text/image blocks, with every durable client message ID in the squashed delivery batch retained natively. |
| other `custom_message`     | `EventRecord`, `eventType: "pi.custom_message"`, with text/image content; retain `customType`, `display`, and details natively. |
| `label`                    | `EventRecord`, `eventType: "pi.label"`.                                                                                         |
| `session_info`             | `EventRecord`, `eventType: "pi.session_info"`.                                                                                  |
| unknown future entry       | `EventRecord`, `eventType: "pi.<native-type>"`.                                                                                 |

Content conversions are direct and lossless through native overflow:

- Pi text → `ContentBlock { type: "text" }`;
- Pi image `mimeType`/base64 data → normalized `mediaType`/data;
- Pi thinking text → `ContentBlock { type: "reasoning" }`;
- Pi tool call ID/name/arguments → typed `tool_call`;
- Pi tool-result call ID/content/error → typed `tool_result`;
- assistant provider/model/usage/cost/stop reason → normalized model, usage, and `finishReason` fields.

An unknown message role maps to a generic event rather than inventing a shared role. A mapping/validation failure returns a typed history error and makes `pullHistory` fail; it must never silently omit an entry.

### Completeness and cursor continuity

`SessionManager.getEntries()` is the sole Pi replication source. Pi appends user/tool/assistant messages on awaited `message_end`; streaming `message_update` state is not present there and is never synthesized into persistence. Pi's `AgentSession` notifies SDK subscribers of `message_end` immediately before it appends the ordinary message entry, and its `entry_appended` event covers extension-created custom entries rather than ordinary messages. The adapter therefore schedules a session-entry scan after each `message_end`, deduplicates by native entry ID, and performs a final synchronous scan at `agent_settled` before emitting `operation_finished` and clearing transient output. Adapter tests reproduce this exact notify-then-append ordering; mapping-only tests are insufficient to verify live-history delivery.

Every returned persisted entry maps one-to-one to exactly one record and advances the native-ID cursor exactly once. This includes labels and hidden custom entries. Unknown future types still become generic events, preserving cursor continuity across Pi upgrades.

The `pi-orb.user-message` special case is intentionally semantic rather than a presentation-only exception. Pi converts custom messages to user-role model input, so one native custom entry can carry the durable identities of a squashed FIFO batch while remaining the actual user message. Using a hidden marker followed by an ordinary user entry was rejected because it doubles records and creates a crash gap between the marker and message. Existing ordinary Pi user records remain mapped unchanged.

### Initial UI visibility

Visibility is presentation policy, not persistence filtering:

- show user and assistant messages normally; show tool names and states while keeping tool inputs and outputs collapsed by default;
- show compaction as a collapsed boundary;
- show `pi.custom_message` only when native `display` is true;
- show `pi.bash_execution` as a preformatted shell command/output block; show exit, cancellation, and truncation status, and mark excluded-shell entries as excluded from model context;
- hide model/thinking changes, branch summaries, labels, session-info entries, ordinary custom entries, and unknown events by default.

The UI still traverses hidden records when reconstructing parent chains. Hidden records remain available for diagnostics and future richer renderers.

## Rejected: Pi over tmux or subprocess RPC

Rejected for the first slice:

- tmux as UI/session transport;
- running a remote Pi TUI;
- running `pi --mode rpc` behind a gateway child process.

Decision: embed Pi through the SDK in the orb runtime and build a web UI.
