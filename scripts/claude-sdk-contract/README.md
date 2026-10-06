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
