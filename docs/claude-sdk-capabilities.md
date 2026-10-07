# Claude SDK capabilities audit

**Research — 2026-10-04.** Facts and qualification proposals; no implementation authorized.
User decision (2026-10-04): SDK/harness and workspace are co-located on the orb host, not the control plane (`docs/claude-agent-sdk.md`). The split-worker alternative is rejected: too much native behavior does not fit remote routing. Its audit below preserves evidence, not selected architecture; A denotes its trusted SDK/CLI worker and B its orb workspace. Co-location removes remote adaptations, not native background/idle qualification. The user accepts the Claude-specific long-lived guest bearer and approves POC implementation (2026-10-04); product authorization and real-account qualification remain separate.

## Scope and evidence

Latest checked: SDK **0.3.289**, CLI **2.1.289** (2026-10-04); neither is pinned by pi-orb.

No finite override list guarantees full native Claude Code functionality. `toolAliases` redirects model-issued calls, not harness-internal filesystem/process operations; aliases and `disallowedTools` are complementary, not an OS sandbox.
Native settings, CLAUDE.md, Git context, auto-memory and session files remain local to the CLI. Native file checkpointing excludes remote/network files. Headless SDK runs also omit interactive CLI features.

The current [official catalog](https://code.claude.com/docs/en/tools-reference) documents **46 names**, not the enabled inventory of a pinned SDK session.
SDK 0.3.276 declares 45 input schemas; 0.3.289 declares 43. Schemas are not live tools: stale REPL schemas survived their removal in Claude Code 2.1.275.
Availability depends on executable version, platform, model, provider, flags, settings and plugins. Capture actual init/discovery results for each pinned configuration, including children.

## Complete documented catalog

**W** = workspace-sensitive integration candidate (22); **R** = conditional network/resource routing (5); **H** = harness state/orchestration, normally retained on A (19).
W does **not** mean a simple replacement callback. Preserve native orchestration while adapting remote data, paths, process handles and results.

| Documented name | Class | Remote boundary |
| --- | --- | --- |
| Agent | W | Retain native children with configured tools; adapt isolation/worktrees. |
| Artifact | W | Workspace files and artifact transport. |
| AskUserQuestion | H | Host interaction/permission UI. |
| Bash | W | B cwd, environment and supervised processes. |
| CronCreate | H | Harness scheduling. |
| CronDelete | H | Harness scheduling. |
| CronList | H | Harness scheduling. |
| Edit | W | B filesystem and edit/read semantics. |
| EndConversation | H | Native termination; interactive-only, absent from SDK. |
| EnterPlanMode | W | Retain mode transition; adapt native local plan paths. |
| EnterWorktree | W | Retain orchestration; adapt B repository/worktree lifecycle. |
| ExitPlanMode | W | Retain mode/approval; adapt plan-file access. |
| ExitWorktree | W | Adapt B worktree cleanup and cwd. |
| Glob | W | B filesystem search. |
| Grep | W | B content search. |
| ListAgents | H | Harness child inventory. |
| ListMcpResourcesTool | R | Configure B-facing resource transport. |
| LSP | W | B files and language-server lifecycle. |
| Monitor | W | B commands/sockets, events and cancellation. |
| NotebookEdit | W | B notebook cells/files. |
| PowerShell | W | B platform shell/process semantics. |
| PushNotification | H | Harness notification delivery. |
| Read | W | B files, images and pagination. |
| ReadMcpResourceTool | R | Configure B-facing resource transport. |
| RemoteTrigger | H | Harness trigger state. |
| ReportFindings | H | Harness reporting. |
| ScheduleWakeup | H | Harness scheduling. |
| SendFeedback | H | Harness feedback. |
| SendMessage | H | Adapt correlation if remote child identity changes. |
| SendUserFile | W | B file access and delivery. |
| ShareOnboardingGuide | W | Workspace guide/file transport. |
| Skill | W | Discovery/content paths and command expansion. |
| SubagentHandback | H | Native child handoff. |
| TaskCreate | H | Harness task bookkeeping. |
| TaskGet | H | Harness task bookkeeping. |
| TaskList | H | Harness task bookkeeping. |
| TaskOutput | W | Retain task lookup; resolve B process output handles. |
| TaskStop | W | Retain task ownership; cancel/drain B processes. |
| TaskUpdate | H | Harness task bookkeeping. |
| TodoWrite | H | Harness task bookkeeping. |
| ToolSearch | R | Configure discovery of B-facing tools. |
| WaitForMcpServers | R | Configure B-facing connection lifecycle. |
| WebFetch | R | B for B-local/localhost resources; A can serve public fetches. |
| WebSearch | H | Provider-backed search can stay on A. |
| Workflow | W | Retain orchestration; adapt workspace/child execution. |
| Write | W | B filesystem. |

The four R resource/discovery tools normally need transport configuration, not overriding their native bodies.
Native Agent tools can remain with configured children; isolated worktrees require adaptation. Blindly replacing Agent, modes or task helpers would discard harness behavior.

Additional **0.3.276 schema names**, absent from the current catalog, merit enabled-inventory checks: `Projects` (local_path upload), `ProposeSkills` (skill-save paths), `ClaudeDesign` (dynamic operations), `ReadMcpResourceDir` (resource server), `RefreshMcpTools` (connection setup).
These are named schemas, not guaranteed enabled APIs or a fixed extra tool count. Generic `McpInput` is not a tool.
Plugins/MCP can provide arbitrarily many dynamic tools. Computer use is supplied by a dynamic MCP server; headless SDK `-p` excludes interactive macOS CLI `ComputerUse`.
Aliases replace model lookup, not the complete backend; even all catalog names cannot relocate checkpointing or internal filesystem access.

## One remote execution service

Proposal: one authenticated MCP server/process in B exposes many tool methods sharing cwd, filesystem, supervised process handles, authentication and lifecycle.
This is not one shell process or SSH service per tool, and file operations need not pass through a shell.
It can live inside the orb runtime behind its service/adapter boundary; controllers must not directly execute tools or access disk.

## Remote hooks

Public `Options.hooks` registers SDK async callbacks:
`HookCallback(input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput>`.
The callback runs on A but can RPC to B, execute a configured hook there, and return validated output. This is a supported extension point; the remote transport is ours, with no built-in `remoteHooksHost` option.
Settings/plugin command hooks instead run where the CLI subprocess runs; Bash aliases do not relocate them.
A hook endpoint can share the remote execution service. Forwarding must authenticate, map cwd/paths/input, honor cancellation/timeouts and preserve fail-open/closed policy.
Catch third-party failures at the adapter boundary and return typed errors, not raw exceptions. Persist sanitized execution-location/failure edges and surface user-affecting declines.
Source: [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks).

## Supplying skills

`Options.skills?: string[] | 'all'` selects **discovered names**, not inline content; a name filter is not isolation.
`plugins?: [{ type: 'local', path, skipMcpDiscovery? }]`, `additionalDirectories?: string[]` and `settingSources?: ('user' | 'project' | 'local')[]` support materialized skill bundles where the CLI runs.
There is no inline skill-content option or automatic resolution of B directories from A. Plugin paths must actually be accessible to the CLI.
Explicit `skills` adds `Skill` to `allowedTools`; an explicit `tools` list must also include native `Skill`.
Native skill `` !`command` `` interpolation executes CLI-side before the model sees the expansion, not automatically through remote hooks or Bash aliases.
Remote repository semantics need wrappers or remote Skill handling; supplying plain instructions alone does not relocate command expansion.
Sources: [SDK skills](https://code.claude.com/docs/en/agent-sdk/skills), [SDK plugins](https://code.claude.com/docs/en/agent-sdk/plugins).

## Supplying history on restart

`resume` uses an existing native session ID backed by retained local `.claude` files. `sessionId` chooses identity; it does not supply history.
The official **alpha `SessionStore`**, introduced in 0.2.113, also supports remote native-history hydration: `append(key, rawEntries)`, `load(key): Promise<rawEntries[] | null>`, optional `listSubkeys` for children.
With `query({ prompt: newMessage, options: { resume: sessionId, sessionStore: store, cwd: stablePath } })`, the SDK loads opaque raw entries into a temporary config directory **before spawning** the CLI, which then resumes natively.
Thus restart history has an actual SDK API, not merely a proposal to ship filesystem files manually. It needs full native records, not displayed message lists or history embedded in a prompt.
`projectKey` must match cwd identity; `CLAUDE_CODE_PROJECT_DIR_NAME` can stabilize it on SDK 0.3.234+. Child restoration uses native transcript subkeys, not browser replication.
Current 0.3.289 exports `importSessionToStore(sessionId, store, { dir?, includeSubagents?, batchSize? })`: it copies existing local raw transcripts **into** the store, not arbitrary chat into a native session. No exported `importSession` exists.
`query()` AsyncIterable input supplies new user prompts that trigger turns; it is not assistant/system-history injection.

**Implemented restart continuation (2026-10-06):** after retained native history and ownership qualification, Claude uses Pi's pure boot planner over normalized root evidence. A durable journal claim precedes one ordinary native continuation prompt and busy admission; native receipt provenance keeps that automatic prompt outside human budget resets. Compaction-summary/meta input likewise grants no human budget. Three claims after real user input bound dangling-tail recovery; explicit Abort/error terminals stay settled. The claim—not a second human delivery ledger entry—covers a crash before the automatic prompt's native receipt. Missing human receipts still fail closed. Sleep-wake identity is combined and deduplicated through the claim. Epoch cancellation prevents prompt admission after recovery Abort; old native child work is not replayed. Sanitized source/generation diagnostics remain in the private session pointer, not conversation. Implementation and qualification limits: `docs/claude-agent-sdk.md`.

Mirroring is best effort: failures can emit `mirror_error`, drop a batch and continue inference. Eager mode reduces buffering, not guarantees delivery.
Resumed temporary native files are deleted at session end; a dropped batch can lose the only copy. Product reliability must address this before relying on the store for durability.
The selected topology retains authoritative native files on the orb filesystem; no startup `SessionStore` or extra native-history service is needed. Its hydration API remains research evidence, not required integration. Normalized control-plane display history is insufficient for native restore.
Sources: [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage), published signatures below.

## Idleness versus root completion

Research: public `SDKResultMessage` ends a root turn, not aggregate work; `queued_turn_count`, when present, describes pending input.
`system/status` (`'compacting' | 'requesting' | null`) is not an idle signal.
`system/background_tasks_changed` replaces the full task inventory; `task_started` and terminal `task_notification` edges help correlate outcomes. Ordering against root-turn bookends is unspecified.
An ambient task excluded from the indicator is not necessarily effect-free. There is no public `Query.getBackgroundTasks()`.
`Stop` hooks snapshot `background_tasks`/`session_crons` at root response completion and may request continuation; they do not cover every interrupt/error. `StopFailure` covers errors. Neither is a universal drain boundary.
`interrupt()` receipt means cancellation acceptance, not cleanup completion; `stopTask()` likewise does not prove drain. With `perTaskStopAffordance: true`, interruption can spare background work while streaming input remains open.
`Query.close(): void` is destructive, not an awaited drain.
Sources: [public types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.289/sdk.d.ts), [TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript), [hooks](https://code.claude.com/docs/en/hooks).

Current pi-orb ownership (`docs/subagents.md`, `docs/lifecycle.md`): `pi/agent.ts:1393` finishes only with ready health, root `session.isIdle`, no `turnStart`, and no `subagentWork.busy`; persisted history flushes before completion.
`domain/subagent-work` owns admission through actual terminal publication, including queued/cancelling work and continuation handoff. Settings/input ownership separately blocks `prepareIdleStop` (`pi/agent.ts:1554`). Uploads are independent lifecycle activity; control-plane inbox and visible tabs separately prevent idle auto-stop.
Detached dev servers intentionally do not prevent idle-stop. Counting all SDK background tasks would change policy; root completion alone would lose owned work. No full equivalence is proven.

Approved POC qualification boundary (2026-10-04): SDK adapters retain owned holds through native owned tool/child cleanup, persistence and continuation handoff, and claim input synchronously before SDK submission. Co-location does not prove native background gating; remote cleanup is historical split-specific evidence.
Preserve atomic durable prepare admission fencing and final history drain.
Public types do **not** establish pre-inference fencing for SDK-originated starts/automatic continuations or cleanup ordering. Question 73 (Claude SDK) in `docs/open-questions.md` blocks qualification; debounce, Stop hooks and result events do not solve it.
The selected supervised query rotation waits for process exit, actual stdout EOF, public iteration, tracked callbacks and final history before publishing idle. It does not establish an unconditional native pre-inference fence or always-open-query parity. See the stop proposal in `docs/claude-agent-sdk.md`.
Tests first against the real SDK: blocked child after root result, background terminal → root wake, queued input versus interrupt, hook continuation/errors, reordered inventories/ambient work, late native owned tool cleanup, and prepare/archive admission versus wakes. Compose DST with explicit checkpoints; persist sanitized operation/task/session identities and decision/outcome edges, not healthy ticks.

## SessionStore versus pi-orb persistence

Checked session-storage documentation and SDK 0.3.276/0.3.289: stores hold **ordered opaque raw entries**, keyed by `{projectKey, sessionId, subpath?}`: native cwd encoding, native UUID, and child/sidecar subkey. Bind these explicitly to the orb; immutable product header identity is not mutable native session summaries.
Raw-store UUID retries can deduplicate/upsert under that API, whereas product same-ID content conflicts are immutable-history failures. UUID-less entries must preserve order, never content-deduplicate.
`append` is not a drop-in write to `history_records`: normalized IDs, parents, timestamps and message blocks are required where raw metadata is not universal; native ancestry is not arrival order. Header equality, stable ID mapping and cursor behavior still need pinned evidence under questions 3 and 4.
`apps/control-plane/src/adapters/pg/store.ts` `commitPullBatch` transactionally commits records, cursor/head, session header and inbox acknowledgement.
A mirror callback pushing raw rows would bypass current pull-only authority.
The current product replica retains lossless native conversation overflow except intentionally redacted system-prompt/tool state; native child files stay private and unreplicated.
It cannot fully hydrate native sessions and is explicitly not restore authority (`docs/history-replication.md`). Do not assume product JSON can be fed directly to the SDK.

Selected topology (`docs/claude-agent-sdk.md`): retained orb filesystem native files remain authoritative; only necessary durable normalized/platform journal feeds `/v1/history` pulls into PostgreSQL `history_records`. No startup `SessionStore` or extra native-history service is needed; the product replica is not native restore authority.
Prove native recovery and ingestion before deletion, including store-resumed temporary-file cleanup. Current product replication may lag while native disk survives; a failed mirror batch can instead lose the only resumed temporary copy. Eager background flushing is not commit-before-inference.
Historical rejected-worker alternative: if worker storage may be lost and portability is required, a distinct private durable raw store is feasible in the same PostgreSQL or object storage, with complete sensitive state and separate child access/retention. Worker appends to a control-plane raw store would add an explicit write channel/persistence decision; normalized product pulls could remain. This is not selected.
Raw persistence failures must visibly block unsafe resume, not merely log `mirror_error` while claiming durability.
Tests first: raw round-trip/order, UUID-less retry, duplicate/collision handling, changed native UUID versus immutable product identity, child subkeys/payload confidentiality, and append/pull/stop crash ordering.

## Approved POC acceptance contracts

Tests would precede implementation: capture pinned enabled tools by init/config/platform; qualify native permissions, hooks, skill discovery/expansion, images, process cancellation/drain, child worktrees and plan files.
Prove retained native-file recovery, stable identity, ingestion/compaction crash ordering and native child privacy. Remote routing and SessionStore hydration contracts above belong to the rejected split alternative.
Durable sanitized inventory/version and failure edges must expose history loss and user-affecting failures.

## Published reference sources

- [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript): options, aliases, hook and storage APIs.
- [0.3.276 tool schemas](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.276/sdk-tools.d.ts), [0.3.289 public types](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.289/sdk.d.ts): versioned evidence, not pi-orb pins.
- [Computer use](https://code.claude.com/docs/en/computer-use), [file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing): native/headless and remote-file limits.
