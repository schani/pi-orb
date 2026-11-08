# Luna activity headlines

Lazy one-line Luna headlines for tool calls, results and child tasks in the transcript rail and live roster, generated only when a header is seen. History, rendering and details never wait for them. Thinking headlines are separate and unpersisted.

## Targets

- **Calls:** code-mode input intent, canonical SDK `bash` command intent, subagent task intent, `get_subagent_result` retrieval intent (source: bounded `agent_id` and optional boolean `wait`/`verbose` only) and `steer_subagent` intent (only for a non-whitespace string `message`; source `message` and optional string `agent_id`; malformed IDs omitted).
- **Results:** canonical `bash` public output, `get_subagent_result`, foreground subagent terminal output and typed root completion receipts. A replicated foreground result replaces intent in the same row under its own cache key. Running results describe progress, not completion.
- **None:** code-mode tool results, background launch acknowledgements and steering acknowledgements (including delivery errors) get no outcome; they keep intent. Typed updates and workspace notices keep their labels.
- Single-call categories use the item's headline; multi-call categories keep counts with individual headers inside. No group summaries.
- Excluded from every source: aliases, arbitrary metadata, known auth fields, native overflow, reasoning, images and private child transcripts.

**Live subagent headers.** A supplied nonblank task description wins, including Claude's native header; whitespace-only counts as missing. Central Durable children without one get a Luna task-intent headline in the expanded roster. Child creation atomically appends one root `orb.subagent-task` entry (child conversation ID, original task prompt, optional header), including launches from code-mode and descendants. Normalized `agent.subagent_task` records keep typed `subagentTask: {id, prompt, description}` for source authorization; display history omits it and shows no duplicate row. A missing-header roster item carries `taskRecordId`; its source key is `<recordId>:task` in the root session. Supplied headers carry no source. The browser sees only the source reference and summary, never the prompt. Launch, execution and roster publication never wait. Rejected: requiring agent-authored headers, or replacing an existing header with Luna.

## Display contract

`headline?: string | null` on calls, results and root receipts: null offers generation; any string (including empty, or read/edit paths) displays without generation; absent offers none.

Canonical `bash` and code-mode calls also carry `code?: string`, independent of headline state: only string `args.command` for SDK `bash` (`{command:string, timeout?:number}`) or `args.code` for code-mode; no aliases, arrays or argument serialization. Malformed or whitespace-only input omits both code and intent eligibility. Whitespace and newlines are preserved; capped at 1,024 UTF-8 bytes including ellipsis without splitting characters. Live root `tool_state` and reconnect replay carry the same code before and after completion; private child calls publish neither code nor tool state. Until a summary exists, the header shows this code for absent or null markers; a committed string (including empty) replaces it; failure/Retry overrides it. Code is already public input; literals inside user code stay public.

Identity reuses enclosing `record.id`, block `detailKey` and the transcript orb/session; no extra IDs or request objects. One shared pure backend projection selects eligible calls/results/receipts for runtime and HTTP history; the frontend has no eligibility policy. Runtime emits null when cache state is unknown; HTTP history bulk-enriches cached strings without inference. WS stays content-agnostic.

For a paired call/result, `headline` **presence** (including null or empty) on the result selects the result over intent, using the result's record/detailKey. Body, status and headline association follow parent ancestry, not append order, including sibling branches with reused call IDs: user/compaction records reset only their descendants, and each result consumes the latest unconsumed ancestral call. Rejected: a linear pending map in the UI (misattributes sibling results).

```json
{"type":"tool_call","callId":"a","name":"read","headline":"src/app.ts","detailKey":"r1:0"}
{"type":"tool_call","callId":"b","name":"codemode","code":"await tools.read({path:'package.json'})","headline":null,"detailKey":"r2:0"}
{"type":"tool_result","callId":"c","headline":null,"detailKey":"r4:0"}
{"headline":null,"detailKey":"r5:subagent"}
```

## Browser behavior

- A header qualifies when first seen in a visible tab, even collapsed; unseen grouped children do not, and a group header never qualifies its children. Hidden-tab work needs a fresh observer callback on show; stale IntersectionObserver callbacks never qualify. Once qualified, a source key stays qualified for manual Retry while hidden or cropped; source/session changes reset it.
- At most **two concurrent requests per browser view**, shared by transcript and roster, leaving connections for details and controls. No durable queue.
- Pending keeps the generic label; ready changes only the headline. Failure shows `Summary unavailable. Retry` with an independent button; no spinner, badge or help. Details never wait.
- State lives in the mounted header under its source identity, not an app-wide overlay or history mutation. The first-source owner survives single→grouped growth. Resolved text survives replay null; rerender, scroll and toggles never repeat requests or clear failure. Navigation return may POST again cheaply from cache.
- Seen work may finish while cropped, parent-closed but mounted, or tab-hidden. Cancel only on unmount/navigation, session/source change or deadline. Unmounted queued work is removed; slots release once. Selecting a result cancels intent and ignores its late completion. Terminal failure needs manual Retry; no visibility leases, polling or automatic client retries. Collapse/reopen of the roster preserves mounted state; child removal or session change cancels.

