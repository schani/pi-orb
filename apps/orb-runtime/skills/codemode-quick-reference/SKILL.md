---
name: codemode-quick-reference
description: 'Brief code-mode overview, example and all pi-orb code-mode limits. Read for syntax reminders or sandbox/resource-limit failures.'
---

# Code-mode

Compose authorized tools in JavaScript; process large replies locally and emit/store summaries, not raw payloads. Discover tools with searchTools/describeTool/describeNamespace. Only explicit output/return reaches the model. Do not redeclare injected globals. Await calls; show images with image(), not text(). No nested codemode.

```js
const raw = await tools.read({ path: "package.json" });
const pkg = JSON.parse(raw);
const summary = {
  name: pkg.name,
  scripts: Object.keys(pkg.scripts ?? {}),
  dependencies: Object.keys(pkg.dependencies ?? {}).length,
};
store("package-summary", summary);
text(summary);
```

## Limits (central wrapper)

- Sandbox: no Node, direct filesystem, network or timers. Each execution gets a fresh VM; variables do not survive. 256 MiB QuickJS heap, not a process quota.
- Store: 262144 JSON characters/value; 1048576 total including keys. load() returns a copy; only successful executions commit store writes. Summarize oversized values or split work across executions.
- Options: default timeout 5 min (300000 ms); first-line `// @options: {"timeout_ms": 60000, "max_output_tokens": 10000}` overrides it. timeout_ms: positive integer ≤2147483647; max_output_tokens: nonnegative safe integer ≤9007199254740991, default 10000 estimated tokens (4 characters/token). max_output_tokens does not raise resource caps.
- Callbacks: 8 outstanding, 256 cumulative calls, 8 MiB arguments, 64 MiB replies per execution; discovery globals share these budgets. Sizes count serialized JSON UTF-8 bytes including escapes; cumulative, not per-call. Batch at most eight; same-execution chunking cannot evade totals.
- Emitted output: 1 MiB text, 32 MiB aggregate encoded image+text, 4096 items (text/console/image). This worker-pipe cap is not an unconditional top-level-return cap; keep returns small too.
- Nested bash capture: 1 MiB UTF-8; full_output_path points to a spill when truncated.
- Text read: 2000 lines or 50 KiB; continue with offset/limit. Images: 20 MiB raw-byte fallback when the upstream reader reports unsupported_image.
- Private artifact: 16 MiB each. Remote execution HTTP requests and whole-file reads: 16 MiB (request body/raw file, not encoded response). Serialization/transport may lower the allowance; strongest applicable limit wins.
- Failed scripts do not roll back earlier tool effects; no store commit. Unawaited calls are cancelled when execution ends; await required work.

## Manual (explicit read)

[Manual](/opt/pi-orb/skills/codemode-manual/SKILL.md).
