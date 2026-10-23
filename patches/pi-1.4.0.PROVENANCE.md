# Published Pi 1.4.0 patch provenance

Decision (2026-10-22): retain four local safety/policy patches across all 18 published files. Inputs are npm release tarballs, not a rebuilt tag or copied 1.3 file. The installer pins the patch and both pristine/patched hashes before mutation. All packages are MIT.

## Published inputs

### pi-ai

Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/ai
Artifact: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.4.0.tgz
Integrity: `sha512-hQM/C4+1w8rHYACzDDf+0vQMnEnpzIop1tptIERVgR3ZeT/hHSzBNG8PaWPgxWQjqSeKCyBZSyp8uTT6eKK1pQ==`.
Artifact SHA-256: `b40e2ba8bb6fc332908f8b96e837dc2d1fdfb45eb9cd382f5aed111462981e3c`.
Patch: `patches/@earendil-works+pi-ai+1.4.0.patch`; SHA-256: `2f29dcf0d8b9931bfc1a16360ac48686b642fd5ce335731d33ef7755d9e48e44`.

| Published file | Pristine SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/api/openai-codex-responses.js` | `339c75c5799ec3baca669114e3779988f819a5479e2b2c43dfa0b0f05b921c92` | `51051cce5f9ea3b8f896687c0a1a993f253fd890bc7457b441ebddd54fbb3233` |
| `dist/auth/resolve.js` | `3fcec09018831324d9c7fb02f4aea707e8a9e4fec5a2bdf1b3d84d716fd3091e` | `e1b7e3e1559bda8d31e29a7f87e3525f0da07fb07b70dea560cc5920733adbed` |
| `dist/types.d.ts` | `9348589a0c88c61e78e8575539cec4bf4e4fba8bf9029d3535ddeae07cb1c696` | `0f5d7002f927971e100157d63343c3e32ef25a2b2ec385e6c1433883f75593bf` |

### pi-coding-agent

Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/coding-agent
Artifact: https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.4.0.tgz
Integrity: `sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==`.
Artifact SHA-256: `d155c16ef6fa00960fbf58b2911536e80b05f33700e0b14fbd08967ede0c7428`.
Patch: `patches/@earendil-works+pi-coding-agent+1.4.0.patch`; SHA-256: `6f0b5e53c1bd021892743b9da101bf32847b8d6423edcf706e65b0165365f381`.

| Published file | Pristine SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/core/model-runtime.js` | `44d8017928eff6721d5a56b4e71f98bcafb124f5aa6e7d3f016491e11fcf6461` | `9a0f482d3c0443fb91a44b0ab6caa6f700b3443822ce85332ce2ef65f92cf9d0` |
| `dist/core/provider-composer.d.ts` | `8b6c292d4e346cb2a45186f2b3784102aa9fa5b5bd2096ef6ec4bbb235ddb504` | `c27061ce1ffe9371ef68a2a29397a393e6e39d9c40975d61d78ad0d541330086` |

### pi-codemode

Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/codemode
Artifact: https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.4.0.tgz
Integrity: `sha512-23CNAXpS9DuLzPMyYuvrXVVio46x4YhffCgCqaWmF7F5H8PooqjrQvX4ucF6M0BhUd+x2tV6r1J0dv8cCME4Cg==`.
Artifact SHA-256: `497845355c494b11b779923c988f88412074182bbd59c7f704d8af40b3a46ada`.
Patch: `patches/@earendil-works+pi-codemode+1.4.0.patch`; SHA-256: `1558d89f7352b7bea216a090fdbbaa50deb0e778bb65f4c0ae9aa785757d8978`.

