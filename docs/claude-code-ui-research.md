# Claude Code behind a custom UI: research

**Research date: 2026-10-03 (America/Los_Angeles).** Evidence and integration implications only; no decision to adopt Claude, change authentication, or implement another harness.

## Product evidence

### Conductor

- The [subscription update](https://www.conductor.build/blog/claude-subscription-update) explicitly says: “Conductor uses native Claude Code, but we do so through the Claude Agent SDK”. This is SDK integration, not merely calls to a Claude model API.
- Its [Claude Code harness reference](https://www.conductor.build/docs/reference/harnesses/claude-code) documents bundled or system CLI selection. [Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees) isolate workspaces; [security and permissions](https://www.conductor.build/docs/reference/security-and-permissions) documents UI-facing permission controls.
- Conductor's exact internal invocation and resume strategy is not public; these sources do not establish those details.

### T3 Chat versus T3 Code

[T3 Chat's FAQ](https://t3.chat/faq) describes API providers and bring-your-own API keys. It provides no evidence of Claude Code integration. [T3 Code](https://t3.codes) is a separate product with public source.

T3 Code evidence below is pinned to inspected commit `8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf`:

- [`ClaudeAdapterV2.ts`, lines 610–719](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L610-L719): SDK `query()` consumes an `AsyncIterable` prompt queue and emits structured messages; the adapter exposes `setModel`, `setPermissionMode`, and `interrupt`.
- [Lines 830–910](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L830-L910): native thread identity becomes `resume` or `sessionId`; options include `resumeSessionAt`, `pathToClaudeCodeExecutable`, permission callbacks, and the `claude_code` system-prompt preset.
- [`apps/server/package.json`](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/apps/server/package.json) declares Claude Agent SDK `^0.3.276`.
- [`docs/user/providers-claude.md`](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/docs/user/providers-claude.md) documents Claude CLI authentication and separate accounts/configurations through `CLAUDE_CONFIG_DIR`.
- [`docs/internals/overview.md`](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/docs/internals/overview.md) places provider processes and credentials on the server, with an RPC UI; [`packages/client-runtime/src/rpc/session.ts`](https://github.com/pingdotgg/t3code/blob/8fb068c4982fc50a2a2f57c3b6fd4731735cf0bf/packages/client-runtime/src/rpc/session.ts) implements WebSocket transport.

## General mechanism

The official [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) and [hosting guide](https://code.claude.com/docs/en/agent-sdk/hosting) describe an SDK that spawns a Claude subprocess and communicates over stdio. The SDK is a programmatic interface to the native harness, not a replacement agent loop built around raw model calls.

Pinned Python SDK source makes the transport explicit:

- [`subprocess_cli.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/9c69ce7aced5cdf2aa1ac86fe62e877b4962de8b/src/claude_agent_sdk/_internal/transport/subprocess_cli.py): stream-JSON stdin/stdout.
- [`query.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/9c69ce7aced5cdf2aa1ac86fe62e877b4962de8b/src/claude_agent_sdk/_internal/query.py): control requests/responses, `can_use_tool`, and interrupt handling.

The [headless CLI guide](https://code.claude.com/docs/en/headless) also exposes `-p --output-format stream-json --verbose --include-partial-messages`. The SDK supplies the agent loop, tools, and context management; the application supplies UI, process/session lifecycle, permission projection, and application history.

Native sessions persist as JSONL under `~/.claude/projects` (or the configured Claude directory). Capture the native session ID and resume that session; a display transcript is not the complete native resume state. The [session guide](https://code.claude.com/docs/en/agent-sdk/sessions) documents session IDs and resume.

The official [`simple-chatapp` demo](https://github.com/anthropics/claude-agent-sdk-demos/tree/main/simple-chatapp) uses React, Express, and WebSocket. It demonstrates a local custom UI, not a production-ready hosted service.

## Authentication and billing caveat

The [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says: “Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products”.

Separately, the official [Claude-plan support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), dated June 16 with a June 15 update, says billing changes were paused: SDK, `claude -p`, and third-party application usage still draws from subscription limits. Conductor's [June 15 post](https://www.conductor.build/blog/claude-subscription-update) likewise says users can still use their Claude plan.

These statements concern different things. Technical capability and subscription billing do not establish general developer authorization. No specific public approval grant was found in this research; that does not establish that Conductor lacks approval. For a hosted product, use API-key/provider authentication unless permission for a subscription path is confirmed. This is not a legal determination.

## Implications for pi-orb (research only)

- A separate harness adapter over the SDK appears feasible. Retain the harness-agnostic runtime, history, and lifecycle boundaries described in `docs/runtime-protocol.md`, `docs/history-replication.md`, and `docs/pi-adapter.md`; do not route browser traffic directly to the subprocess.
- Preserve the workspace, native transcripts, and durable session identity across stop/start. Map native events into normalized history under the existing retention/security rules; replicated display history is not session reconstruction.
- A candidate adapter would need durable, queryable telemetry for process exits, SDK error results, pending approvals and their outcomes, interrupts, and native session IDs. User-visible failures and approval state must not exist only in subprocess logs.
- Authentication policy needs validation before choosing a subscription path. The observed integrations demonstrate feasibility, not an adoption or authorization decision for pi-orb.

## Split execution evidence (2026-10-04)

`toolAliases` redirects model-emitted names to supplied MCP implementations; it does not automatically preserve native tool bodies or schemas. Matching the expected input/output contract can make the remote call transparent to the agent. Harness-internal direct calls, local hooks/context discovery and filesystem checkpointing are separate concerns. The official [checkpointing limitations](https://code.claude.com/docs/en/agent-sdk/file-checkpointing#limitations) exclude remote/network files.

- **Cowork, shipped product; shell split evidence.** Official [permissions docs](https://code.claude.com/docs/en/permissions#mcp) confirm `mcp__workspace__bash` replaces native Bash. A [public runtime bug report](https://github.com/anthropics/claude-code/issues/91622) captures the desktop-spawned CLI, Bash/WebFetch aliases and VM execution logs. This supports a host-harness/VM-shell topology, not a claim that Read/Edit/Write all run remotely. The report and official docs also show that a native Bash deny can block the Cowork MCP target; aliases/permissions require pinned tests.
- **Blaxel, official reference integration.** Its [Claude Agent SDK MCP tutorial](https://docs.blaxel.ai/Tutorials/Claude-Agent-SDK-MCP) runs `query()` in an agent service connected to a separate sandbox HTTP MCP endpoint with `tools: []`. Sandbox tools handle processes/files. It does not use aliases or establish named production customers.
- **Scooter, small open-source implementation.** Pinned [`sandboxMcp.ts`](https://github.com/chadac/scooter/blob/0c01a6a04be36834f38ae5300ebe381d9092613e/services/claude-sdk-provider/src/sandboxMcp.ts) aliases Bash/Read/Edit/Write/Glob/Grep to handlers that execute in the sandbox pod. Its [implementation PR](https://github.com/chadac/scooter/pull/157) reports live validation via sandbox `hostname`. Separate pods are established, not separate physical hosts or a production deployment.
- **Soonsoft, reference implementation.** Pinned [README](https://github.com/soonsoft/remote-tools/blob/7fa28ba9de5c1b4bbb0b659d3a28b0f4051d1750/README.md) and [SDK bridge](https://github.com/soonsoft/remote-tools/blob/7fa28ba9de5c1b4bbb0b659d3a28b0f4051d1750/src/mcp-bridge/sdk.ts) route server-side SDK filesystem/shell tools through a WebSocket tunnel to a desktop. No production-adoption claim was verified.

Daytona, E2B and Modal also document separated execution through **Claude Managed Agents**, a different Platform API. Their ordinary Agent SDK sandbox examples often run the entire harness inside the sandbox; neither is evidence of SDK tool-only splitting. No named third-party production customer of the exact all-four-tools SDK split was verified in this research.
