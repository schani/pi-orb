# Pi codemode patches

Package: `@earendil-works/pi-codemode@1.0.0` (MIT, notice in `patches/pi-codemode.LICENSE`).
Upstream: https://github.com/earendil-works/pi/tree/main/packages/codemode
Published artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.0.0.tgz
Lockfile integrity: `sha512-LPpFI4+T9NzDnhBDs15izWAolaoM8xnwqdziRd6Zx8BQeoEPvzefD2vMMzSyF0rOtq34TfQqkZ0ki16f6cGdMg==`.

Patched file: `dist/runtime/prelude-source.js`, generated from `packages/codemode/src/runtime/prelude-source.ts`.
Original file SHA-256: `68e5505a9ab9e19ffa0fd7bb8f93147927fd27a72cf294bb122a7faca992348d`.
Patch SHA-256: `5bb14afcf86b4030433ef030274e917287f169f3f7a0cae3130d2b46142f987d`.

Replace image base64 regexp validation with a linear, constant-auxiliary-space ASCII scan. QuickJS's regexp execution exhausts the 256 MiB VM heap on a 20 MiB image before the existing output guard. Public sandbox globals cannot override built-in `image`; there is no public prelude option. Keep the public sandbox and worker, not a fork or private import.

Preserve the exact upstream language: nonempty length divisible by four, base64 alphabet, at most two terminal padding characters. Unused padding bits remain accepted, as upstream does not require canonical encoding. Whitespace stripping, signature detection, supported media, byte output, heap and callback/output limits are unchanged. No pixel decoding or provider-size acceptance is claimed.

Applied and sealed by `scripts/apply-dependency-patches.mjs`. Regression: `apps/control-plane/src/adapters/durable/tools/image-validation.test.ts`.

CPU budget extension: `dist/runtime/host.js` and `dist/types.d.ts` pass structured-cloneable custom worker data under `workerData.extension`; `dist/runtime/worker.js` invokes the custom worker checkpoint from the existing QuickJS interrupt handler. The first-party worker owns accounting and parking; upstream cancellation remains authoritative. Regression: `apps/control-plane/src/adapters/durable/tools/cpu-budget.test.ts`.
