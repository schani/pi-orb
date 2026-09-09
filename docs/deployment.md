# Cloud deployment direction

Decisions about where the control plane runs and how infrastructure is managed. The operational workflow (build, apply, deploy, gotchas) lives in `infra/README.md`.

- The cloud control plane is expected to run on Cloud Run.
- At least one Cloud Run instance must remain provisioned so active-orb history polling can run continuously.
- The polling process must use always-allocated CPU/instance-based billing; a minimum instance with request-only CPU allocation is insufficient for reliable background work.
- Polling state and cursors remain in PostgreSQL because Cloud Run may restart even a minimum instance at any time.
- Multiple control-plane instances may poll the same orb concurrently. Correctness uses an optimistic cursor compare-and-swap in the commit transaction rather than a distributed polling lock or leader.
- Cloud Run WebSocket configuration is validated (open question 2): the platform behaves exactly as the architecture assumes once the request timeout is raised to 3600 s, and no VM fallback is needed.
- The cloud control plane sits behind Identity-Aware Proxy restricted to the `heyglide.com` Google Workspace domain (`domain:heyglide.com` as the sole `iap.httpsResourceAccessor`; hardcoded for now) until an application identity/authorization model exists (open question 24). The unauthenticated control plane must never be directly reachable from the public internet. Validated interactively: browser WebSockets pass through IAP after sign-in.
- **Field finding resolved (2026-08-09):** independent verification after deploying `7918170` found IAP enabled and Cloud Run invocation correctly limited to the IAP service agent, but the IAP policy itself also granted `roles/iap.httpsResourceAccessor` to `pi-orb-debug@…`, violating the sole-accessor rule above. `infra/deploy.sh` now preserves unrelated roles while replacing all accessor bindings with the sole domain member and verifies the resulting policy. Deployment `959c0f6` removed the drift; independent post-deploy inspection returned exactly `domain:heyglide.com`, while the release smoke continued to use the separate `pi-orb-ops` Cloud Run invoker path successfully.
- **Field finding (2026-08-11): deleting a drained Cloud Run revision is cleanup, not a generation fence.** Revision `pi-orb-00029-6hd` continued making background lifecycle decisions for 7 minutes 42 seconds after its successful deletion audit event, overlapping the new revision and contributing to a failed restart smoke. Autonomous lifecycle authority needs its own durable generation exclusion; revision deletion remains useful cleanup but cannot carry correctness. Incident: `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`; remediation is tracked in `TODO.md`.
- Infrastructure must be managed as code.
- The IaC tool is OpenTofu. It manages only the static plane: VPC, firewall rules, Cloud Run, Cloud SQL, Artifact Registry, IAM. Per-orb VMs are dynamic resources created by `GceOrbHostProvider` through the GCE API at runtime and are never IaC resources.
- OpenTofu state lives in GCS (versioned bucket `pi-orb-tfstate-playground-dev-6ae7`, prefix `static-plane`), decided 2026-08-01 after the original local state was lost with its working directory. The live deployment was adopted into the fresh remote state via import blocks (`infra/imports.tf`) — 17 imports, zero destroys — rather than torn down; the import blocks stay in the repo as the adoption record. Lesson encoded: local IaC state in an ephemeral checkout is how you lose it.
- The control plane, orb runtime, shared protocol, and web UI will be written in TypeScript on Node.js 24.
- **Manual-release entry point (decided and implemented 2026-08-09):** operators deploy only through `infra/release.sh`, a single command that requires a clean latest `origin/main` commit and composes the existing build/boot-gate/push, exact temporary OpenTofu plan/apply, mandatory exact-IAP reconciliation, drained-revision cleanup, and live smoke stages. Ordinary apply errors and interruption signals repair IAP with `infra/deploy.sh --iap-only` before returning failure. `umask 077` plus a mode-0700 temporary directory protects generated variables and the binary plan until they are deleted on exit. A generation-matched object in the static-plane state bucket serializes the whole transaction across workstations/runners; while holding it, the script clamps the next generation above the currently serving revision. A same-host lock fails earlier. A trap-bypassing process death can leave a stale GCS lock that requires operator verification before removal.
- **Release cancellation waits for owned cleanup (corrected 2026-09-07):** each shell layer tracks its direct child, handles one termination signal, ignores duplicates, terminates the child and waits. The native build wrapper invokes the Node builder directly rather than adding an npm process that can exit before the builder's abort cleanup. A process-group SIGINT regression requires builder cleanup to finish before either wrapper exits (`docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md`).
- **Former maintenance drain (introduced 2026-09-06, retired 2026-09-09):** `--quiesce` disabled the browser and required explicit zero-instance metrics, with shell-trap restoration. It rejected the required `files` tag and had no restoration independent of the caller. The option, helper and tests are removed rather than promoted into unattended deployment. The retained rule is that deletion, log silence and elapsed time never prove old-process retirement; any future deliberate pause requires a verified independent restoration watchdog.
- **Project-secret storage (implemented 2026-08-28; live cloud validation pending):** OpenTofu creates the shared `pi-orb-credential-project-secrets` Secret Manager parent and grants the control-plane service account secret accessor plus version manager. Browser/ops roles write immutable project bundles, the runtime role reads exact versions for boot snapshots, and the browser role's project finalizer enumerates/destroys project-owned versions. No new Cloud Run environment variable or orb-host provider input exists; all roles derive the parent through the existing secret-prefix contract (`docs/credentials.md`). The live GSM/GCE validation is tracked in `TODO.md`.
- **Public OIDC issuer service (implemented 2026-08-21; live-validated 2026-08-26):** a fourth Cloud Run service `pi-orb-issuer` runs the `PI_ORB_ROLE=issuer` branch of the same image with `INGRESS_TRAFFIC_ALL` and `invoker_iam_disabled = true` — the deployment's first and only deliberately public, unauthenticated surface. This is not an exception to the IAP rule above. That rule protects the *unauthenticated control plane*: the browser API exposes and mutates orb state, so it must never be directly reachable. The issuer serves exactly two documents — an OIDC discovery document and a JWKS — whose entire purpose is to be fetched anonymously by strangers, because a relying party verifying a pi-orb token holds no pi-orb credential to present. Both are public by construction, cacheable, and secret-free. Three properties bound it: the role env var is a hard route allowlist, so no orb data or mutation route is even registered; the service runs as its own `pi-orb-issuer` service account whose only secret access is the database URL (the public JWKs live in `oidc_signing_keys`), so "unauthenticated" and "can read private keys" are different identities; and its environment is trimmed to the three variables the role reads. Private signing keys live in the Secret Manager parent secret `pi-orb-credential-oidc-signing-key` — the id is fixed by `GsmSecretStore`'s `<prefix>-<provider>` addressing — readable only by the control-plane account that mints. **Where that boundary stops (POC limitation, recorded 2026-08-22):** it is a Secret Manager boundary, not a database one. The database URL the issuer reads *is* the deployment's single full read/write application credential, so at the PostgreSQL layer this internet-facing service holds the same rights as every other service — it could read `orbs.runtime_token_hash` or write `oidc_signing_keys` if its code asked; what prevents that today is the route allowlist and the trimmed environment, not the credential. Provisioning a read-only PostgreSQL role for the issuer (`SELECT` on `oidc_signing_keys` only) is tracked in `TODO.md` before the separately bootstrapped GCP federation tier is enabled. Commit `f36914e` passed the provider-neutral live cloud smoke, including mint, public verification, stopped-orb denial, and unknown-bearer denial; see `docs/postmortems/2026-08-26-workload-identity-cloud-release-gates.md`. `docs/workload-identity.md`, `docs/workload-identity-recipes.md`.
- **`PI_ORB_OIDC_ISSUER_URL` is computed by OpenTofu, never supplied (decided 2026-08-21; corrected and live-validated 2026-08-26):** since stage 2B the `runtime` and `issuer` roles refuse to boot without a valid issuer URL, which made "the deploy that ships this image must also set it" a live deployment hazard. A Cloud Run service cannot reference its own `.uri`, so `local.oidc_issuer_url` in `infra/oidc.tf` builds the deterministic URL Cloud Run v2 assigns a new service — `https://<service>-<project-number>.<region>.run.app`, from `data.google_project` — and both services read that one local. One apply therefore cannot ship a minting image without the matching issuer identity, and no release step has to remember anything: the hazard is removed structurally rather than documented. Live evidence showed that Cloud Run reports the hashed canonical address in `.uri` while `.urls` contains both that address and the working deterministic address. The invariant is therefore membership of the computed trust anchor in `.urls`, plus the live discovery/JWKS gate — never equality with `.uri`. The implementation asserts membership and exports the same deterministic local as `issuer_url`; commit `f36914e` passed that postcondition and verified a minted token against discovery and JWKS at the deterministic origin. Rejected: an operator-supplied variable (a hand-copied trust anchor whose drift is a silent trust migration) and a two-phase apply. `tofu output -raw issuer_url` is the operator-facing form. Incident: `docs/postmortems/2026-08-26-workload-identity-cloud-release-gates.md`.
- **Workload-identity federation bootstrap (implemented 2026-08-21, not yet run):** the GCP pool, OIDC provider, and read-only test grant that trust pi-orb's *own* issuer live in the separately invoked `infra/bootstrap-pi-orb-oidc.sh`, outside the recurring OpenTofu root, for the same reason `bootstrap-amp-oidc.sh` does: a trust boundary must not be creatable, mutable, or destroyable by the routine plan that runs using it. The script is idempotent and never deletes anything; it refuses to run with no identity scope unless `ALLOW_ANY_ORB=1` is passed deliberately, because the audience is not an authorization boundary. It also refuses to repoint an existing provider at a different issuer, which would move every existing grant. `infra/smoke-workload-identity.sh` runs from `release.sh` beside `smoke.sh`: it always mints in a disposable real orb and verifies against the deployed issuer, and additionally exchanges through STS and calls a read-only API when `PI_ORB_SMOKE_WIF_*` name a bootstrapped tier.
- **Amp-orb deployment identity (decided and implemented 2026-08-12; superseded for this repository's current orbs 2026-08-27):** project orbs authenticated keylessly through the separately bootstrapped GCP Workload Identity pool `amp-orbs`, provider `amp-oidc`, and impersonated `pi-orb-amp-deployer` service account. Provider admission requires Amp's immutable project ID `cad0f81a-f72a-40be-ba23-4238ce350328`, user ID `user_01JYNTQK807VHERYA25EAND4SM`, `token_use=exchanged`, and audience `urn:amp:gcp:playground-dev-6ae7`; `thread_id` is the Google subject. The deployer deliberately has no Owner/Editor binding: it has functional roles for the current static-plane root and diagnostics, object access scoped to the one state bucket, and token creation scoped to `pi-orb-debug` for smoke. The separately invoked `infra/bootstrap-amp-oidc.sh` remains the adoption record for that trust path. It is retained as an independently scoped access path, but repository boot hooks no longer configure Amp credentials.
- **pi-orb deployment identity (decided, bootstrapped, and live-validated 2026-08-27):** future orbs of this repository authenticate without a browser login through GCP pool `pi-orb-orbs`, provider `pi-orb-oidc`, and the existing `pi-orb-amp-deployer` service account (the historical name is retained because its reviewed deployment role set is still the desired authority). Provider admission requires this deployment's issuer, audience `urn:pi-orb:gcp:playground-dev-6ae7`, `token_use=exchanged`, and immutable pi-orb project ID `eacd1d25-2825-4c3a-a26b-3923baa86801`; the service-account binding is a `principalSet` on that project attribute, so every orb in this repository project receives the same deployment authority. `.pi-orb/gcp-external-account.json` is a non-secret executable-source configuration using the image's reviewed `/usr/local/bin/pi-orb-gcp-identity`; `.agents/setup` installs only the client and `.agents/resume` registers the federated credential and writes the four required process variables to the hook environment file on every start. An isolated empty-configuration verification passed project describe, Cloud Run listing, Artifact Registry listing, and access to the static-plane state prefix before the temporary human bootstrap login was revoked. This removes renewable human credentials and service-account keys, not deployment privilege: arbitrary code in any admitted project orb can obtain the deployer's short-lived authority. The foundation split subsequently removed project-IAM administration and ownership of admission/state-bucket policy from the recurring deployer. Deployment remains high trust: it can change application code and application-resource access policies. Re-review the role set whenever its managed resource types change.
- **Scoped release SSH (decided 2026-09-06; live validation pending):** builder, validator, and native orb instances block project SSH keys. The installed `gcloud compute ssh` implementation therefore publishes a fresh caller's key to instance metadata. The recurring deployer can set metadata on `pi-orb-*` workload instances only, and its IAP tunnel grant admits port 22 only in the image-build subnet and exact orb `/20`. Release smokes always request IAP tunneling. The debug service account and its service-account-level Token Creator binding for the deployer remain external bootstrap prerequisites owned by `infra/bootstrap-amp-oidc.sh`, not foundation resources; verify that retained binding during live adoption.

**Scoped production release finding and correction (2026-09-09):** release `b36c160` passed native image acceptance and container publication, but the application plan failed because the deployer lacked `storage.buckets.get` on `pi-orb-hosting-playground-dev-6ae7`. No application apply occurred. A separate administrator subsequently applied four foundation resources: two custom roles and their shared-deployer memberships. Bucket metadata/IAM management is conditioned on the exact hosting-bucket name and type; bucket creation is a separate project-scoped permission because GCS checks creation on the project. That create-only grant cannot be restricted to a future bucket name and does not grant management of other existing buckets. No direct object permission or foundation-administration permission was added, though hosting-bucket IAM management can of course change who can access hosted files. Empty-HOME/gcloud verification through the real, idempotent `.agents/resume` passed the full application plan using federation alone, all hosting-bucket permissions, and negative checks for state-bucket mutation and project-IAM changes. The personal administrator login was then revoked. These durable shared-account grants cover every admitted orb in this repository project; do not distribute personal refresh tokens to make access persist. Source and evidence: `infra/foundation/README.md`, `docs/postmortems/2026-09-09-release-hosting-bucket-iam.md`.

**Scoped application apply (2026-09-09):** `a02638e` passed native acceptance, updated only the four Cloud Run services through the federated deployer, and completed IAP reconciliation/drained-revision cleanup. The lifecycle smoke then exposed an orb-local userspace-Tailscale assumption: host curl could not resolve a healthy peer. The corrected probe dials through the daemon without changing readiness assertions or timeouts. The first failed release and the harness correction are recorded in `docs/postmortems/2026-09-09-orb-local-tailnet-smoke.md`; the corrected lifecycle gate subsequently passed in 221 seconds, but the identity gate failed during a fixture boot with competing old/new generations. Deleted browser revision `pi-orb-00048-tnf` was still reconciling more than thirty minutes after deletion. Revision-resource deletion is not proof of process quiescence. The current `--quiesce` path refuses the required `files` tag and cannot inventory an already-deleted active revision, so it needs a reviewed maintenance correction rather than bypassed guards. At 04:28, independent observation established the old revision's shutdown at 03:50 and explicit zero active/idle instance counts afterward. With the release lock held, only the remaining identity gate was then run; it passed in 193 seconds with the same deployed image, revisions and generation. No UI pause or additional apply was needed. All configured live gates have now passed for `a02638e`; the optional separately bootstrapped STS test tier remained disabled. This is evidence for the isolated deployed generation, not a fix for the earlier rollover/checkout failure. Evidence: `docs/postmortems/2026-09-09-deleted-browser-reconciler.md`; follow-up is tracked in `TODO.md`.

**Maintenance restoration requirement (decided 2026-09-09):** any deliberate browser pause must first arm and verify an automatic restoration watchdog independent of the agent process and web UI. Exit/signal cleanup is required as well, but is not sufficient by itself. Restore the prior scaling, exact files routing and IAP even when maintenance fails; refuse to begin if that safeguard is unavailable. The current helper does not yet satisfy this requirement; implementation is tracked in `TODO.md`. In this incident, observed natural shutdown removed the need to pause, so no restoration watchdog or downtime was introduced.

## Hosted-file storage (decided 2026-09-07)

Storage belongs to the control plane, independently of `PI_ORB_HOST_PROVIDER`:

- `PI_ORB_HOSTING_STORE=filesystem` uses `PI_ORB_HOSTING_ROOT`, defaulting to
  `~/.pi-orb/hosting`. Preserve that directory alongside the PostgreSQL/PGlite database. It must
  live outside orb workspaces so compute removal cannot delete hosted documents. Multiple control
  planes need shared storage; independent local roots cannot serve the same catalog.
- `PI_ORB_HOSTING_STORE=gcs` uses `PI_ORB_HOSTING_BUCKET` and application-default credentials.
  OpenTofu creates a private bucket with object access for the control-plane identity and disables
  soft delete and versioning so permanent deletion removes the bytes.

`PI_ORB_HOSTING_ORIGIN` is the separate files origin; `PI_ORB_APP_ORIGIN` supplies dashboard links.
Local defaults are `http://files.localhost:7100` and `http://127.0.0.1:7100` (using `PORT` when set).
The local `all` role alone supplies those origin defaults, the filesystem default, and trust for
the Vite origins on port 5173. Split `browser`, `runtime`, and `ops` roles require an explicit store
kind and both origins; GCS also requires the bucket. The public `issuer` role reads no hosting
configuration and registers no hosting guard or route.
The cloud browser service exposes its latest revision with traffic tag `files`; uploads use the
existing runtime service and downloads use the browser service's IAP policy. No additional serving
service, public bucket URL, or orb-host credential is introduced. A non-GCP deployment must provide
its own authenticated ingress for both hostnames; local development retains its trusted-local
access boundary. The full post-apply step verifies fresh Cloud Run traffic status before revision
pruning; the IAP-only repair path remains available when application traffic is malformed. See
`docs/hosting.md` for origin isolation, first-adoption rationale, and transfer limits.

## Decision: split portable foundation and application roots before remote builds

**Decided 2026-08-31; implemented 2026-09-05; adopted and first deployed 2026-09-07.** Portability to a fresh GCP project must come before replacing the local image build or automating releases. The foundation and application roots separate long-lived authority from recurring application deployment. The adoption and release order is:

1. Create a separately-stateful **foundation root** for project services, the state bucket, Artifact Registry, deployment/build identities, workload-identity pools and providers, and their IAM. Where project creation is in scope, its folder and billing attachment belong here too. This root is applied by an organization/bootstrap authority; the recurring deployer must not control the trust policy that grants its own authority.
2. Leave the recurring **application root** responsible for the two application firewall rules, Cloud SQL, Secret Manager parents and runtime grants, Cloud Run, and the other serving resources. The foundation owns both VPCs, their subnets, and the private-services connection because Compute IAM Conditions cannot isolate network, subnet, or address names. The application consumes their explicit foundation outputs. The Cloud Run egress subnet output is the project-qualified `projects/PROJECT/regions/REGION/subnetworks/NAME` resource name required by the Cloud Run API.
3. Adopt the current live resources into the two states under the existing global release lock, using an offline, generation-checked state projection that preserves the complete resource-identity inventory without applying cloud changes. Review the subsequent foundation and application plans separately; the application plan intentionally includes the native runtime change. The state bucket's own bootstrap uses an organization-owned state location or an explicit one-time state migration; it cannot recursively create the backend in which its first plan is already stored.
4. After foundation adoption and its reviewed permission changes, the manual release builds and validates a native image on disposable GCE VMs, then publishes the control-plane container. Its handoff carries the exact VM image resource/ID and container digest. Automatic deployment and remote control-plane container builds remain separate proposals; the release lock, exact-plan apply, unconditional IAP repair, and smoke gates remain mandatory.

A new project should require variables plus one audited foundation apply and the normal release command, not console-created resources. Irreducible external inputs remain: an initial organization/folder/billing authority, a globally unique project ID, and credentials or values owned by external systems such as GitHub OAuth and Tailscale. OpenTofu manages their GCP containers and grants, but cannot safely invent those external authorities or secret values. Implementation is tracked in `TODO.md`.

**Orb-local release finding and correction (2026-09-08):** builder administration uses explicit `pi-orb-build` SSH/SCP identity, separate from runtime `orb` and independent of the invoking workstation username. Releasing `770b6a3` from an orb created `orb` through SSH before image installation, which then failed creating its UID-2000 account. Production was not changed. Preflight now creates a private operation-owned SSH key noninteractively; connections use batch mode, and cleanup removes the key after remote cleanup on success, failure and handled cancellation. Sealing retains the password-locked administrator but stops guest-account reconciliation before scrubbing credentials; image acceptance checks the distinct identities and required runtime home. Reusing an arbitrary existing runtime account is rejected rather than normalizing ownership under a live administrative session. Evidence: `docs/postmortems/2026-09-08-orb-local-release-builder-user.md`.

**Credential-refresh diagnosis resolved (2026-09-08; corrected locally, not deployed):** original Cloud Run logs and a controlled cold-ingress relay identified premature client cancellation, not a need for shared credential coordination. Each original three-second HTTP cap abandoned a request behind an 8–9-second runtime API cold start; the abandoned request still minted and throttled the queued retries. The CLI now allocates the remaining part of its unchanged ten-second budget to each request, including the body, and offers opt-in token-free stderr diagnostics. Sequential and concurrent warm refreshes recovered normally; real gcloud and OpenTofu failed with the original CLI and passed with the corrected CLI behind the same controlled 8.5-second ingress delay. No token cache, shared lock, access-token override or issuer-limit change was implemented. Evidence: `docs/postmortems/2026-09-08-identity-cold-start.md`.

**Earlier credential-refresh coordination proposal (2026-09-08; not selected after diagnosis):** preserve the issuer's per-orb mint floor and the rule that OIDC tokens are never cached on disk. Independent executable-credential consumers lack a shared mint schedule. The existing CLI already honors `Retry-After` within ten seconds, so a sustained refusal requires reconstructing the actual competing requests before claiming that two adjacent refreshes explain it. The broader proposed correction is process-shared admission around the credential helper: one private per-orb/incarnation lock, bounded queue admission, and a non-secret next-eligible timestamp; serialize mint requests across audiences, respect the server's floor, and retain explicit denial/cancellation rather than unbounded retries. Store no JWT in the lock or timestamp file. Release the lock on process death and conservatively handle death before publishing the timestamp. This avoids introducing a token-caching service or weakening lifecycle authorization. Coordination cannot cover direct mint callers that bypass it, so ordinary CLI throttling remains necessary. A single exported OAuth access token is only a bounded diagnostic workaround, not the solution for hour-long releases. **Smaller alternatives considered (2026-09-08):** first diagnose the existing bounded retry behavior; a bad retry hint or redundant refresh might need only a focused fix. Sharing one exported Google access token with OpenTofu demonstrated a bounded workaround, but cannot refresh an already-running child. A narrower release-wrapper proposal obtains sufficiently fresh credentials just before each OpenTofu stage, scopes them to that child, and checks that remaining validity covers the stage; this avoids requiring one token to survive the native build plus deployment, but cannot serve an arbitrarily long apply or unrelated callers. Prefer the smallest sufficient correction after reconstructing the schedule; shared admission is not yet selected. Fixed sleeps between shell commands, indefinite retries and blindly weakening the issuer limit are rejected as unproven responses. The later diagnosis above selected a smaller correction to the existing HTTP retry budget instead. The normal runtime release/E2E gates still apply before shipping it.

**Native acceptance finding and simplification (2026-09-08):** the orb-local SSH correction passed real GCE installation/sealing and validator identity checks, but workspace growth blocked that candidate's acceptance. A successful read-only `e2fsck` does not necessarily establish the persistent check state `resize2fs` requires. Validate the captured template's actual mount/check history; do not bypass the damaged-workspace repair refusal. A local real-loop-device reproduction confirmed the same failure after template mount/unmount and confirmed that a final writable check of the fresh empty template before capture lets the unchanged read-only boot gate and growth succeed. That writable-check workaround was subsequently rejected in favor of removing growth entirely: the template, validation disk and production workspace are now all 50 GiB, with no configurable workspace capacity. Admission only reads metadata and rejects mismatches; retained disks are never reformatted or resized. The builder retains a read-only integrity gate on the empty template. Production capacity cost is unchanged because it already provisioned 50 GiB. Disposable build `v-fixed-workspace-20260908-a28c6fb5b1e24029` subsequently passed the full GCE image/guest/Cloud Logging acceptance gate in 7m34s; the 50 GiB workspace template occupied only 160,256 compressed bytes. All test resources were removed. This validates the standalone image, not a production application deployment. Evidence: `docs/postmortems/2026-09-08-workspace-image-readonly-check.md`.

## Native runtime VM image release (implemented 2026-09-05; first deployed 2026-09-07)

The native Debian direction selected on 2026-09-05 in `docs/host-provider.md` adds a custom VM image build and an actual-VM boot gate to the release path. The control plane remains an OCI image; local Docker runtime builds remain useful for development and E2E. The release manifest and application configuration carry the exact uniquely named VM image resource and recorded image identity instead of the GCE runtime container digest, alongside the monotonic host-spec generation. Retain previous images for rollback, performed as a new forward-generation release through ordinary stopped-compute replacement. Builder/image-publishing permissions and the control plane’s read-only use of private images belong to the foundation; orb VMs must not receive image-publishing authority. The builder must remove build credentials and instance-specific state before image capture. VM and container builds share runtime source and the npm lockfile; the native OS/tool recipe is in `infra/native-vm/`.

**Image regeneration requirement (decided 2026-09-05).** One documented repository command must rebuild a ready-to-use image from declared inputs. It must check prerequisites, create its builder, wait for installation, seal/capture and validate the image, clean up owned temporary resources, and report the exact image identity and build manifest. No manual SSH, console edits, or remembered sequence of experiment stages is acceptable. Document prerequisites/permissions, arguments and defaults, a copy-paste example, outputs, logs and failure cleanup. Image regeneration must also work independently of deploying it. Build/release behavior is subject to the unit and DST requirements in `docs/testing.md`.

The release command requires the matching foundation state before building. Apply the separately reviewed foundation adoption and permission changes before deploying the native application configuration. Bake-and-boot duration, image storage retention, and OS patch rebuild cadence are part of the evaluation; no new deployment mechanism is selected here. The image packaging decision is recorded in `docs/open-questions.md`, question 48.

The first foundation-backed native rollout exposed three boundary-contract
failures before live validation: the IAM condition operator limit, a
digit-leading image version, and a Cloud Run subnet self-link. Their fixes and
recovery evidence are in
`docs/postmortems/2026-09-07-native-foundation-release-contracts.md`.

All existing orbs were confirmed archived before transition. The pre-release snapshot covered two projects and 51 archived orbs, with exact metadata, history and message hashes retained under mode 0600. Foundation adoption and the first native application deployment completed on 2026-09-07. Post-deployment verification confirmed all 51 archived orbs retained exact metadata, history and message hashes. Final API inventory contained only the two original projects and 51 archived orbs; release and validation fixtures were removed. An orphaned builder from an earlier interrupted release was identified by exact ownership and deleted with its disk.

The deployed image `pi-orb-image-v-db8cb5d-ebd0a574514547e9` occupies 1,369,020,352 bytes (1.275 GiB compressed) and provisions a 20 GiB `pd-standard` boot disk plus a retained 50 GiB `pd-balanced` workspace per orb. At the published Iowa rates, that is about $0.064/month for the retained image, $0.80/month for a provisioned boot disk and $5.00/month for a workspace, before VM compute and other services. Google bills provisioned disk capacity rather than used bytes and prorates disk charges by the second ([disk and image pricing](https://cloud.google.com/compute/disks-image-pricing)). The final `db8cb5d` release log spans 20:49:37–21:17:59 UTC (28 minutes 22 seconds). Native image build and fresh-VM acceptance ran from 20:49:44 to 20:57:48 UTC (8 minutes 4 seconds). The lifecycle smoke passed in 528 seconds, including a 419-second first boot and 50-second restart; the identity smoke passed mint, verification, denial and revocation in 483 seconds. Its optional GCP STS federation legs were not configured. Every release fixture was deleted. A separate retained-disk replacement then passed the exact image, workspace, home, Docker-volume, history, model/tool, immediate-terminal and same-incarnation restart checks described in `docs/native-vm-prototype.md`.

## Automation priorities after the orb-local release

**Implementation authorized (2026-09-09):** the user requested the complete one-button deployment path, requiring only necessary authentication. Use a manually triggered external workflow; do not enable deployment on every push or automatic rollback. The scope below is accepted; GitHub admission is complete, and full-workflow live validation remains pending. Harden the existing release command before adding unattended deployment. Most of the happy path is already scripted; this release's manual work was failure diagnosis, environment recovery and proving old-controller retirement, not typing deployment commands.

1. **Remove rollout interference first.** Stale revisions must lose autonomous lifecycle authority, not merely disappear from revision inventory. The existing lifecycle-fencing and tagged-maintenance work in `TODO.md` remains the safety prerequisite. Where maintenance is necessary, the independently verified restoration watchdog is mandatory; prefer avoiding downtime when quiescence is already proven.
2. **Make prerequisites reproducible and fail early.** Provision pinned deployment tools through repository setup; check tool availability, Docker readiness and scoped cloud access before an expensive build. The missing hosting-bucket permission and missing OpenTofu executable should be actionable preflight failures, not late surprises. Foundation permission changes stay separately administered.
3. **Make the release outcome durable and explicit.** Record the commit, accepted image identities/digest, generation, per-gate verdicts and fixture IDs in a token-free release artifact outside the agent workspace. Distinguish failed-before-apply, applied-but-unvalidated and validated. An explicit validation-only operation can reuse that record after verifying the serving deployment still matches; it must not rebuild/reapply or silently retry unexplained failures.
4. **Finish fixture ownership automation.** Successful lifecycle and identity fixtures should both be deleted and verified absent. Failed fixtures retain diagnostic evidence, with their IDs, cleanup failures and potential cost visible in the release result. Do not restore unconditional deletion on failure.
5. **Then provide one manually triggered external workflow.** A GitHub Actions entry point should call the same release command, run checks/E2E for the selected commit, use scoped OIDC, hold the existing global lock and publish the final result. It should not depend on this orb, its agent process or the web UI remaining alive. Keep one release implementation rather than a second YAML deployment algorithm. Automatic deployment on push remains a later policy choice in `docs/open-questions.md`, question 40.

The first useful milestone is “start one release and receive one trustworthy result,” not automatic production changes on every push. Do not add blind retries, a custom deployment service, another generation allocator alongside the current lock/clamp, or automatic migration rollback merely to label the process automated.

### Bootstrap checkpoint (2026-09-09)

The GitHub provider admits only the numeric repository/owner and manual `main`
workflow specified in `infra/foundation/github.tf`. The initial `Deploy`
workflow was deliberately authentication-only while application release safety
was implemented; the full transaction is now wired below but not yet live-validated. Run `34359863108` passed real keyless project and hosting-bucket
reads at commit `0502c53`; the same commit passed CI and E2E. The temporary
administrator login was then revoked and orb federation rechecked successfully.
Existing orb federation remains unchanged.

Tracked plan archives were confirmed to contain the live database credential;
see `docs/postmortems/2026-09-09-tracked-deployment-credentials.md`. CI rejects
tracked state/plan/credential artifacts, and Docker excludes them from build
contexts. Only structurally constructed token-free release records may be
uploaded. Deleting archives does not substitute for credential rotation.

**User decision (2026-09-09):** leave the exposed database password unchanged and
proceed with deployment work. Rotation and its independent recovery machinery are
not deployment prerequisites. This accepts the existing exposure; it does not
assert that the password was rotated or that historical copies are safe. Credential
redaction, artifact guards, protected database-plan checks and the other release
safety gates remain required. No credential probes or mutations are part of this
release work.

### Credential mutation safety (2026-09-09)

A disposable credential probe inherited the production ownership role and used
`RESET ROLE; ALTER ROLE CURRENT_USER PASSWORD NULL`, inadvertently clearing the
production password. Fifty browser authentication errors were observed; the
canonical secret restored connectivity, and the temporary login was removed.
Incident and exact times: `docs/postmortems/2026-09-09-credential-probe-role-reset.md`.

Destructive credential targets must be explicit, validated identifiers, never
ambient SQL role expressions. Experiments use disposable owner roles, not
production ownership. Any production credential mutation requires independently
armed recovery whose authority does not depend on this application's issuer,
and must execute the exact tested procedure. The original credential remains
exposed despite restoration. No rotation completion is claimed.

### Deferred credential-recovery proposal (2026-09-09; not implemented)

The proposed recovery authority is a separate GitHub Actions job using the
already-admitted GitHub identity, not an orb token or a database session. It must
remain usable when pi-orb's issuer or database authentication fails. The controller
and recovery job belong to one generation-checked release-lock transaction;
readiness and terminal outcomes are durable, token-free records, not shell traps.
A stale guard must not act on a later transaction.

Password changes use the Cloud SQL Admin API with explicit project, instance and
user identifiers. SQL password statements and ambient-role selectors are excluded.
Recovery reads the authoritative current credential from Secret Manager rather
than reviving a captured, subsequently retired password. The restore target and
secret identity require independent validation before any write.

The proposed cutover prepares a distinct login with the stable owner's privileges,
proves a fresh connection with the exact intended ownership identity before
publishing its URL, and retains the old working credential until all four service
roles have moved and old consumers have retired. Revocation is a separate explicit
final step; successful preparation is not successful rotation. The exact ownership
configuration, recovery handshake, cancellation behavior and retirement proof are
not yet qualified for production. Isolated tests must use disposable owner roles.
Acceptance and implementation work remain in `TODO.md`; this proposal does not
authorize another ad hoc production probe.

### Implemented release safety design (2026-09-09; application rollout not yet live-validated)

The external entry point reuses `infra/release.sh`. A read-only application plan,
ops access and retirement inventory precede expensive image builds. Google
provider `7.21.0` manages `iap_enabled = true` natively, eliminating the deliberate
out-of-band detach/repair window; exact IAP accessor reconciliation is retained.

The browser starts HTTP but waits before starting **all five autonomous loops**.
Its one-object GCS reader accepts only its exact generation from
`static-plane/releases/active.json`. Missing, malformed or unavailable authority
fails closed, and a process that observes a later generation never opens after a
subsequent regression. Pending/unavailable/superseded activation is visible in the
dashboard footer, with edge-only `lifecycle:` events. This is a startup barrier,
not a per-mutation lease. The supported release must establish retirement before
publishing authority; out-of-band deployments and late-side-effect compensation
remain distinct from this operational boundary.

Before apply, retirement inventory includes revision metadata and positive
Monitoring samples, so already-deleted live controllers are not invisible. After
apply and pruning, all pages are read and both active and idle states must have
explicit zero evidence after the recorded boundary. Newly observed old revisions
join the inventory. Previously recorded zero evidence can be reused, but newer
positive samples refute it. Pending pi-orb instance/disk/image operations also
block activation. The 75-minute operational cap permits natural Cloud Run
retirement without a UI pause (the observed incident took roughly 44 minutes);
time passing is never the proof. Failure leaves new loops gated and HTTP available.

A one-task, no-retry Cloud Run job runs migrations from the accepted image before
any new service consumes schema. Production browser startup no longer migrates;
local development still does. Migration filenames and outcomes are logged without
raw database errors. An uncertain job execution retains the global release lock
and job identity for inspection. Successful jobs are removed. There is no
automatic rollback of committed schema changes, nor a promise of compatibility
for arbitrary breaking runtime/schema changes.

`release_state.py` constructs and validates token-free records, including nested
allowlists, before publishing. It records source and runner commits, accepted
artifacts, all four serving image/revision identities, lifecycle generations
(the issuer deliberately has none), stage verdicts, retirement evidence and
fixture outcomes. Apply is conservatively marked unvalidated before invocation.
`--validate RELEASE_ID|latest` creates a new record referencing the original,
checks deployment identity, and runs only retirement/activation/validation—not
build, migrations or apply. The original failure is never rewritten into success.

Successful smoke fixtures are deleted and verified absent; failed fixtures remain
for diagnosis and cost accounting. Peer preview health is mandatory through the
already-owned minting orb's Tailscale daemon, not conditional on runner networking.
The release's federation leg uses this repository's existing admitted project and
shared deployer, exercising only read-only APIs. It creates/deletes its own two
orbs, never that shared project. This does not bootstrap the separate experimental
STS tier or add identity authority.

## Manual GitHub Actions deployment

**Implemented 2026-09-09; full application workflow not yet live-validated.**
`.github/workflows/deploy.yml` calls the authoritative `infra/release.sh`; it does
not duplicate the deployment algorithm. The first-release policy is recorded in
`docs/open-questions.md` (question 40).

The workflow checks out the dispatched SHA, verifies it is still `origin/main`,
and creates local branch `main` at that exact SHA before authentication. The shared
command repeats the freshness check. Node 24.6.0, SDK 583.0.0 and checksum-verified
OpenTofu 1.12.6 are pinned; actions use immutable SHAs, the runner is Ubuntu 24.04,
and provider lock files are read-only. The 240-minute job budget accommodates
checks, fresh native acceptance, migration/apply and up to 75 minutes of retirement.
The shared checks stage builds its own Docker E2E runtime image rather than relying
on a pre-existing runner cache. Checks do not inherit the release's result-directory
or fixture-recorder variables; only smoke receives the real fixture recorder.
The workflow `exec`s the release command for signal delivery, but hard cancellation
still requires evidence-backed inspection of remote work and lock ownership.
The first full run was cancelled in checks after discovering inherited test context
could corrupt local evidence; no application change occurred. The reproduction,
fix and exact-generation cleanup are in
`docs/postmortems/2026-09-09-release-test-environment.md`.
Registry access uses the same refreshing keyless
identity as deployment.

An empty `validate_release` input performs a release. An explicit release ID or
`latest` invokes validation-only recovery. Inputs enter through quoted environment
variables, never interpolated shell programs. `release_report.py` validates nested
record fields and the runner commit before exporting exactly `release.json`.
No diagnostic directory, state, plan, credential file or source bundle is uploaded.
The job summary distinguishes transaction failure from recorded gate success,
links durable evidence, and lists retained fixtures/costs. Failure before record
creation is explicit and never fabricates a successful deployment. A successful
transaction step without completed, validated release evidence fails the reporter
rather than producing a green workflow with a missing or unfinished record.

The shared command runs checks and full-slice E2E for the exact dispatched commit,
then preserves the release sequence as one serialized critical section:

1. build/seal the native Debian runtime and fixed-size workspace images on disposable GCE compute, and pass fresh-VM acceptance; build the `linux/amd64` control-plane container;
2. publish to the existing GCE image inventory and Artifact Registry repository, carrying exact VM/workspace image resources and numeric identities plus the immutable control-plane digest into the release;
3. hold the existing global release lock and clamp the generation, require the exact saved plan to preserve the database and its credentials, run migrations in a same-image no-retry job, then apply the saved plan against the GCS backend; retain only allowlisted evidence — binary plans and unsanitized JSON contain state secrets and must never be uploaded;
4. after any attempted apply, restore IAP with unconditional/finally semantics because OpenTofu can change the browser service and then fail; verify the serving revision and establish old-controller isolation before smoke. Revision deletion remains cleanup, not proof of quiescence. Any deliberate maintenance pause requires the independent restoration safeguard;
5. run `infra/smoke.sh`, including its load-bearing stop/start leg, and `infra/smoke-workload-identity.sh`. Record fixture IDs immediately; delete successful fixtures and poll to `404`. Retain failed fixtures for diagnosis and surface their ownership/cost and cleanup commands, rather than erase evidence.

The shared entry point separates IAP-only repair from revision pruning through `infra/deploy.sh --iap-only` and preserves its finally behavior. `infra/api.sh` keeps its bearer out of argv; ops URLs are passed directly. Successful smoke cleanup is verified; failure retains fixtures and reports their IDs rather than erasing diagnostic evidence.

Apply, IAP repair, old-revision deletion, and smoke must share one GitHub Actions concurrency group with in-progress cancellation disabled and the workflow must acquire the same GCS release lock used by `infra/release.sh`. OpenTofu's state lock covers only state mutation; the release lock serializes the shell-side repair and smoke work and makes the live-generation clamp safe across CI, manual releases, clock skew, and same-second runs. GitHub's concurrency group remains defense in depth and controls pending-run behavior: by default it coalesces older pending runs, implementing “deploy the newest eligible `main` state after the current deploy,” not a literal durable FIFO for every transient push. The current `queue: max` option can retain up to 100 pending runs, but GitHub orders them by when they begin waiting rather than by commit chronology and does not guarantee dispatch order; a strict chronological every-push policy therefore still needs an explicit ordering check/queue rather than an inaccurate workflow comment.

Authentication must be keyless: GitHub OIDC to a Google Workload Identity Federation provider, then short-lived service-account impersonation. Admission must be restricted by the repository's numeric GitHub IDs (repository `1307054237`, owner `61363`), `refs/heads/main`, the chosen workflow event (`workflow_dispatch` for the proposed manual entry point; `push` only if that policy is approved), and preferably the protected deployment environment subject; name-only trust is vulnerable to repository or owner-name reuse. The pool/provider and CI identities need a separately bootstrapped trust boundary so the recurring deploy does not depend on creating the identity it is currently using.

The initial proposal separated publisher, deployer and smoke identities. The implemented POC instead reuses the existing scoped deployer and admitted repository project, avoiding new authority or another identity bootstrap for recurring deployment. State access is high trust, not clerical: the current state contains the generated database password and complete connection URL. The foundation split now separately owns project APIs, stable IAM/admission and networking. The application root retains Cloud SQL, Secret Manager, Cloud Run and application-resource access policies, so its authority is still high trust. Generic Owner/Editor remains rejected; validate new permissions against real plans and Cloud Audit Logs.

Supply-chain requirements for the workflow: pin every third-party action by immutable commit SHA; pin the OpenTofu CLI and runner versions; use the committed OpenTofu lock files read-only during ordinary deploys; preserve the root `.dockerignore` exclusions for `.git`, generated credentials, state, plans, and unrelated workspace files; and retain digest/generation release metadata. Hosted GitHub runners are not tailnet members. The mandatory preview gate dials through the already-owned smoke orb's Tailscale daemon; it never skips because of runner networking.

Rollback cannot mean shifting traffic to an old Cloud Run revision because `infra/deploy.sh` deliberately deletes drained revisions. It is another forward deployment of retained last-known-good image digests with a newer generation, followed by the same repair and smoke sequence. Artifact Registry retention must guarantee those referenced digests survive. Automatic rollback is not proposed for releases containing database migrations or static-plane changes: migrations commit before any new service is applied, but old revisions can overlap the changed schema and a prior image may not understand it. Such a release needs explicit detection and approval/maintenance policy, a verified Cloud SQL recovery point, and a rehearsed forward-fix or migration-specific rollback runbook; the POC deliberately has no backwards-compatibility choreography.
