# Durable orb prompt rode at the tail of every request — 2026-10-12

With the cache key fixed (`docs/postmortems/2026-10-12-durable-codex-prompt-cache.md`), the first 16 minutes of `model_calls` (`docs/model-usage.md`, 17:16–17:33 UTC) still showed poor Codex caching:

- 1,203 subagent calls: 17.2M uncached, 6.4M cached input (27%). 733 of them cached exactly 1,664 tokens.
- 11 root calls: 72% cached, but `cache_read` stayed at 129,920 for seven consecutive calls while uncached input grew from 6.9K to 31K.

Almost all of it came from one orb running about 15 concurrent subagents.

## Defect

`promptExtension` (`apps/control-plane/src/adapters/durable/prompt.ts`) declared the `orb-instructions` section only for string instructions. Production passes a function, so the orb prompt reached the model only through a `beforeRequest` hook that appended it as a system message after the history on every request. It was never persisted, and pi-ai sent `instructions: "You are a helpful assistant."`. Each request therefore ended in the full orb prompt, which the next request moved past its new items:

- No request was a prefix extension of the previous one, so pi-ai's WebSocket continuation (`previous_response_id` plus input delta, which requires exactly that) never applied; every call sent the full context.
- The orb prompt was always uncached, and the server-side prefix cache could only match up to the previous history.

The 1,664-token subagent plateau and the stalled root `cache_read` are consistent with this but were not reproduced against the real Codex backend.

## Correction

The orb prompt is always the persisted `orb-instructions` section, rendered per conversation at generation preparation. pi-durable records it in `pi.system` entries, sends it as `instructions`, and re-sends it only as a patch when it changes. The `beforeRequest` hook remains only for a request prepared before the prompt changed (for example one resumed after reopen); it appends the current prompt when it differs from the persisted one. `instructions.host_adopted` no longer carries `generation_id`: sections are rendered without the generation task identity.

## Invariant

`apps/control-plane/src/adapters/durable/codex-prompt-cache.test.ts` runs a root with reasoning, tool calls and a multi-step subagent against a loopback Codex endpoint, using a function prompt as production does. The prompt changes between turns, as when host resources are adopted. Every request carries the initial prompt as `instructions`; after the change each root request carries the new prompt exactly once in `input`; per `prompt_cache_key` each request's tools equal and its input extends the previous request's. Before the fix it failed with `expected 'You are a helpful assistant.' to be 'PENDING_PROMPT'`; with an unconditional hook it fails with `expected 2 to be 1`. The production check is `cache_share` by `use` in `model_calls`.