## Request-owned inference

`POST /api/v1/orbs/:orbId/headlines/:recordId/:detailKey?sessionId=...` carries identity only. Success returns `{headline: string}`. Authorization precedes cache and source access. The service validates replicated source eligibility, never browser tool names or prompts. Typed outcomes: cached/generated headline, ineligible, missing/session mismatch, conflict, unavailable; no raw provider errors.

- Each POST owns cancellation and one **30 s monotonic deadline** covering source wait, credentials, Luna and publication. On a cache miss the request stays open and rereads only the missing record every **1 s** (simulation clock/`sleepResult`). The budget never resets and is checked before every new read, inference or write, even if the abort timer fires late. The expiry is passed to the generator as internal `deadlineAt`; the generator checks it before fresh Luna IO. No detached work: Cloud Run request CPU stays available.
- **Retries.** Only a known provider HTTP 503 from the SDK's terminal structured `codex_failure` diagnostic is retried: three generator invocations total, 1 s then 2 s backoff, within the same budget. Only the last structured failure counts; integer status 100–599, allowlisted transport/phase/error code and nonnegative token counts are validated at the SDK boundary. Unknown, rejected, empty, auth, aborted, 404, 429 and other failures stop immediately; application 503s from source/cache/persistence are not provider 503s. Each invocation passes the original signal and expiry into the broker, which gates pointer/secret reads, lease acquisition and refresh admission after awaited IO. SDK `maxRetries: 0`, and shared auxiliary Luna calls (headlines, names, summaries) force SSE because WebSocket continuation retries ignore that setting: one provider request per admitted invocation.
- Cancellation or expiry aborts sleep and inference and stops new IO. Already-issued credential lookups may settle but admit no further reads or refreshes. **Rotation exception:** a remote OAuth refresh admitted while the caller was live may already have consumed the only refresh token, so its secret write, fenced publication, invalidation and cleanup settle independently; no grant is returned and no inference starts for the stopped caller. A successful stopped-caller rotation emits `credential.rotation_settled` (`docs/credentials.md`). Already-issued headline writes may commit later under atomic fences.
- Concurrent independent POSTs may both infer; first-success conditional insertion stores one value and every successful caller returns that winner. Rejected: singleflight, refcounts, shared deadlines, durable jobs, locks; refresh-gated readiness (open WS rejects refresh, replica polling is ~10 s).
- Luna uses `@pi-orb/luna`'s fixed model, no tools, minimal reasoning and the project owner's credentials, never the viewer's. Source is bounded and quoted as untrusted data; one plain line of roughly 8–12 words under the existing 1 KiB cap. Error/progress facts are preserved; headlines never change authoritative status. Owner-owned code and output may still contain secrets; there is no secret scanner.

## Source, cache and fences

- Sources are complete immutable replicated normalized calls/results/receipts, never partial tokens or runtime detail fallback. Ancestry deltas are metadata-only (O(records) storage, O(depth) lookup). `readHistorySnapshot`'s internal `atRecordId` anchors context to the requested record; the service takes one anchored snapshot after the target exists, not per poll. Ordinary history cursors are unchanged; an inactive branch target can still generate without waking compute.
- Stopped and archived orbs use replica and cache only; requests never wake compute.
- Migration `030_activity_headlines.sql`: one table, unique `(orb_id, session_id, record_id, detail_key)`, headline and generation timestamp; no model/prompt revision keys. Deletion cascades with orb/session/history; archives keep the cache.
- Conditional insertion atomically checks orb/project, current session and source existence, so deletion cannot resurrect metadata and stale sessions cannot publish. `storeOk(null)` (fence invalidation) returns HTTP 409 `conflict`, `headline source changed`, `retryable: false`; the service never rereads to identify the cause. A real `StoreErr` returns 503 `unavailable` with retryability from its type (`invariant`/`corruption`: false). Neither claims cached success.

## Observability

Every headline POST except a successful cache hit emits exactly one content-free terminal lifecycle event, `headline.completed`: identity, typed outcome, model, elapsed time, stored-winner metadata, correlation, generator-attempt count, `termination` (`succeeded`, `retry_exhausted`, `not_retriable`, `cancelled`, `deadline_exceeded`), failure stage, and validated provider status/transport/phase/stop reason/error code/token counts when known. Persistence adds `persistence_outcome=stored|invalidated|store_error`, allowlisted `store_error_code=unavailable|invariant|corruption` and `sql_state` only when it matches `^[0-9A-Z]{5}$`, captured before post-await cancellation checks. Failure `retryable` matches HTTP; `termination` describes generator attempts. Each 503 retry emits `headline.retry_scheduled` (failed attempt, nominal delay, status/reason, identity, model, elapsed); at most two per request. Never raw prompts, headlines or provider errors. History bulk-enrichment failures leave null markers without events. Abrupt process death can lose the terminal event.
