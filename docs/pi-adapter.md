# Pi integration

How Pi is embedded in the orb runtime and how its persisted session maps to the harness-agnostic history model (`docs/history-replication.md`).

## Embedding decisions

- Pi will be embedded through `@earendil-works/pi-coding-agent` rather than launched through `pi --mode rpc`.
- The orb runtime is a Node.js service that owns the Pi SDK session and exposes a harness-agnostic HTTP/WebSocket protocol.
- The Pi adapter translates Pi-native persisted session entries into the shared history schema.
- A Pi extension may still be useful for Pi-specific instrumentation, but it is not the infrastructure supervisor.
- The orb runtime cannot restart itself reliably from inside its own failure domain. Docker initially, and GCE later, provide process/host supervision.
- If the runtime enters an unrecoverable state, it should exit so its host can restart it.
- User-shell commands call the Pi SDK's `AgentSession.executeBash()` directly. pi-orb does not reproduce the Pi TUI's separate `InteractiveMode` `user_bash` extension-interception layer (decided 2026-08-05).
- The runtime always appends a concise tool-baseline section to Pi's system prompt: Python 3 and Rust are available; Rust uses a persistent rustup installation with stable as the default and supports repository `rust-toolchain.toml` selection; and `agent-browser` plus Chromium are installed for browser automation, with its basic `open` and snapshot/ref workflow. This composes after discovered `APPEND_SYSTEM.md` content and before the optional port-exposure section without replacing Pi's normal resource discovery (decided 2026-08-09; tool details in `docs/host-provider.md`).
- Completed agent turns are summarized asynchronously by OpenAI's Luna model through a separate inference call. The turn-summary prompt requires one plain-text, past-tense sentence of no more than 15 words (and at most 180 characters), without a preamble or Markdown. The orb runtime resolves request authentication through its existing `ModelRuntime`, while the shared `@pi-orb/luna` package owns Luna model selection, no-tool/minimal-reasoning request policy, response parsing, and typed provider failures for both turn summaries and control-plane orb auto-naming. The adapter captures a bounded turn view after Pi settles, excluding reasoning and raw tool output, broadcasts completion/idle first, and only then queues Luna. The call never touches `AgentSession`, session history, operation outcome, or runtime health; failures are error-logged and produce no notification (decided 2026-08-06). Runtime logs record summary queued, completed (including live-connection count), skipped, and failed boundaries without logging transcript or summary content, so a missing browser notification can be localized to capture, inference, live delivery, permission, or browser construction (observability added 2026-08-07).

## User shell API and persistence

The pinned Pi SDK 0.80.10 exposes the required public API:

```ts
session.executeBash(command, onChunk, { excludeFromContext }): Promise<BashResult>;
session.abortBash(): void;
session.isBashRunning: boolean;
```

`executeBash` runs in the session cwd using Pi's configured shell, streams sanitized output through `onChunk`, supports cancellation, and truncates retained output using Pi's bash limits. Normal completion, including cancellation and nonzero exit, appends a native `bashExecution` message to agent state and the persistent session. `excludeFromContext` changes only later model-context conversion: ordinary shell results are transformed into a user-context message, while excluded-shell results are skipped by `convertToLlm`. Both modes therefore remain in Pi history and replicate to PostgreSQL; exclusion does not mean ephemeral or absent from the history log.

Abort dispatch depends on the active operation kind: agent work calls `session.abort()`, while shell work calls `session.abortBash()`. A nonzero command exit is a normal `BashResult`, not an SDK failure.

`executeBash` appends its history entry directly and does not produce the prompt path's ordinary `message_end`/`agent_settled` persistence boundaries. After it resolves, the adapter must explicitly scan/publish the newly appended entry before broadcasting `operation_finished`. A cancelled result follows the same persistence ordering. If the SDK call rejects before producing a `BashResult`, the adapter reports a failed operation and must not invent a history record.

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
| `custom_message`           | `EventRecord`, `eventType: "pi.custom_message"`, with text/image content; retain `customType`, `display`, and details natively. |
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
