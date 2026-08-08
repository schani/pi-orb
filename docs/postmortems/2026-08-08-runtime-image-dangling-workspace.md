# Runtime image crash-looped with a dangling workspace dependency (2026-08-08)

Status: root cause proven and fixed.

The E2E workflow began failing both Docker scenarios before either orb reached ready. The control plane observed each container permanently `restarting`; health probes failed with connection resets, and `docker logs` was empty. The same failure reproduced on `main`, independently of the orb-deletion branch.

Root cause: the turn-notification change added `@pi-orb/luna` to `apps/orb-runtime/package.json`, but `apps/orb-runtime/Dockerfile` still copied only the protocol and mock-OpenAI workspaces. `npm ci` created the local workspace link without requiring its target files to be present, so the image build succeeded. At runtime, importing the missing Luna package failed immediately and Docker's `unless-stopped` policy turned that deterministic boot failure into a silent crash loop.

Fix: copy `packages/luna/package.json` before the image's `npm ci` layer and `packages/luna/src` afterward. `apps/orb-runtime/src/dockerfile.contract.test.ts` now derives local dependencies from the workspace manifests and requires both Dockerfile copies for every local runtime dependency. The durable rule is recorded in `docs/testing.md`: adding a runtime workspace dependency must update the image artifact, and a non-Docker contract test must enforce that relationship.
