# Pi codemode patches

Package: `@earendil-works/pi-codemode@1.1.0` (MIT, notice in `patches/pi-codemode.LICENSE`).
Upstream: https://github.com/earendil-works/pi/tree/main/packages/codemode
Published artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.1.0.tgz
Lockfile integrity: `sha512-8Asc2AzhoNaXS1snmRFa96OhcWIlFM5k1Kuiz6p2DvIYgi5QHQccRAmDVY9oO92TzWrizpvQpconZGQ7JhlI7Q==`.

Patched file: `dist/runtime/prelude-source.js`, generated from `packages/codemode/src/runtime/prelude-source.ts`.
Original file SHA-256: `19379bd753e82b795a89168aedbb1e0b86d314e33dce4d11810c036520b0dfcf`.
Patch SHA-256: `698bac6a2644dd02f58961cfac801c30453eb6264306996ed25fec4388a44a84`.

Replace image base64 regexp validation with a linear, constant-auxiliary-space ASCII scan. QuickJS's regexp execution exhausts the 256 MiB VM heap on a 20 MiB image before the existing output guard. Public sandbox globals cannot override built-in `image`; there is no public prelude option. Keep the public sandbox and worker, not a fork or private import.

Preserve the exact upstream language: nonempty length divisible by four, base64 alphabet, at most two terminal padding characters. Unused padding bits remain accepted, as upstream does not require canonical encoding. Whitespace stripping, signature detection, supported media, byte output, heap and callback/output limits are unchanged. No pixel decoding or provider-size acceptance is claimed.

Applied and sealed by `scripts/apply-dependency-patches.mjs`. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

CPU budget extension: `dist/runtime/host.js` and `dist/types.d.ts` pass structured-cloneable custom worker data under `workerData.extension`; `dist/runtime/worker.js` invokes the custom worker checkpoint from the existing QuickJS interrupt handler. The first-party worker owns accounting and parking; upstream cancellation remains authoritative. Regression: `apps/control-plane/src/adapters/durable/tools/cpu-budget.test.ts`.

Output cap (1.1.0): upstream 1.0.1 added a prelude cap of 16 Mi characters/100,000 items. A 20 MiB image is about 28 Mi base64 characters, so `MAX_OUTPUT_CHARS` is raised to 64 Mi; the bounded worker's 1 MiB text/32 MiB aggregate/4,096-item limits trip first for any item up to 32 Mi characters. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.
