# Native acceptance missing personal-instructions fixture — 2026-09-15

## Outcome

Requested production GitHub run [35004543252](https://github.com/schani/pi-orb/actions/runs/35004543252)
for `ff0614ce585e16cae6d2895d5b5c88abc5afe9a7` stopped in native-image
acceptance. The durable outcome is `failed-before-apply`; no migration or
application apply occurred. No rerun or validation-only recovery was attempted.

Evidence:
- Release record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789495150-4f5492cf-5436-4bd7-94de-3e4f1e4f11e8.json`.
- GitHub artifact: `release-35004543252-1`, containing the same allowlisted record.
- Cloud Logging: log `projects/playground-dev-6ae7/logs/pi-orb-boot`, GCE instance
  `8025270142193905993`, zone `us-central1-a`, 18:34–18:36 UTC.

## Evidence and diagnosis

The checks stage passed 1,746 repository tests (five existing skips), infrastructure
checks, and all 117 E2E tests across 12 files. Native installation, sealing,
workspace/image capture, and validator creation succeeded.

Validator `pi-orb-validator-v-ff0614c-b1f671e1371949e3` began its acceptance probe
at 18:35:03 UTC. Durable boot diagnostics reported runtime failure
`personal_instructions_unavailable` at 18:35:28. The probe failed at 18:42:51.
The earlier signal-15 `runtime_exited_before_ready` event at 18:35:02 coincides
with the validator startup script's explicit runtime restart; it is distinct
from the subsequent personal-instructions failure.

Source inspection identifies a deterministic fixture contract mismatch:
`apps/orb-runtime/src/personal-instructions/endpoint.ts` requires authenticated
`GET /runtime/v1/personal-instructions` before readiness, while
`packages/native-image/src/validation-broker.ts` implements only project secrets,
MCP and model-token routes. That request therefore receives 404 and writes the
unrecognized-request marker. Runtime correctly refuses to silently substitute
empty instructions. The acceptance gate correctly refuses the resulting guest.
This is not evidence that the production personal-instructions endpoint failed:
the validator uses its own loopback broker.

Cleanup attempts best-effort serial/journal collection into the runner-local
`.context/native-image-release/20260915T182837Z-v-ff0614c` directory, whose contents
are not published by the workflow; successful collection was not independently verified. The surviving GitHub error only names the
failed SSH acceptance command; the durable boot event supplies the missing
failure classification. No recovered marker contents or local reproduction are
claimed here.

## Correction (2026-09-15; live validation pending)

The validator now serves the exact authenticated, bodyless GET with
`{ "content": "", "revision": 0 }`. No runtime fallback, production API change,
new retry or timeout increase is involved. The regression was run before the
implementation and failed deterministically with `expected 404 to be 200`.
After the one-route correction, all 65 native-image tests passed, including DST;
the package typecheck passed. Coverage checks the shared protocol schema and
exact empty snapshot, missing/wrong authorization, rejected POST/PUT/HEAD and
GET-with-body requests, and the existing unknown-route marker. Successful and
unauthorized reads do not create that marker. Local red/green logs are in
`.context/native-fixture-fix/`; the original cloud evidence above remains intact.
The first lint pass identified import ordering and line wrapping; those formatting
issues were corrected before release.

## Cleanup and production verification

The workflow logged successful deletion of validator, builder, validation data
and workspace disks, SSH key, and both rejected images. It released the GCS
release lock. Post-run read-only checks found no build/validator instances and
no release lock. All four latest-ready production revisions remained the
recorded previous revisions: `pi-orb-00056-b8n`, `pi-orb-ops-00053-kwz`,
`pi-orb-runtime-api-00058-9b8`, and `pi-orb-issuer-00018-zx7`.

## Resulting rule

A new mandatory boot-time broker read must update the strict native validation
broker and its contract coverage in the same change. Preserve unknown-route
rejection and runtime fail-closed readiness; neither broader fake responses,
longer timeouts nor a blind rerun repairs this mismatch. Corrective work is in
`TODO.md`. Passing this run's hosted-runner checks does not resolve the separately
recorded local Docker-store or WebKit-compositor incidents.
