# Pi Durable and Pi AI policy patches

## Pi Durable

Package: `@earendil-works/pi-durable@1.6.1` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.6.1/packages/durable
Published artifact: https://registry.npmjs.org/@earendil-works/pi-durable/-/pi-durable-1.6.1.tgz
Artifact SHA-256: `90c86ce511e289a226f2f348ac296e91028725aa2767465320d5df9e3479976d`.
Artifact integrity: `sha512-hhKQg7FDsp25+pvIodqYZEEYTqKA/lBvHYJqHwwqb/zIc0hHq45HK6hQ7BnMHIyjsI7ev9P8qLCQlwxiFblm8A==`.
Patch SHA-256: `df8cd406718f16abb7735f01cb35dd29acbd13b7b89133f91d7ed64a8d14c3db`.

- Export the existing `CodemodeRunDoc` and `CodemodeJournalDoc` through the public code-mode barrels. Charts and completion decoration use the native journal and run result, not a parallel journal. Keep explicit null arguments for native schema validation; only omitted or undefined arguments default to `{}`. Native discovery uses selected extension namespaces, including declarations without tools. Preview serialization, the bounded image decoder and handled waiter rejections are upstream.
- `Conversation.submitMany(inputs, context, options?)` admits a FIFO input snapshot in one Session commit. It validates and looks up request IDs before table writes, uses the shared queued-admission helper and applies one idle boundary. Empty and duplicate-only snapshots advance idle input without minting submissions. `deferScheduling` skips the implicit scheduler resume; admission and the boundary are unchanged. Native `Conversation.admit(tx, draft)` only admits before the first table write and does not replace the snapshot operation. Native failed-run continuation remains Harness configuration. Contracts: `docs/pi.md` and `docs/lifecycle.md`.
- No patches to saved task versions, checkpoint migration, scheduler or replay formats. Regression coverage: `apps/control-plane/src/adapters/durable-pg/forward-resume.test.ts` and `apps/control-plane/src/adapters/durable/tools/`.

## Pi AI

Package: `@earendil-works/pi-ai@1.6.1` (MIT).
Upstream: https://github.com/earendil-works/pi/tree/v1.6.1/packages/ai
Published artifact: https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.6.1.tgz
Artifact SHA-256: `192c407bd69c06358c68519aa6290adc8362b132bee9117480c7604456d5073b`.
Artifact integrity: `sha512-EyorgVyA2s4MxNl7YOapzOpdxrc8HUgxHEIOo8QRMK35P7PCOsSiWzMLf6ixKl3/obkg7I3wGJWHq+FdbUz43g==`.
Patch SHA-256: `4be4716fab2488d2f59c3f7b2436f09b35625c901afc911090734b2ee48e9ac8`.

Keep typed, bounded Codex failure facts and request-bound safe broker metadata. Runtime errors expose only valid WebSocket close codes; typed diagnostics retain allowlisted codes, validated request IDs and bounded numeric fields. Native Codex request rendering, transport and the model catalog are unchanged by the patch. Regression: `apps/control-plane/src/adapters/durable/codex-diagnostics.contract.test.ts`.

Pristine/patched file hashes: `scripts/apply-dependency-patches.mjs`. Install scope: `docs/stack.md`.
