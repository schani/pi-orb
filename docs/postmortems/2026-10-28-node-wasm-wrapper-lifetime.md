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

## Qualification failures (2026-10-28 PDT)

[PR 227](https://github.com/schani/pi-orb/pull/227), head `ccee910a`: [CI checks](https://github.com/schani/pi-orb/actions/runs/40815977698/job/123257002330) passed 6,091 unit tests but failed one memory assertion; the control-plane image passed. No new native fatal was recorded.
All eight E2E/Durable shards failed fake-provider installation before tests. One exact-pin `5597120` reproduction with Node 26.13.0/npm 11.20.0 confirmed `EBADENGINE`: `flingit@0.0.70` bundles `better-sqlite3@12.8.0`, which excludes Node 26 under `engine-strict=true`. The npm diagnostic allowlist omitted that code, producing null CI diagnostics.

`codemode.test.ts:288` reported 8,371,958 peak bytes against >32 MiB. Standalone Node 24/26 probes, then exported-module and actual QuickJS probes, establish that Node 26 omits initial and grown owned Wasm capacity from heap/external counters. Node 24 includes it. Separate per-invocation buffers exclude cross-snapshot interference; this was not a threshold defect.
`QuickJS.create(memoryLimit)` still reaches `qjs_set_memory_limit`: that limits guest live allocations, not total worker RAM or Wasm capacity.
[V8 CL 7627920](https://chromium-review.googlesource.com/c/v8/v8/+/7627920), “Update external memory on memory growth,” is absent from checked 26.13.0/26.x source and is not a qualified remedy.
[Private first-qualification archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/f80c5983-861b-49b6-9bb1-6683386edf7c/evidence/pr227-node26-qualification-blockers-ccee910a.tgz) retains first CI logs, controlled RED, probes, source findings and hashes.

## Compatibility fixes (decision 2026-10-29 PDT)

User-authorized fixes preserve engines, assertions and limits. Fake-provider pin `a6e97a6057d4c323c341b41ea4be98b4fa59f575` uses `flingit@0.0.71`, including `better-sqlite3@12.11.1` with Node 26 support. Its dependency refresh also changes Hono, dotenv, esbuild and other fixture dependencies; the application's npm graph and Pi family remain unchanged. Upstream [fake-openai PR 11](https://github.com/glideapps/fake-openai/pull/11) remains a draft/unmerged prerequisite. Bounded npm diagnostics now retain `EBADENGINE`, never raw stderr.

The sealed SDK publishes a fresh per-VM owned-memory getter before guest execution, returning zero after disposal. The bounded worker adds the entire owned linear capacity to heap + external at existing checkpoints, including quiet completion before disposal. Native exported-module/QuickJS regressions reject engines that resume counting these bytes, preventing double-counting. Earlier overlap concerns are resolved for the pinned engine by these probes, not by subtracting initial capacity or estimating from RSS. Current/peak, historical resource fields and aggregate telemetry are unchanged. No cap, threshold, pool, GC/JIT or output-limit workaround is used. SDK source/seals: `patches/pi-codemode.PROVENANCE.md`; accounting rule: `docs/pi-adapter.md`.

Clean Node 26 installation applies the new seals; typecheck/lint/web build, 44 memory/sandbox/DST, 23 patch-pipeline, 45 fake-provider and 26 Python pin/browser cases pass. Upstream CI/build, 100 worker Vitest cases, 10 dependency Node cases and one CLI test pass; native SQLite query returns 42 on ABI 147. Owned fixture readiness/session create-list-delete and all three existing `durable-process.e2e.test.ts` tests pass with the new fixture/SDK on Node 26; both child groups clean up and ports are free. These local proofs do not qualify the full exact-head unit/DST, browser/runtime E2E or images; fresh CI remains required. Native GCP acceptance/retained-workspace release gates remain unrun. Historical wrapper-race attribution remains limited as above.

[Private compatibility-fix archive](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/f80c5983-861b-49b6-9bb1-6683386edf7c/evidence/pr227-node26-compatibility-fixes.tgz) preserves both initial failures, native accounting RED/GREEN, fixture provenance/readiness, clean-install seals and current Node 26 process receipts. Toolchains, installed packages, binaries and bulk historical DST traces are excluded.
