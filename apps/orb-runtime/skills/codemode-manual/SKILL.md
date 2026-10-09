---
name: codemode-manual
description: 'Full code-mode scripting manual: tool discovery, result types, state, concurrency, output and failure handling. Read for detailed API usage.'
---

# Code-mode agent manual

Run JavaScript to compose authorized tools, filter their replies and emit only useful results. For all resource caps, read [Limits (central wrapper)](/opt/pi-orb/skills/codemode-quick-reference/SKILL.md). Both skills are bundled resources on central process, Docker and GCP; read them with `tools.read`.

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

The tool description lists inline declarations, but deferred tools are callable too. Discovery exposes their exact argument and result shapes, namespace instructions and identifiers:

```js
text(await searchTools("subagent"));
text(await describeNamespace("orb"));
text(await describeTool("read"));
```

Invalid identifier characters become `_`: `mcp__dev-radius__search` is `tools.mcp__dev_radius__search`. Namespace membership does not change the callable name: an Orb call uses `tools.orb_self({})`, not `orb.self()`. Every tool takes one argument object. Arguments and replies cross a JSON boundary; do not pass functions or cyclic objects. Nested `codemode` is not callable.

Check the discovered declaration before using a result:

- Text tools such as `read`, `write` and `edit` normally return strings. A read containing images returns content blocks; emit text blocks with `text(block.text)` and image blocks with `image(block)`.
- `bash` returns `{ output, truncated, full_output_path?, exit_code, wall_time_seconds }` when a command exit status is available, including nonzero exits. Check `exit_code`; do not mistake resolution for command success. Read `full_output_path` with a tool when more captured output is needed.
- MCP calls return their `CallToolResult`, including `content`, `isError` and optional `structuredContent`. Inspect `isError` and prefer `structuredContent` for local processing. Emit selected text or image content blocks, not the whole payload.
- Other structured tools return their declared projected value. An output schema is not a universal promise that all tool replies have the same envelope.

Await required work. A failed or blocked tool call, invalid arguments, or an ordinary tool error rejects with an `Error` carrying its error text. MCP error results and command exit statuses must also be checked as above. Catch recoverable rejections inside the script, or use `Promise.allSettled()` for independent work. Batch at most eight calls, counting discovery calls as well; sequential batches still share cumulative execution budgets.

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

Successful executions commit store writes to the conversation, retained across subsequent calls and resume. Variables do not survive VM teardown. Failed executions commit no store writes. External tool effects are not rolled back, including effects before timeout, cancellation or a later script error. Nested calls are not independently replayed: inspect the affected resource before retrying a mutation.

Script completion, `exit()`, timeout or cancellation ends execution and cancels outstanding calls. Unawaited work may already have acted; cancellation is not proof of rollback. A promise that cannot settle with no pending tool call fails immediately because the VM has no timers or I/O.

## Failures and large results

The wrapper reports completion/failure, elapsed time, emitted output and any script error. Parse/runtime errors include `codemode.js` stack locations. Timeout or abort terminates the worker; VM/worker failures are sandbox failures. Out-of-memory errors require reducing retained data. Callback budget overflow reports `resource_limit`, cancels the script and callbacks, and commits no store writes.

Output-budget truncation can spill output to a private artifact and reports its path; use `tools.read({ path, offset, limit })` to inspect a bounded portion. Truncation is distinct from execution failure, and increasing `max_output_tokens` cannot raise hard resource caps. To avoid oversized results, filter and aggregate locally, emit summaries, and split work across executions. Read the linked skill's limits before choosing batch, read, store or artifact sizes.

## Provenance and license

Adapted for pi-orb's central wrapper from `@earendil-works/pi-coding-agent` 1.0.0 `docs/codemode.md` and `@earendil-works/pi-codemode` 1.0.0 `README.md`, as installed by this repository's lockfile. Upstream source: https://github.com/earendil-works/pi (paths `packages/coding-agent/docs/codemode.md` and `packages/codemode/README.md`). API behavior checked against pi-orb `apps/control-plane/src/adapters/durable/tools/codemode.ts`, `catalog.ts` and `vendor/discovery.ts`.

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