| Published file | Pristine SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/declarations.js` | `00ab54f850a7412d029f8d9699fcb51b1346f3cb2c58e47b63f9189292ec260c` | `93ea4e2a077874b6b273b5091965d208e5e2aa7668cb6215e538cc811c6d266a` |
| `dist/runtime/host.js` | `74715f56e02642913caf8247abd9cf0c559f9ed1a5e7be210e43c104e8e70da4` | `e9e50ef986e1889e57b16529f2c3b849c61ddc6e8d0c67e3f672fa335e920076` |
| `dist/runtime/prelude-source.js` | `2fc2886529c0a7e8a7c9ac16b7c96fb2bbf8d2dce562801c5a09d723a57ea6ca` | `5a52984e773985827e45490c9fb60a6fe6ec2302a8e2cbc1ffda5d5cc9737d06` |
| `dist/runtime/worker.js` | `22f72950eaaa7e7e3a816db5ce1203f2a685de0328ea097278fd74b11263d813` | `33c9418251b64423ee5e8fdb0fefecdb7346b203780150f8ed33a146ff2bf533` |
| `dist/types.d.ts` | `988afeebcfd64ed6815c102dbd4e50ffe1d1c08dd32f80ba334701ff0403edc7` | `a065c3de403312cd2abdb9d0a6ee39ed1f3f6932ffbf93df667302d3c6ef39b9` |

### pi-durable

Upstream: https://github.com/earendil-works/pi/tree/v1.4.0/packages/durable
Artifact: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.4.0.tgz
Integrity: `sha512-EtIyXH1MBSXdJSkodmy+CYXuwfve3gPrD4GNCZ0XmuRWLPupwRlNQ7fdaXjRcLoKb6SWkT/yEzK+sMmrqvYK+Q==`.
Artifact SHA-256: `6d4dedd7a342151bca8b962f35a6231312cb10e5226796734e6644ad02f48224`.
Patch: `patches/@earendil-works+pi-durable+1.4.0.patch`; SHA-256: `3e6600e43005a0d474f3941ac80a8b9541c393bab4a9e08f3274612615221bd5`.

| Published file | Pristine SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `dist/codemode/codemode.js` | `0963efb938700fe914e4a7a99c232fd6f5596bd490900574d187706f08da702a` | `577b240911724557fc43d765e75ede0ecaf3407ab76a6d4388f7359571154ea5` |
| `dist/codemode/index.d.ts` | `957445b146e49e4b76107b97e280f763101c5c8a17989db12fdcec58e3c16e71` | `151862144105f9ee00b154c09b8af871a7e64d3b9b130e07f7d2d5cd09195a05` |
| `dist/codemode/index.js` | `a8989014539cd530e35d53e50f1fd0cb823a2a711f30ae20719ca92cfb99695e` | `51a53f80d552962f2e1bc9b85e876ac019615e5d593c533d2506f0a215aa54dd` |
| `dist/codemode/output.js` | `74f9e9f346c1cc807642aae02342958de661faf1e9d7e09cff3f5a3471292470` | `c9c97f22a63482eeaa1072dbd3800f50537072b15173b845026433ba9f57b6da` |
| `dist/harness/generation.js` | `b7b8c610e23f100edd9cde336c28f70ae8c82f6e988f4b4564e1a732a2e1b531` | `86c307e63e3df339420b925d84cfb950325ac66c85200d7e069f370b5253b5d2` |
| `dist/harness/harness.js` | `472fe31f5525045ec4b27437a2049236f4f58cce4920aa9bd49e41445097574d` | `4c450554cdd1f7611bca22a457e0fb5a9764649ccf85f57c23c7627538d2ad0b` |
| `dist/harness/submissions.js` | `d171c6a0b3438471911277091117ad48d73f2af853d5b6b7a0f547c28782c9ac` | `7583cb43b8b2473d89edfd6e2e4e9279e6177d7c6dc0b31bf7ed59fc1acd86c8` |
| `dist/harness/types.d.ts` | `d370cfc70bbaf6a966f65a2c30cdd7425ccee81f6e15fb9409fac0d6ff881862` | `b4b632ae0201bec6cfddef70f48a7187fc77e060d209904d9b06424494f8c74b` |

## Semantic rebase

Each row maps one old 1.3.0 patch hunk (old-file line) to its 1.4.0 location and purpose. “Retained” means the old additions/removals survive unchanged; line offsets/context may differ. “Rebased” means the implementation follows new upstream structure. No old hunk is silently discarded.

The shared codemode published `dist` trees are byte-identical between 1.3.0 and 1.4.0; all five patched files retain the same pristine and patched hashes. The VM, execution/replay engine, deterministic clock/seed/fingerprint inputs, module version and native worker admission/exit hooks are not replaced. Durable retains its new upstream document checkpoint and scheduling contracts.

| Package / file | Old hunk | New location | Disposition / invariant |
| --- | --- | --- | --- |
| `pi-ai/dist/api/openai-codex-responses.js` | `1` | `1` | Retained: Use structured safe facts instead of arbitrary thrown-value diagnostic construction. |
| `pi-ai/dist/api/openai-codex-responses.js` | `30` | `30` | Retained: Allowlist codes/request IDs and range-check broker, HTTP and WebSocket facts; diagnostic getters cannot fail requests. |
| `pi-ai/dist/api/openai-codex-responses.js` | `162` | `194` | Retained: Track failures and stream phase across transport attempts. |
| `pi-ai/dist/api/openai-codex-responses.js` | `183` | `223` | Retained: Hoist start state for terminal diagnostics, without changing streaming events. |
| `pi-ai/dist/api/openai-codex-responses.js` | `192` | `231` | Retained: Count WebSocket attempts and bind transport only after URL resolution. |
| `pi-ai/dist/api/openai-codex-responses.js` | `215` | `261` | Retained: Remember WebSocket failure phase for a later fallback failure. |
| `pi-ai/dist/api/openai-codex-responses.js` | `229` | `276` | Retained: Emit content-free fallback facts and clear stale transport state before SSE. |
| `pi-ai/dist/api/openai-codex-responses.js` | `258` | `311` | Retained: Reset SSE per-attempt facts before abort/retry. |
| `pi-ai/dist/api/openai-codex-responses.js` | `265` | `321` | Retained: Bind SSE transport/attempt only after URL resolution, preserving fetch override. |
| `pi-ai/dist/api/openai-codex-responses.js` | `282` | `341` | Retained: Capture only safe HTTP status/request ID after response callback. |
| `pi-ai/dist/api/openai-codex-responses.js` | `300` | `360` | Retained: Expose parsed code only to allowlisted failure facts. |
| `pi-ai/dist/api/openai-codex-responses.js` | `326` | `387` | Retained: Record SSE body-start phase. |
| `pi-ai/dist/api/openai-codex-responses.js` | `345` | `407` | Retained: Emit bounded terminal facts; WebSocket close text excludes raw close reasons. |
| `pi-ai/dist/api/openai-codex-responses.js` | `366` | `434` | Retained: Forward private broker metadata through streamSimple. |
| `pi-ai/dist/api/openai-codex-responses.js` | `1173` | `1246` | Retained: Treat omitted transport as auto for cached WebSocket continuation. |
| `pi-ai/dist/api/openai-codex-responses.js` | `1242` | `1315` | Retained: Retain parsed error code for allowlist filtering. |
| `pi-ai/dist/api/openai-codex-responses.js` | `1259` | `1333` | Retained: Return code alongside existing friendly-message behavior. |
| `pi-ai/dist/auth/resolve.js` | `75` | `75` | Retained: Broker-owned refresh cancellation combines caller signal and timeout; no credential-rotation ownership transfer. |
| `pi-ai/dist/types.d.ts` | `99` | `105` | Retained: Declare private bearer-bound broker metadata; never provider payload/header content. |
| `pi-coding-agent/dist/core/model-runtime.js` | `468` | `481` | Rebased: Bind diagnostic lookup to the final resolved/overridden bearer, swallow diagnostic failure, preserve upstream OpenCode session headers/baseURL/transformHeaders/env. |
| `pi-coding-agent/dist/core/provider-composer.d.ts` | `56` | `57` | Retained: Declare broker metadata callback without altering provider auth contracts. |
| `pi-codemode/dist/runtime/host.js` | `23` | `23` | Retained: Pass structured-cloneable custom worker extension data. |
| `pi-codemode/dist/runtime/host.js` | `60` | `58` | Retained: Retain Node termination reference until physical worker exit; do not unref after terminate. |
| `pi-codemode/dist/runtime/prelude-source.js` | `39` | `39` | Retained: Raise only shared backstop to64Mi characters; first-party1MiB text/32MiB aggregate limits trip first. |
| `pi-codemode/dist/runtime/prelude-source.js` | `397` | `398` | Retained: Quantifier-free base64 validation avoids regexp heap/per-byte bytecode blowup. |
| `pi-codemode/dist/runtime/prelude-source.js` | `414` | `424` | Retained: Call bounded validator while preserving alphabet/padding/whitespace/media semantics. |
| `pi-codemode/dist/runtime/worker.js` | `23` | `23` | Retained: Run custom checkpoint before shared cancellation test in the native VM interrupt callback. |
| `pi-codemode/dist/types.d.ts` | `140` | `140` | Retained: Declare custom worker extension ABI. |
| `pi-codemode/dist/declarations.js` | `111` | `111` | Retained: Retry capped declarations without descriptions after tag-free rendering; fresh reference state per pass. |
| `pi-codemode/dist/declarations.js` | `297` | `300` | Retained: Omit property descriptions only on the fallback pass; structural bounds remain. |
| `pi-durable/dist/codemode/codemode.js` | `227` | `232` | Retained: Snapshot configured namespaces even with no callable tools; retain descriptions/instructions. |
| `pi-durable/dist/codemode/codemode.js` | `628` | `638` | Retained: Earlier-call divergence shows bounded keys/types, never argument values. |
| `pi-durable/dist/codemode/codemode.js` | `660` | `673` | Retained: Preserve explicit null for native validation; only undefined defaults to{}. |
| `pi-durable/dist/codemode/codemode.js` | `689` | `702` | Retained: Started-row arguments show bounded keys/types. |
| `pi-durable/dist/codemode/codemode.js` | `753` | `766` | Retained: Resolve canonical/normalized namespaces and final double-underscore aliases. |
| `pi-durable/dist/codemode/codemode.js` | `867` | `880` | Retained: Share bounded key/type preview across current-call divergence and display. |
| `pi-durable/dist/codemode/index.d.ts` | `1` | `1` | Retained: Export existing RunDoc/JournalDoc tokens for native chart/replay integration. |
| `pi-durable/dist/codemode/index.js` | `1` | `1` | Retained: Export the identical native document tokens at runtime, not copied definitions. |
| `pi-durable/dist/codemode/output.js` | `106` | `106` | Retained: Decode images with one byte array and indexed copy, retaining save-failure labels/bytes/media. |
| `pi-durable/dist/harness/harness.js` | `33` | `38` | Retained: Forward public submitMany to native submissions authority. |
| `pi-durable/dist/harness/types.d.ts` | `598` | `681` | Retained: Retain input-only atomic batch API and per-input submission handles/busy/inputId response. |
| `pi-durable/dist/harness/submissions.js` | `33` | `57 (submitMany)` | Rebased: Preserve prevalidation/request identity/deduplication and one atomic admission before scheduling. Add one typed upstream admission span for the batch; optional trace carriers/steer links use upstream semantics. No singular ID/result is fabricated for a batch. |
| `pi-durable/dist/harness/submissions.js` | `150` | `249 (single-submit queue)` | Rebased: Factor queued admission without changing upstream single-submit {id,status}, trace fields or boundary ordering. |
| `pi-durable/dist/harness/submissions.js` | `191` | `278 (queue helper)` | Rebased: Share queued write/input JSON copying and entry/mode selection; pass upstream fields (including optional trace) rather than reconstructing old fields. |
| `pi-durable/dist/harness/generation.js` | `244` | `262 + 281 (failure policy helper)` | Rebased; upstream helper equivalent: Model-error (including failed blocking compaction) explicitly chooses continue through upstream prepareFailure/endFailedRun. No-model keeps upstream configurable policy/defaultkeep. |
| `pi-durable/dist/harness/generation.js` | `390` | `431 (classify)` | Rebased; upstream helper equivalent: Prepare the terminal provider-failure boundary before assistant/table writes; retries still sleep using upstream Harness clock. |
| `pi-durable/dist/harness/generation.js` | `404` | `294 (upstream endFailedRun)` | Rebased; upstream helper equivalent: Use upstream endFailedRun for failed-input settlement followed by final boundary/startRun; retain unanswered model_error and failure outcome. |

Total: 47 old hunks, 18 files, four patches. The three conflicting files were reviewed against pristine 1.4.0, not replaced with old outputs.

## Contracts and qualification

`scripts/apply-dependency-patches.test.mjs` checks stable-family alignment, absence of overrides, all 18 file seals before mutation, all four installed versions, pristine application/reapplication, repository isolation and the unpatched guest/native-Claude loaded closure. First-party native/model/backlog/reopen regressions remain under `apps/control-plane/src/adapters/durable/`; integration evidence is recorded in `docs/testing.md`. Native guests install unmodified locked dependencies without the patch runner.

Optional tracing is not enabled by this release. Single-submit upstream telemetry and return statuses remain intact; batch admission uses one content-free span and retains each submission identity. Model-error draining uses the native final boundary with no new persisted policy. Configuring `afterFailedRun` for no-model failures retains upstream behavior. No unsafe-effect replay, module mismatch or deadline bypass is added.

Pi coding-agent remains required. Its exact nested `undici@8.10.2` is unchanged; no override or remediation claim accompanies this rebase.
