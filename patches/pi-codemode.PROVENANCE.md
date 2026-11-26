# Pi codemode patch

Package: `@earendil-works/pi-codemode@1.6.1` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.6.1/packages/codemode
Published artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.6.1.tgz
Artifact SHA-256: `69b391796f465fb7a3432c8aa5b119a0b9983d3c910aa04e2619f7f294e7b7ac`.
Artifact integrity: `sha512-xogcFe38Ek/9cabCz6sP52FjUKtuNDwLmqeM1aQiwOF5rg7jZ//FRpnMeYyhvRyod2UYhhf/ojfg6rRdXi0peQ==`.
Patch SHA-256: `da4461068e4c2335186f947ca40ab42249478a3ea8369c3b3ce5b8393aeebf70`.

MIT notice: `patches/pi-codemode.LICENSE`. Pristine/patched hashes: `scripts/apply-dependency-patches.mjs`.

Validate image base64 with a quantifier-free invalid-character search and terminal-padding check. The upstream quantified regexp exhausts the 256 MiB VM heap on a 20 MiB image; a per-character JavaScript scan avoids that allocation but spends seconds in QuickJS bytecode. The search avoids both costs without slicing the payload. Public sandbox globals cannot override built-in `image`; there is no public prelude option. Keep the public sandbox and worker, not a fork or private import.

Preserve the exact upstream language: nonempty length divisible by four, base64 alphabet, at most two terminal padding characters. Unused padding bits remain accepted, as upstream does not require canonical encoding. Whitespace stripping, signature detection, supported media, byte output, heap and callback/output limits are unchanged. No pixel decoding or provider-size acceptance is claimed.

Applied and sealed by `scripts/apply-dependency-patches.mjs`. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

CPU budget extension: `dist/runtime/host.js` and `dist/types.d.ts` pass structured-cloneable custom worker data under `workerData.extension`; `dist/runtime/worker.js` invokes the custom worker checkpoint through the shared VM interrupt callback for ordinary execute and deterministic start/replay, including promise-job polling. Native worker admission, actual-exit hooks, deterministic clock, seed and fingerprint are unchanged. The first-party worker owns accounting and parking; upstream cancellation remains authoritative. Regression: `apps/control-plane/src/adapters/durable/tools/cpu-budget.test.ts`.

Output cap: upstream has a prelude cap of 16 Mi characters/100,000 items. A 20 MiB image is about 28 Mi base64 characters, so `MAX_OUTPUT_CHARS` is raised to 64 Mi; the bounded worker's 1 MiB text/32 MiB aggregate/4,096-item limits trip first for any item up to 32 Mi characters. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

Worker exit: remove the post-termination `worker.unref()` from `dist/runtime/host.js` so Node keeps the termination reference through physical exit. Evidence: `docs/postmortems/2026-10-16-codemode-worker-exit-liveness.md`.


Owned wasm accounting: Node 26.13.0 omits initial and grown exported wasm capacity from both V8 heap and external-memory counters, including the actual QuickJS module. `dist/runtime/vm.js` (`packages/codemode/src/runtime/vm.ts`) publishes a getter after VM creation, before prelude/guest execution; `dist/runtime/vm.d.ts` declares it. Each read uses the current exported memory buffer (growth detaches old buffers) and returns zero after disposal. `dist/runtime/worker.js` installs it on worker-local data. The bounded worker adds the full owned capacity to V8 heap used + external; no initial-capacity deduction. Existing checkpoints sample even a quiet script's `done` before disposal, retaining peak bytes. VM limits, resource fields and deterministic fingerprints are unchanged. Regression: `apps/control-plane/src/adapters/durable/tools/wasm-memory.test.ts`, `apps/control-plane/src/adapters/durable/tools/codemode.test.ts`. The native module/QuickJS counter contract rejects future engines that count these bytes, preventing double-counting.
