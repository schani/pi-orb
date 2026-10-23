---
name: codemode
description: 'Code-mode scripting instructions. Read before using codemode.'
---

# Code-mode agent manual

Run JavaScript to compose authorized tools, filter their replies and emit only useful results. This skill is a bundled resource on central process, Docker and GCP; read it with `tools.read`.

## Source and options

Submit raw JavaScript, not JSON or a Markdown fence. The source is an async function body: top-level `await` and `return` work. An optional first line sets the execution deadline and model-visible output budget:

```js
// @options: {"timeout_ms": 60000, "max_output_tokens": 2000}
const source = await tools.read({ path: "package.json" });
const pkg = JSON.parse(source);
text({ name: pkg.name, scripts: Object.keys(pkg.scripts ?? {}) });
```

Only `timeout_ms` and `max_output_tokens` are accepted. Empty source, invalid options JSON, unknown fields or an options line without code fail before execution. The options line preserves script line numbering. The output budget controls truncation, not sandbox or callback limits.

## Injected globals

Do not redeclare injected names. Each execution has a fresh QuickJS VM, with no Node, direct filesystem, network or timers. Use tools for external operations.

| Global | Use |
| --- | --- |
| `tools` | Call an authorized tool with `await tools.<identifier>(args)`. |
| `ALL_TOOLS` | Array of `{ name, description }` for callable tools; names are script identifiers. |
| `searchTools(query, { limit?, namespace? })` | Promise of ranked `{ name, description }[]`; default limit 8, positive integer. |
| `describeTool(name)` | Promise of description and TypeScript declaration, or `undefined`. |
| `describeNamespace(name)` | Promise of `{ name, description?, instructions?, tools }`, or `undefined`; `tools` contains identifiers. |
| `text(value)` | Emit text; nonstrings are JSON-stringified. |
| `console.log/info/warn/error/debug(...)` | Emit text. |
| `image(value)` | Emit an image from a base64 data URL, `{ image_url }`, or `{ type: "image", data, mimeType }`; remote URLs are rejected. |
| `store(key, value)` / `load(key)` | Synchronous conversation-scoped JSON state. |
| `exit()` | End successfully immediately, retaining emitted output and store writes. |

Only emitted text/images and the final return value reach the model; nested replies stay inside the script unless emitted. Do not print base64 image data. Use `image()` for each image block.

## Discover and call

Tools scripts can call (`await tools.<name>(args)`):

Only codemode is offered to the model. The `tool-catalogue` section of the system prompt lists the tools scripts can call, by namespace, as far as space allows. Deferred tools are callable too. Discovery exposes their exact argument and result shapes, namespace instructions and identifiers:

```js
text(await searchTools("subagent"));
text(await describeNamespace("orb"));
text(await describeNamespace("mcp"));
text(await describeTool("read"));
```

Before first using tools in a namespace, emit and read `await describeNamespace(name)`, including its `instructions`, and follow the returned server instructions. MCP server instructions are dynamic; this skill does not replace them. Use the exact namespace identifier from discovery, for example `text(await describeNamespace("mcp__github"));` for server `github`. The MCP resource `server` argument uses the bare server name (`github`), not the namespace identifier (`mcp__github`).

Namespace `orb`: discover with `text(await describeNamespace("orb"));`. Use archive/delete only on explicit user request. Stop/sleep revokes execution admission; a connected browser does not override Stop.

MCP discovery starts automatically without blocking startup or local tools. Search finds configured providers even while pending; namespaces and MCP status context show cached progress/failures. Newly discovered tools become callable in the **next script**, without calling status first. Use `text(await tools.mcp_status({}));` to inspect cached progress immediately and retry in the background after fixing connectivity or consent. Wait for connected status before calling newly discovered tools.

Namespace `mcp`: discover with `text(await describeNamespace("mcp"));`. Use server names from MCP namespaces; list resources/templates before reading unfamiliar URIs.

Invalid identifier characters become `_`: `mcp__dev-radius__search` is `tools.mcp__dev_radius__search`. Namespace membership does not change the callable name: an Orb call uses `tools.orb_self({})`, not `orb.self()`. Every tool takes one argument object. Arguments and replies cross a JSON boundary; do not pass functions or cyclic objects. Nested `codemode` is not callable.

Check the discovered declaration before using a result:

- Known text tools such as `write` and `edit` return strings. `read` returns a string or an array of image blocks; emit each image with `image(block)`. Generic mixed callbacks return a string or an array of text/image blocks; use `text(block.text)` for text blocks.
- `bash` returns `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` when a command exit status is available, including nonzero exits. Check `exit_code`; do not mistake resolution for command success. Read `full_output_path` with a tool when more captured output is needed.
- MCP calls return the full raw `CallToolResult`, including `content`, `isError` and optional `structuredContent`. Inspect `isError` and the shape of `structuredContent` before processing: it can be any JSON value, including arrays or null. Emit selected text or image content blocks, not the whole payload.
- Other structured tools return their declared projected value. An output schema is not a universal promise that all tool replies have the same envelope.

Await required work. A failed or blocked tool call, invalid arguments, or an ordinary tool error rejects with an `Error` carrying its error text. A declared structured result can resolve even on tool failure; check its error fields. MCP error results and command exit statuses must also be checked as above. Catch recoverable rejections inside the script, or use `Promise.allSettled()` for independent work. Batch at most eight calls, counting discovery calls as well; sequential batches still share cumulative execution budgets.

