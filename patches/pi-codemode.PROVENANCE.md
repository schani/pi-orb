# Pi codemode patches

Package: `@earendil-works/pi-codemode@1.3.0` (MIT, notice in `patches/pi-codemode.LICENSE`).
Upstream: https://github.com/earendil-works/pi/tree/v1.3.0/packages/codemode
Published artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.3.0.tgz
Published artifact integrity: `sha512-2G9tmbsPhgzwfz7cmzJpbLSLqOx3eu22Gbzm+Wc3HqeZMjLQS4F3KfAabozVhv7uEjq3k2O1dZTHmhhWr2xbfQ==`.

Patched file: `dist/runtime/prelude-source.js`, generated from `packages/codemode/src/runtime/prelude-source.ts`.
Original file SHA-256: `2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca`.
Patch SHA-256: `25e9230ce5d154ec25ca5ce84509c2bd7613ea05499e3ae2b8897f89fcba5bbb`.

Replace image base64 regexp validation with a linear, constant-auxiliary-space ASCII scan. QuickJS's regexp execution exhausts the 256 MiB VM heap on a 20 MiB image before the existing output guard. Public sandbox globals cannot override built-in `image`; there is no public prelude option. Keep the public sandbox and worker, not a fork or private import.

Preserve the exact upstream language: nonempty length divisible by four, base64 alphabet, at most two terminal padding characters. Unused padding bits remain accepted, as upstream does not require canonical encoding. Whitespace stripping, signature detection, supported media, byte output, heap and callback/output limits are unchanged. No pixel decoding or provider-size acceptance is claimed.

Applied and sealed by `scripts/apply-dependency-patches.mjs`. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

CPU budget extension: `dist/runtime/host.js` and `dist/types.d.ts` pass structured-cloneable custom worker data under `workerData.extension`; `dist/runtime/worker.js` invokes the custom worker checkpoint through the shared VM interrupt callback for ordinary execute and deterministic start/replay, including promise-job polling. Native worker admission, actual-exit hooks, deterministic clock, seed and fingerprint are unchanged. The first-party worker owns accounting and parking; upstream cancellation remains authoritative. Regression: `apps/control-plane/src/adapters/durable/tools/cpu-budget.test.ts`.

Output cap: upstream has a prelude cap of 16 Mi characters/100,000 items. A 20 MiB image is about 28 Mi base64 characters, so `MAX_OUTPUT_CHARS` is raised to 64 Mi; the bounded worker's 1 MiB text/32 MiB aggregate/4,096-item limits trip first for any item up to 32 Mi characters. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.
