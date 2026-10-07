# Native Claude SDK contract

```sh
npx vitest run apps/orb-runtime/src/claude/native-sdk.contract.test.ts
```

Requires installed SDK **0.3.289**, bundled CLI **2.1.289**, Python 3, and Linux x86-64 with seccomp user notification. The normal test suite skips these guarded probes on other platforms. Direct probe invocation fails closed there; no unguarded fallback runs.

The actual native CLI talks to an owned loopback Anthropic Messages server. Its canned SSE responses request `Bash` (`printf native-contract-fixed-output`), then finish. A separate scenario delegates that operation to a native child agent. Another submits `/compact`.

Safety:

- Fresh home, workspace, and Claude configuration; explicit environment whitelist.
- Dummy API key and local `ANTHROPIC_BASE_URL`, only in this test harness.
- No inherited subscription credentials, API keys, gateways, hooks, or project settings.
- Native internet sockets must be TCP streams. A seccomp supervisor authorizes only the owned `127.0.0.1` TCP port; other destinations and UDP/raw sockets are denied. Local Unix sockets remain available.
- A guard self-test proves local admission and external/wrong-port/UDP denial before the native scenarios.
- Optional traffic is disabled. Request headers are never read. Complete request bodies are transient; only model/effort selections survive parsing.
- Shutdown waits for native exit and closed stdio. The owned deadline kills the entire process group. Native root and child transcripts are fsynced before inspection, then deleted with the temporary home.

The fixture records field names, not credentials, prompts, request bodies, filesystem paths, or transcripts. Production billing guards are untouched.

## Observed contracts

- Submitted user UUID equals durable native `user.uuid`.
- Root assistant and tool-result UUIDs equal their SDK message UUIDs.
- `ClaudeHistory.correlate()` maps that receipt into inbox provenance.
- The root file is `config/projects/<sanitized-cwd>/<session-id>.jsonl` for the short, canonical probe path and ends with a newline.
- Supported model `claude-sonnet-5-5` receives the selected `low` effort. Native assistant records carry the same effort. Unsupported `claude-sonnet-4-5` omitted effort during characterization.
- `/compact` preserves the previously-fsynced byte prefix and appends a boundary with native compaction metadata plus an `isCompactSummary` user record.
- Child conversations live in separate `subagents/agent-*.jsonl` files. Child assistant UUIDs do not appear in the root. The SDK forwards the child's tool-call assistant but not its final hand-back assistant.
- The child scenario explicitly disables background tasks. Without that test-only setting, native Agent launches asynchronously and a root result can precede child completion. This suite does not establish aggregate idle or pre-inference fencing.
- Dummy API authentication reports `tokenSource: "none"`, `apiKeySource: "ANTHROPIC_API_KEY"`, `apiProvider: "firstParty"`. The earlier isolated, network-denied metadata-only OAuth probe reported `tokenSource: "CLAUDE_CODE_OAUTH_TOKEN"`, `apiProvider: "firstParty"` and omitted `apiKeySource`.

The local server also answers the native readiness request `HEAD /api/hello`. Unexpected routes fail the probe.

## Nested background continuation

`nested-continuation.mjs` uses the same isolation and network guard. It holds three nested provider responses until their reviewer stops and root consumes that stopped result. Checkpoints retain categories, task IDs, inventory membership and result indices, never provider bodies or result text.

On the pinned SDK/CLI, a stopped background reviewer is not automatically resumed by its nested Agent completions: all three notifications reach root, even with streaming input held open. Closing input at the first result also preserves these deliveries in the controlled schedule. Native stopped-owner dispatch requires interactive terminal mode; SDK stdout is piped, independent of whether stdin remains open.

The project-definition table runs the production `settingSources: ["user", "project", "local"]` and `claude_code` tool preset without registering SDK agents. Owned `.claude/agents/` definitions provide reviewer and leaf markers. `background: false` yields complete foreground nested results and reviewer/root synthesis. `background: true` forces asynchronous execution despite `PreToolUse.updatedInput.run_in_background: false`, with responses fenced until reviewer stop and root consumption; all three completions reach root. Project `general-purpose.md` has the same precedence. These probes qualify native mechanics, not model prompt reliability.

Production qualification injects the actual `ComposedClaudeFixture` attach/submit query's `PreToolUse` callbacks into the native probe. Under `bypassPermissions`, all worker Agent calls are denied for both project names, both definition background settings, and input true/false/absent. The reviewer provider must consume all three exact denial IDs/reasons; complete tool-result blocks must equal the native transcript. No leaf request or descendant file may exist. Ordinary worker Bash still executes; its private content never reaches root. A separate two-root-Agent provider barrier proves parallel asynchronous fanout remains available. Canned reviewer/root finals prove protocol completion, not live inference quality. Set `CLAUDE_ROOT_POLICY_ARTIFACT_DIR` when running the native contract test to retain content-free evidence.

Root can resume a named reviewer through its ordinary native `SendMessage({to: name, message: ...})` tool. The probe verifies a second reviewer result and root synthesis through that public path. This qualifies native routing and continuation, not whether a real model will choose the tool or supply a semantically complete answer.
