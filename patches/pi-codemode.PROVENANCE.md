# Pi codemode patches

Package: `@earendil-works/pi-codemode@1.5.0` (MIT, notice in `patches/pi-codemode.LICENSE`).
Upstream: https://github.com/earendil-works/pi/tree/v1.5.0/packages/codemode
Published artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.5.0.tgz
Published artifact SHA-256: `400dc754a86e85cdf5e75674d2d249a67f43579a96c322457d32dd3cdd78c6e7`.
Published artifact integrity: `sha512-PLBJZ17AEWGzOlAAcFuOkw3PxkOti0JlFuZQyeF2GRTqbpuYo4k9t8YqUV2uOQVzrUnKdxahwaFUqc1eNS1WAg==`.

Patched file: `dist/runtime/prelude-source.js`, generated from `packages/codemode/src/runtime/prelude-source.ts`.
Original file SHA-256: `2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca`.
Patch SHA-256: `18890f0e765665ea62739c8211bd456353e84c06b57f6910a1d26ca7f17221ad`.

Validate image base64 with a quantifier-free invalid-character search and terminal-padding check. The upstream quantified regexp exhausts the 256 MiB VM heap on a 20 MiB image; a per-character JavaScript scan avoids that allocation but spends seconds in QuickJS bytecode. The search avoids both costs without slicing the payload. Public sandbox globals cannot override built-in `image`; there is no public prelude option. Keep the public sandbox and worker, not a fork or private import.

Preserve the exact upstream language: nonempty length divisible by four, base64 alphabet, at most two terminal padding characters. Unused padding bits remain accepted, as upstream does not require canonical encoding. Whitespace stripping, signature detection, supported media, byte output, heap and callback/output limits are unchanged. No pixel decoding or provider-size acceptance is claimed.

Applied and sealed by `scripts/apply-dependency-patches.mjs`. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

CPU budget extension: `dist/runtime/host.js` and `dist/types.d.ts` pass structured-cloneable custom worker data under `workerData.extension`; `dist/runtime/worker.js` invokes the custom worker checkpoint through the shared VM interrupt callback for ordinary execute and deterministic start/replay, including promise-job polling. Native worker admission, actual-exit hooks, deterministic clock, seed and fingerprint are unchanged. The first-party worker owns accounting and parking; upstream cancellation remains authoritative. Regression: `apps/control-plane/src/adapters/durable/tools/cpu-budget.test.ts`.

Output cap: upstream has a prelude cap of 16 Mi characters/100,000 items. A 20 MiB image is about 28 Mi base64 characters, so `MAX_OUTPUT_CHARS` is raised to 64 Mi; the bounded worker's 1 MiB text/32 MiB aggregate/4,096-item limits trip first for any item up to 32 Mi characters. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

Worker-exit correction (2026-10-16): the existing patch also removes the post-termination `worker.unref()` and its comment from published `dist/runtime/host.js` (`packages/codemode/src/runtime/host.ts`). Receipt `221` proves task25/Worker2 completed native execution, requested termination, received Node's automatic ref, then lost it to the SDK's explicit unref. Close returned, but required physical-exit drain remained pending with no referenced resources; Node exited 13. Task12/Worker1 physically exited and returned as the control. Retain Node's termination reference through actual exit; terminate/catch, interrupt, exit hooks and all other hunks remain unchanged. Evidence: `docs/postmortems/2026-10-16-codemode-worker-exit-liveness.md`.

Host patched SHA-256: `e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076`. The 2026-10-16 candidate-root `npm ci` (222) applied all six patches, added 604 packages and audited 612 packages with zero vulnerabilities, and verified the seals. Unchanged bare-file proof 223 passed all four native tasks and exited 0 on Node 24.22.0 at 19:45 PDT: full 20 MiB image equality/MIME, store readback, callback8/overflow9, rollback and final PASS. Apply the single patch directly to pristine 1.5.0; intermediate installed bytes are not an accepted release state. Current root/control-plane installs require the single three-patch set without installer arguments; execution/native-Claude guest closures are patch-free (`docs/stack.md`). Future exact-head offline Docker/network-none proof remains pending; Bun shutdown behavior is unqualified.

All pristine/patched file hashes and three patch seals: `scripts/apply-dependency-patches.mjs`.

Owned wasm accounting (2026-10-29): Node 26.13.0 omits initial and grown exported wasm capacity from both V8 heap and external-memory counters, including the actual QuickJS module. `dist/runtime/vm.js` (`packages/codemode/src/runtime/vm.ts`) publishes a getter after VM creation, before prelude/guest execution; `dist/runtime/vm.d.ts` declares it. Each read uses the current exported memory buffer (growth detaches old buffers) and returns zero after disposal. `dist/runtime/worker.js` installs it on worker-local data. The bounded worker adds the full owned capacity to V8 heap used + external; no initial-capacity deduction. Existing checkpoints sample even a quiet script's `done` before disposal, retaining peak bytes. VM limits, resource fields and deterministic fingerprints are unchanged. Regression: `apps/control-plane/src/adapters/durable/tools/wasm-memory.test.ts`, `apps/control-plane/src/adapters/durable/tools/codemode.test.ts`. The native module/QuickJS counter contract rejects future engines that count these bytes, preventing double-counting.

**Rebase (2026-11-05):** registry 1.5.0 tarball SHA-512 integrity and SHA-1 match its published metadata. All six patched files have the same pristine and patched bytes as 1.4.0; the regenerated patch retains nine hunks. Worker admission, actual-exit retention, CPU checkpoints, owned-wasm accounting, output caps and bounded image validation remain unchanged. Fresh root `npm ci` applied the three sealed patches; installer coverage passed 23 Node tests and 53 Vitest contracts/application tests. These checks do not qualify native-image execution or provider behavior.
