# Node/V8 Wasm wrapper lifetime

On 2026-10-28, [PR 225 E2E job 123058694592](https://github.com/schani/pi-orb/actions/runs/40757059371/job/123058694592), head `8e7b1a28`, exited 132 in Node 24.22.1: `V8_Fatal`, `jit_page.has_value()`.
Same-version x64 symbols map Wasm-to-JS tier-up → ref-scope destruction → wrapper refcount/free → Wasm allocation unregister → missing JIT-page range.
[Private first-failure/source archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/f80c5983-861b-49b6-9bb1-6683386edf7c/evidence/pr225-node-wasm-first-failure-8e7b1a28.tgz) preserves the evidence.

This strongly matches [nodejs/node#66366](https://github.com/nodejs/node/issues/66366).
[V8 fix 9b8ca54d](https://github.com/v8/v8/commit/9b8ca54d5a6b6c615eb7ad6d9e2bdca7f8cb1a81) acquires a reference only if not dying, preventing a dying wrapper's double-free.
Node 24.22.1/24.22.2 source uses separate refcount/dying atomics; [24.x backport 66376](https://github.com/nodejs/node/pull/66376) was open at investigation.
[Node 26.13.0 source](https://github.com/nodejs/node/blob/v26.13.0/deps/v8/src/wasm/wasm-code-manager.h) retains combined-atomic protection and ownership-preserving wrapper handles.
One project failure was observed: no CI core/binary hash, exact module/interleaving or deterministic local reproduction establishes our precise race. The earlier Chromium Event Timing crash is separate.

**Decision (2026-10-28):** user-approved, separate Node 26.13.0 LTS upgrade; no pool, GC/JIT, retry or assertion workaround.
Existing native crash artifacts and installed-version/build-phase logs remain the diagnostics; no new persisted state.
Qualification and outstanding image/native gates: `docs/testing.md`.