```js
const results = await Promise.allSettled([
  tools.read({ path: "package.json" }),
  tools.read({ path: "AGENTS.md" }),
]);
text(results.map((r, i) => r.status === "fulfilled"
  ? { i, characters: typeof r.value === "string" ? r.value.length : undefined }
  : { i, error: String(r.reason) }));
```

## Store and execution lifecycle

`store(key, value)` writes a small JSON value under a string key; `store(key, undefined)` deletes it. `load(key)` returns a copy or `undefined`: mutating that copy does not change stored state. Store IDs, cursors and summaries, not raw tool payloads or image data.

Successful executions commit native store writes to the conversation, retained across calls and resume. State rewinds with history and forks as of the selected entry. Variables do not survive VM teardown. Failed executions commit no store writes. Native deterministic journals reconstruct interrupted scripts and reattach owned nested calls; each nested tool retains its own replay policy. Parent replay refusal blocks new nested admissions, but already-admitted replay-safe pending children may retry independently until cleanup aborts them. Retries check current authorization/environment without rerunning admission-time preparation/hooks; completed callback receipts are reused. This is not exactly-once external execution. Effects before timeout, cancellation or later failure are not rolled back; inspect the affected resource before retrying a mutation.

Script completion, `exit()`, timeout or cancellation ends execution and cancels outstanding calls. Unawaited work may already have acted; cancellation is not proof of rollback. A promise that cannot settle with no pending tool call fails immediately because the VM has no timers or I/O.

## Failures and large results

Native formatting reports completion/failure and elapsed time, then emitted output and any script error. Multiple text items have `==> text N/M <==` headers; adjacent text is joined and console lines follow in one `<console_output>` block. The result is not a JSON envelope. Parse/runtime errors include `codemode.js` stack locations. Timeout or abort terminates the worker; VM/worker failures are sandbox failures. Out-of-memory errors require reducing retained data. Callback budget overflow reports `resource_limit`, cancels the script and callbacks, and commits no store writes.

Output-budget truncation can spill text to a private PostgreSQL artifact and reports its path; use `tools.read({ path, offset, limit })` to inspect a bounded portion. Images are returned inline; binary saves are unavailable, with no guest/local temporary-file fallback. Truncation is distinct from execution failure, and increasing `max_output_tokens` cannot raise hard resource caps. To avoid oversized results, filter and aggregate locally, emit summaries, and split work across executions. Read the limits below before choosing batch, read, store or artifact sizes.

## Charts

`await chart(spec)` shows the user a separate chart row; its data is not returned to the model. Use it for quantitative information that fits line or bar charts.

```js
await chart({
  kind: "line",
  title: "Latency",
  unit: "ms",
  series: [{ name: "p95", points: [["2026-10-17T12:00:00Z", 42]] }],
});
```

`spec` is `{kind:'line',title,unit?,source?,series:[{name,points:[[time,value|null]]}],markers?:[{at:time,label}],thresholds?:[{value,label}]}` (ISO or epoch-ms time, at most 6 series/5000 points) or `{kind:'bar',title,unit?,source?,bars:[{label,value}]}`. `source` is an http(s) origin link. At most 8 charts per script. For chart rendering details, read [charts](/opt/pi-orb/skills/charts/SKILL.md).

## Bounded summary example

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

## Limits (central native code-mode)

- Sandbox: no Node, direct filesystem, network or timers. Each execution gets a fresh VM; variables do not survive. 256 MiB QuickJS heap, not a process quota.
- CPU: 1 core shared across central code-mode workers per control-plane process; at most 20 ms accumulated idle credit. Cooperative checkpoints can pause scripts; wall deadlines still apply. Not an OS quota for host callbacks or other threads.
- Store: 262144 JSON characters/value; 1048576 total including keys. load() returns a copy; only successful executions commit store writes. Native state rewinds with history and forks as of the selected entry. Summarize oversized values or split work across executions.
- Options: default timeout 5 min (300000 ms); first-line `// @options: {"timeout_ms": 60000, "max_output_tokens": 10000}` overrides it. timeout_ms: positive integer ≤2147483647; max_output_tokens: nonnegative safe integer ≤9007199254740991, default 10000 estimated tokens (4 characters/token). max_output_tokens does not raise resource caps.
- Callbacks: 8 outstanding, 256 cumulative calls, 8 MiB arguments, 64 MiB replies per execution; discovery globals share these budgets. Sizes count serialized JSON UTF-8 bytes including escapes; cumulative, not per-call. Batch at most eight; same-execution chunking cannot evade totals.
- Emitted output: 1 MiB text, 32 MiB aggregate encoded image+text, 4096 items (text/console/image). This worker-pipe cap is not an unconditional top-level-return cap; keep returns small too.
- Nested bash capture: 1 MiB UTF-8; full_output_path points to a spill when truncated.
- Text read: 2000 lines or 50 KiB; continue with offset/limit. Images: PNG/JPEG/GIF/WebP retain original bytes up to 20 MiB raw, inclusive, independent of dimensions, through the native reader’s public image-processor hook.
- Images remain inline; binary artifact saves are unavailable. Private text artifact: 16 MiB each. Remote execution HTTP requests and whole-file reads: 16 MiB (request body/raw file, not encoded response). Serialization/transport may lower the allowance; strongest applicable limit wins.
- Native journals resume interrupted scripts; nested calls follow their own replay policy, not an exactly-once guarantee. Failed scripts do not roll back earlier tool effects; no store commit. Unawaited calls are cancelled when execution ends; await required work.