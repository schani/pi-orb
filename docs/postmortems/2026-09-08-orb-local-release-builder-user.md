# Orb-local release blocked by builder SSH user collision

## Finding (2026-09-08)

A requested latest-main production release reached commit `770b6a344b870672081be8f26ebd185a5941b7a2`. Typecheck, lint, unit/infrastructure tests and the complete Docker/PostgreSQL/browser E2E suite passed. Native image installation failed before container publication or application apply: `useradd: user 'orb' already exists` (exit 9).

The builder SSH invocation leaves the remote username implicit. Running gcloud from this orb's local `orb` account creates that account through guest SSH provisioning before `infra/native-vm/install.sh` unconditionally creates the runtime `orb` account with UID 2000. An operator's local username therefore changes the image-build contract. Repeating the build without separating these identities cannot fix it; accepting the pre-existing account blindly would not establish the required UID/home contract.

Evidence is retained in `.context/native-image-release/20260908T173553Z-v-770b6a3/`, especially `020-cleanup-gcloud.log`, and `.context/deploy/release-5.log`. Automatic cleanup removed the failed builder and the release lock. The browser remained on `pi-orb-00048-tnf`; no application apply occurred.

## Earlier local prerequisite failures

The first attempt lacked an SSH key, leaving gcloud waiting for interactive directory/key-generation confirmation. The tool execution deadline terminated the release without cleanup; its exactly identified builder and generation-matched lock were removed after verifying no release process remained. A local SSH key was then provisioned before retrying.

Independent gcloud/OpenTofu executable-credential refreshes also hit the two-second per-orb identity mint floor. Passing gcloud's short-lived OAuth access token to OpenTofu via its process environment allowed the subsequent attempt to reach image installation; no token was logged or stored in a file. This is bounded operational evidence, not a durable credential-refresh design.

## Invariant

Image-build administration must use an explicit identity distinct from the image's runtime account, independent of the invoking workstation username. Noninteractive release prerequisites must not prompt. Implemented the same day: every builder/validator SSH and SCP names `pi-orb-build` and an operation-owned noninteractive Ed25519 key. Cleanup removes only directories the adapter created, including partial key-generation failure and cancellation. Sealing retains the separate password-locked administrator, stops guest-account reconciliation before scrubbing credentials, and acceptance checks the runtime UID/GID/home and administrator separation. Unit tests exercise real key generation/modes/deletion, foreign-directory protection, transport arguments and typed failures; orchestration unit/DST tests cover key ownership across failure and cancellation.

Disposable GCE build `v-ssh-fix-20260908-ed19cd3cee054cc9` passed installation and sealing and established the correct identities on its validator. Complete acceptance then exposed a separate workspace resize refusal; it was diagnosed and the build cancelled with owned cleanup, not accepted or deployed. See `docs/postmortems/2026-09-08-workspace-image-readonly-check.md`. The subsequent credential investigation selected a narrower HTTP-budget correction instead of shared admission; see `docs/postmortems/2026-09-08-identity-cold-start.md`.
