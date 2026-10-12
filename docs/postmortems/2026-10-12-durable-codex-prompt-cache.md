# Durable Codex calls sent no prompt cache key — 2026-10-12

Central Durable (`@earendil-works/pi-durable` 1.0.0) inference to `openai-codex` reused almost no cached input. Production data: durable Codex calls had 6.3% cached input versus about 95% for legacy host Pi; 504 durable root calls sent 45.5M uncached input tokens.

## Defect

pi-durable 1.0.0 never passed `sessionId` to `models.streamSimple`. pi-ai's Codex provider derives `prompt_cache_key` from `options.sessionId` (`dist/api/openai-codex-responses.js`: `cacheSessionId = options.sessionId`, `prompt_cache_key: cacheSessionId`), so every durable request omitted it and Codex could not route successive turns to the cached prefix. Host Pi passes its session ID and was unaffected.

pi-orb had no test of the outgoing provider request's cache identity, so the omission was invisible until token accounting was compared across harnesses.

## Correction

Upstream fixed it in pi-durable 1.0.2 ([#10424](https://github.com/earendil-works/pi/issues/10424)): a `pi.provider` conversation document (`fork: "initial"`) persists a UUIDv7 `sessionId`; generation and compaction forward it. Conversations created before the fix gain the document lazily on their next request. pi-orb adopted it with the Pi 1.1.0 upgrade (`docs/pi-adapter.md`). Compaction requests still set `cacheRetention: "none"` upstream, so they carry no key.

## Invariant

`apps/control-plane/src/adapters/durable/codex-prompt-cache.test.ts` drives `DurableAgent` against a loopback Codex endpoint and asserts the actual request bodies: one non-empty `prompt_cache_key` for every root request across turns and reopen, and a different one for a subagent conversation. Against 1.0.0 it failed with `expected undefined to deeply equal StringMatching /\S/`; it passes on 1.1.0.
