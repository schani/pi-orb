# Cloud deployment

Decisions and rationale for where pi-orb runs and how releases are made safe. Operator procedure, topology and gotchas: `infra/README.md`. Foundation bootstrap and grants: `infra/foundation/README.md`. Native image build: `infra/native-vm/README.md`.

## Platform

- One Cloud Run service, **`pi-orb-issuer`**, serves browser/API, runtime broker, files, discovery/JWKS and all background work. It runs as `pi-orb-control-plane`. Rejected: moving the app to a service named `pi-orb`; it would need a federation trust cutover (issuer, origins, callbacks, release targeting) with no product requirement.
- At least one instance stays provisioned with always-allocated CPU so active-orb history polling runs continuously; request-only CPU on a minimum instance is insufficient. Scaling is min = max = 1.
- Size is 2 vCPU / 4 GiB. Ingress 429s appeared at one vCPU under background CPU pressure: Cloud Run adaptive concurrency lowers admission, so configured concurrency is not serving capacity. Capacity reviews include CPU and ingress 429s, not only memory and instance counts (`docs/postmortems/2026-10-09-control-plane-cpu-429.md`).
- Request timeout is 3600 s; Cloud Run WebSockets behave as the architecture assumes at that timeout. No VM fallback.
- HTTP liveness probes request `/health` on port 8080 every 10 seconds with a 2-second timeout; three consecutive failures trigger a container restart. The Host header uses the canonical app host to pass host validation. The endpoint checks HTTP responsiveness without external dependencies; it cannot detect ingress-only failures. Startup remains protected by Cloud Run's TCP startup probe. Diagnose probe-triggered restarts in Cloud Logging's `run.googleapis.com/varlog/system` logs, scoped by revision and instance.
- Polling state and cursors live in PostgreSQL because Cloud Run may restart even the minimum instance; the loop recovers entirely from the database. Concurrent pollers are safe through an optimistic cursor compare-and-swap in the commit transaction; there is no polling lock or leader.
- Ingress is public with IAM invocation disabled; Google login and machine-token verification happen in the application (`docs/auth.md`). Sharing one service means public issuer handlers share control-plane privileges: reduced infrastructure isolation is intentional, not reduced authentication. Runtime bearers still fence each incarnation. Compute SSH stays behind IAP.
- Egress is private-ranges-only through the foundation-owned VPC.
- The control plane, runtime, protocol and web UI are TypeScript on Node.js 26.13.0 LTS (`docs/stack.md`).

## Origins and issuer

- The issuer is exactly `https://pi-orb-issuer-<project-number>.<region>.run.app`. App, API and broker use that origin; files use the `files` traffic-tag origin `https://files---pi-orb-issuer-<project-number>.<region>.run.app`. No aliases for earlier URLs.
- `PI_ORB_OIDC_ISSUER_URL` is computed by OpenTofu (`local.oidc_issuer_url` in `infra/oidc.tf`) from the deterministic Cloud Run URL, never supplied by an operator. A service cannot reference its own `.uri`, and one apply must not ship a minting image without its issuer identity.
- Cloud Run reports a hashed address in `.uri`; `.urls` holds both. The invariant is membership of the computed anchor in `.urls` plus the live discovery/JWKS gate, never equality with `.uri`. A postcondition fails the apply otherwise; changing the origin is a trust migration. Rejected: an operator-supplied variable (silent trust drift) and a two-phase apply (`docs/postmortems/2026-08-26-workload-identity-cloud-release-gates.md`).

## Infrastructure as code

- All infrastructure is code, managed with OpenTofu. Per-orb VMs and disks are runtime resources created by `GceOrbHostProvider`, never IaC.
- State lives in the versioned GCS bucket `pi-orb-tfstate-<project>`: prefix `static-plane` (application) and `foundation`. Never keep state in an ephemeral checkout, where it can be lost; `infra/imports.tf` records the adoption of resources that were created without remote state.
- **Foundation root** (`infra/foundation/`, grants: `infra/foundation/README.md`): project APIs, state bucket, Artifact Registry, service accounts, build/deploy/control-plane grants, workload-identity pools/providers, both VPCs, subnets and the private-services connection, and (where in scope) folder and billing. Applied only by a separate administrator: the recurring deployer must not control the trust policy that grants its own authority. Networks belong here because Compute IAM Conditions cannot isolate network, subnet or address names.
- **Application root** (`infra/`): the two application firewall rules, Cloud SQL, Secret Manager parents and runtime grants, hosting bucket, Cloud Run and other serving resources. It consumes explicit foundation outputs (the Cloud Run egress subnet is the project-qualified `projects/PROJECT/regions/REGION/subnetworks/NAME`). Releases refuse an unapplied or mismatched foundation.
- A new project needs variables, one audited foundation apply and the normal release. Irreducible external inputs: organization/folder/billing authority, a unique project ID and externally owned values (OAuth clients, secret payloads).
- Trust boundaries that the recurring plan uses are bootstrapped outside it and are never created, mutated or destroyed by that plan: `infra/bootstrap-pi-orb-oidc.sh` (federation tier for pi-orb's own issuer) and `infra/bootstrap-amp-oidc.sh` (the `pi-orb-debug` account and the deployer's Token Creator binding on it). Both are idempotent and delete nothing.
- Dependency updates may apply Google-provider state upgrades and Docker/containerd retained-configuration normalization through upstream conversions; no custom migrations. Reviewed plans and retained-store qualification remain required.

## Deployment identity

- Releases and project orbs share the scoped `pi-orb-amp-deployer` service account (historical name). No Owner/Editor: functional roles for application resources, conditioned `static-plane/` object access, read-only `foundation/` access, Token Creator only on `pi-orb-debug`.
- **GitHub Actions** authenticate keylessly via the foundation's GitHub provider, admitting only this repository's manually dispatched `main` Deploy workflow by numeric repository and owner IDs (`infra/foundation/README.md`). Name-only trust is rejected: names can be reused.
- **Project orbs** authenticate through pool `pi-orb-orbs`, provider `pi-orb-oidc`: issuer, audience `urn:pi-orb:gcp:<project>`, `token_use=exchanged` and the immutable pi-orb project ID; the binding is a `principalSet` on that project. `.pi-orb/gcp-external-account.json` is a non-secret executable-source config for `/usr/local/bin/pi-orb-gcp-identity`, registered by `.agents/resume` on every start (`docs/workload-identity.md`).
- This removes stored keys and renewable human logins, not privilege: any code in an admitted orb can obtain the deployer's short-lived authority, which can change application code and application-resource access policies. Re-review the role set when managed resource types change. Extra deployment permissions go on the shared service account in the foundation; never distribute personal logins or refresh tokens to make access persist (`docs/postmortems/2026-09-09-release-hosting-bucket-iam.md`).
- The Amp trust path (`amp-orbs` / `amp-oidc`) is an independently scoped access path; repository hooks do not configure it.

## Control-plane image

- The image builds from the repository-root context. PTY: after dependency install and patching, remove `node-pty` prebuilds and rebuild with `npm_config_nodedir=/usr/local` in a separate `RUN --network=none`; the official Node image supplies matching headers. Dependency-stage and final-image PTY spawn smokes are mandatory (`docs/postmortems/2026-10-15-control-plane-node-headers.md`).
- The image installs only control-plane dependency patches; runtime-only patches stay out (`docs/postmortems/2026-10-02-control-plane-patch-image-build.md`).
- **Startup diagnostics.** The default command preloads a builtin-only bootstrap with `--import`. Startup emits finite `control-plane-startup` JSON edges with an enumerated `phase` and monotonic `elapsed_ms` from module entry through migration, composition, route registration and listen. `complete` means the call returned, not that its Result succeeded. No environment values, URLs, error details or bodies; write failures are best-effort. Query: `jsonPayload.event="control-plane-startup"` on the exact revision. The migration job's command does not preload it. Motivation: a revision failed its TCP startup probe with an unknown blocker.

## Native runtime image

- Orbs boot a custom Debian GCE image (`docs/host-provider.md`); the control plane stays an OCI image. Releases carry the exact uniquely named VM and workspace image resources and numeric IDs plus the control-plane digest, alongside the host-spec generation.
- One repository command rebuilds, validates and reports an image with no manual SSH or remembered stages, independently of deployment (`docs/host-provider.md`, `infra/native-vm/README.md`).
- Builder/publishing permissions belong to the foundation; orb VMs never get publishing authority. The control plane only reads private images.
- Release image versions use `v-<short-commit>` so every hash is a valid GCE name segment.
- The remote native build and the local control-plane build run concurrently; nothing is pushed until both succeed and the native manifest passes provenance and acceptance. Failure or a handled signal terminates every owned child and waits for cleanup. Short npm children are not parallelized: killing npm does not kill its tool subprocess.

## Hosted-file storage

Storage belongs to the control plane, independent of `PI_ORB_HOST_PROVIDER`:

- `PI_ORB_HOSTING_STORE=filesystem` uses `PI_ORB_HOSTING_ROOT` (default `~/.pi-orb/hosting`). Preserve it alongside the database, outside orb workspaces. Multiple control planes need shared storage.
- `PI_ORB_HOSTING_STORE=gcs` uses `PI_ORB_HOSTING_BUCKET` with application-default credentials (bucket policy: `docs/http-exposure.md`).

`PI_ORB_HOSTING_ORIGIN` is the files origin; `PI_ORB_APP_ORIGIN` supplies dashboard links. Local defaults: `http://files.localhost:7100` and `http://127.0.0.1:7100` (`PORT` when set). `HOST` sets the listen address (default `0.0.0.0`). `PI_ORB_AUTH_MODE=local` supplies these defaults, the filesystem store and trust for Vite on 5173; Google mode requires the store kind and both origins, and GCS requires the bucket. Uploads use runtime bearers; private downloads use the files origin's session. Hosting contract: `docs/http-exposure.md`.

## Database

- Cloud SQL for PostgreSQL 17, chosen over AlloyDB because small configurations suffice and cost less. Private IP only, deletion protection, and automated backups with point-in-time recovery: the replica is the durable product history. Major upgrades are in place through the normal release and need pre/post backups and a maintenance outage; recovery to the old major restores the pre-upgrade backup to a **new** instance. An in-place upgrade can interrupt the serving application before rollout: an unchanged revision does not mean unchanged production (`docs/postmortems/2026-10-29-pg17-production-interruption.md`).
- The saved-plan guard rejects database and credential changes. Its only permitted instance change is `cloudsql.enable_pg_textsearch` absent/off → on, which must ship in a release before any migration that creates the extension (schema migration precedes apply).
- Destructive credential targets are explicit validated identifiers, never ambient SQL role expressions. Experiments use disposable owner roles. A production credential mutation needs independently armed recovery that does not depend on pi-orb's issuer, executing the exact tested procedure (`docs/postmortems/2026-09-09-credential-probe-role-reset.md`).
- The database password was exposed in tracked plan archives; the user chose not to rotate it. Rotation is not a deployment prerequisite (`docs/postmortems/2026-09-09-tracked-deployment-credentials.md`). Planned recovery authority, if rotation is ever done: a separate GitHub Actions job using Cloud SQL Admin API with explicit identifiers and the Secret Manager credential, inside the release-lock transaction; prepare a new login and retire the old only after all consumers move. Not implemented.

## Release transaction

`infra/release.sh` is the only release implementation; the Deploy workflow calls it rather than duplicating it. Stages: `checks`, `build`, `plan`, `schema`, `apply`, `repair`, `retire`, `activate`, `lifecycle`, `identity`, `complete` (plus `maintenance` before `schema` only with the one-time `--first-consolidation`).

- **Serialization.** A generation-matched GCS object `static-plane/release.lock` serializes the transaction across workstations and runners; a same-host lock fails earlier. OpenTofu's state lock covers only state mutation. Holding the lock, the release clamps the next generation above the serving revision, the active generation and any recorded retirement cutoff, including after failures. GitHub concurrency is defense in depth.
- **Early failure.** Tools, Docker, scoped cloud authority (including `python3 -m infra.release_preflight`), a read-only application plan, machine API access and retirement inventory are checked before expensive builds. A successful plan does not prove create permission (`docs/postmortems/2026-09-11-release-logging-exclusion-iam.md`).
- **Saved plan.** Exact temporary plan; database and credentials must be preserved. Plans and unsanitized JSON embed state secrets: `umask 077`, mode-0700 directory, deleted on exit, never uploaded. CI rejects tracked state/plan/credential artifacts and Docker excludes them.
- **Migrations** run once from the accepted image in a one-task, no-retry Cloud Run job before any new revision consumes schema. Default task deadline 600 s; `--migration-timeout-30m` (Deploy input `migration_timeout_30m`) allows 1800 s for one release and is refused with validation-only recovery. A longer task can block history writes longer. Production startup never migrates; local development does. Filenames, outcomes and validated SQLSTATE are logged, never raw errors. An uncertain execution retains the lock and job identity. Committed schema is never rolled back automatically.
- Migrations that lock several tables use NOWAIT attempts with bounded backoff and durable contention edges; blocking ordered exclusive locks still deadlock with inverse-order readers (`docs/postmortems/2026-10-13-history-migration-deadlock.md`).
- Deployment-only migration inputs (`PI_ORB_USER_ID`, `PI_ORB_ORIGINAL_*`) reach only the migration job, never check/build children (`docs/postmortems/2026-09-17-release-owner-environment-leak.md`).
- **Runtime/schema compatibility.** Supported old runtimes keep running briefly after a migration. Each changed write contract either accepts their writes with behavior-preserving defaults, or rejects incompatible writes at the boundary with a typed, durable, user-visible outcome before incomplete state is stored. The protection takes effect atomically with its migration. This covers behavior, not just decoding (`docs/postmortems/2026-09-17-typed-history-runtime-fence.md`). A global runtime stop is not a deployment requirement.
- **Apply and repair.** Apply the saved plan, then `infra/deploy.sh` reads fresh Cloud Run status, verifies the `files` tag routes 100% to the latest ready revision and deletes all other revisions. A resource postcondition cannot enforce the tag during first adoption, because the plan evaluates old `traffic_statuses`. Rollout readiness may fall back to a distinct, owned, Ready prior revision serving exactly 100% files traffic with matching image/env identity and active generation when the desired rollout is Ready=False with ConfigurationsReady=False/HealthCheckContainerError; post-apply readiness, retirement and activation stay strict.

### Activation and retirement

**Revision deletion is cleanup, not a fence.** Deleted revisions have kept making lifecycle decisions for minutes after deletion (`docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`, `docs/postmortems/2026-09-09-deleted-browser-reconciler.md`). Deletion, log silence and elapsed time never prove old-process retirement.

- **Activation barrier.** The application starts HTTP but holds autonomous loops until it reads its exact generation in `static-plane/releases/active.json` (the control-plane account can read only that object). Missing, malformed or unavailable authority fails closed; a process that saw a later generation never reopens after regression. Pending/unavailable/superseded activation shows in the dashboard footer, with edge-only `lifecycle:` events. The barrier does not stop HTTP writers.
- **Cooperative retirement.** After repair, the release writes `retireThroughGeneration` = new generation − 1 into `active.json` (generation-match precondition, preserving `generation`, `releaseId`, `activatedAt`). Writes refuse a cutoff that would retire the successor or regress authority. Every process checks the cutoff at startup and every 5 s after activation; at or below it, it exits the barrier without loops or runs the SIGTERM shutdown path, never reopening. Unavailable reads block initial activation but do not stop an active controller; edges `release-retirement-unavailable` / `release-retirement-recovered`.
- **Shutdown** stops HTTP admission and scheduling, terminates browser/terminal WebSockets without waiting for close acknowledgements, and closes streaming responses (tracked until the response closes, not the source stream). In-flight handlers, admitted reconciliations and signing-key repair join; agents drain through their close protocol; provider/database close last. Durable logs: `release-retirement-observed`, `control-plane-shutdown`, per-agent drain outcomes, `control-plane-drained`.
- **Independent proof** still gates activation. Before apply, inventory revision resources separately from observed processes. Process targets are revisions with unresolved positive Monitoring active/idle samples in a 15-minute lookback, including deleted revisions; queries filter on exact service **and** region (`docs/postmortems/2026-09-27-monitoring-retirement-filter.md`). A positive resolves only when the latest explicit active **and** idle samples are both zero; a missing state is unknown, and positives win ties.
- After apply and pruning, every inventoried resource must be absent; only the new serving revisions may survive, disjoint from the old inventory. Then observe at least 180 s (the instance metric samples every 60 s and can lag 120 s), rereading from 15 minutes before the boundary on every poll. Admitted targets need explicit zeros at or after the pre-apply boundary. Saved qualified zeros stay reusable when series disappear; newer positives invalidate them. Requiring fresh post-deletion emission from already-retired revisions is rejected: it can stall forever (`docs/postmortems/2026-10-06-consolidation-retirement-timeout.md`).
- Pending pi-orb instance/disk/image operations also block activation. Operational cap: 75 minutes; time never resolves a positive. Failure leaves loops gated and HTTP available.
- The record's `retirement` object holds `after`, `resources`, `resourcesRetired` (required for activation), `revisions`, `zeroes`, `excluded` (resolved candidates → latest active/idle zero timestamps, disjoint from `revisions`) and `operations`. A positive at or after a saved exclusion zero readmits the target. An empty process inventory is accepted only with completed resource-retirement checks.
- A deliberate maintenance pause requires a verified restoration watchdog independent of the agent and web UI, restoring scaling, files routing and access even when maintenance fails; refuse to pause without it. Not implemented; prefer proven natural shutdown.
- Rejected faster handovers: early activation and shorter arbitrary retirement timeouts (neither proves effects stopped); a lower request timeout (needs reconnect qualification, not a handover protocol).

### Records and recovery

- `infra/release_state.py` builds token-free, allowlist-validated records at `static-plane/releases/RELEASE_ID.json` with a `latest.json` pointer: source and runner commits, accepted artifacts, serving image/revision and generation, stage verdicts, retirement evidence, `qualification` and fixture outcomes. Outcomes: `failed-before-apply`, `applied-but-unvalidated` (apply is marked so before invocation), `validated`.
- `--validate RELEASE_ID|latest` creates a new record referencing the original after verifying the serving identity, and runs only revision pruning, retirement, activation and smokes; it never builds, migrates or applies, and never rewrites the original. It cannot supply missing infrastructure. Do not validate merely to obtain green.
- A client mutation failure does not prove server failure; a command timeout does not establish resource state. Reconcile by exact operation and resource identity and verify owned cleanup before another attempt (`docs/postmortems/2026-09-16-validator-cleanup-timeout.md`, `docs/postmortems/2026-10-24-native-image-capture-502.md`).

### Smokes and fixtures

- `infra/smoke.sh` (lifecycle, including its load-bearing stop/start) and `infra/smoke-workload-identity.sh` (identity, preview and federation; procedure: `infra/README.md`). Smokes create and delete their own orbs, never the shared project.
- Fixture IDs are recorded immediately. Success deletes and polls to 404 (accepted only from completed HTTP responses). Failure retains fixtures and reports IDs, cleanup commands and cost. Proven absence is never relabeled retained when record publication fails.
- Smoke operations (API calls, debug-token minting, GCE reads, IAP SSH, preview readiness, discovery/JWKS, STS, impersonation, fixture publication IO) share one bounded policy: ≤5 attempts, 1/2/4/8 s backoff, 30 s per attempt, 60 s per operation including auth, clipped by phase deadlines; `Retry-After` cannot extend it. Transient transport and HTTP 408/429/500/502/503/504 retry; `retryable:false`, credential, certificate, host-key, permanent DNS, malformed JSON and assertion failures never do; unknown DNS/proxy/TLS fails closed. Reads, fixed-UUID creates and fixture deletes may replay; Start/Stop and other mutations are single-shot. Fixture publication is one generation-fenced CAS under one 60 s deadline; 412 after a lost acknowledgement is a conflict. Logs keep operation, attempt, status class, delay, budget and decision; never tokens, URLs, bodies or raw errors. Auth failures record exit, elapsed and allowlisted stderr categories (`docs/postmortems/2026-10-19-lifecycle-smoke-auth.md`). Ordinary `infra/api.sh` calls do not retry.

## Qualification

- Releases need trusted same-repository `push`/`main` runs at the exact dispatched SHA: CI jobs `checks` and `control-plane-image`, E2E `E2E (1/4)`–`(4/4)`, and Durable qualification `Central process (1/4)`–`(4/4)` (`infra/ci_qualification.py`). One matching run per workflow, successful on its **first attempt**; a green rerun is refused — diagnose the first attempt and qualify a new commit. Missing, duplicate, foreign or unsuccessful jobs fail closed. Workflow job changes must update this inventory.
- The `qualify` job waits up to 60 minutes (65-minute job) before the lock; failed or cancelled runs block. `release.sh` re-verifies evidence and checkout before locking, then drops the token. Run/job identities go into the record's `qualification`. Local releases run checks and E2E themselves. Validation-only recovery skips new-source qualification.
- Reuse removes duplicate checks, not coverage: native acceptance and live gates stay mandatory. CI and test details: `docs/testing.md`.
- Open release-speed options: `docs/open-questions.md` (question 94).

## Rollout monitor

After a validated transaction, `infra/rollout_monitor.py` observes a fixed 900 s throttle window while watching other faults throughout, and starts its final query no earlier than 1090 s (900 + 10 s identity retry + 180 s ingestion), within a 25-minute step. It first verifies owner inventory and persists a partial artifact.

- Artifact `rollout-monitor-<run>-<attempt>` (always uploaded, 30 days) is separate from the authoritative record. It retains release/SHA/generation, health, revision/image/traffic/active-pointer checks, lock absence, owner fleet placement/state counts, SQL state and CPU/memory/disk/connections, and revision/region-scoped Run instances, memory and startup distributions. Instance count is not restart count.
- Logs are revision/region-scoped and export only classified counts: integrity/authority/drain/delivery failures, raw ERROR/HTTP 429 counts, independent ERRORs, recovered/unrecovered 429s, HTTP 5xx.
- A 429 is recovered only by native request logs from the same project/service/region/revision showing the same valid project-qualified trace and exact HTTPS id-token POST URL returning HTTP 200 within 10 s of the earliest throttle (`X-Cloud-Trace-Context`). A later same-orb success is insufficient. Unrecovered or uncorrelated 429s are regressions (`docs/postmortems/2026-10-19-observer-mint-floor.md`, `docs/postmortems/2026-10-13-rollout-monitor-anomalies.md`).
- Missing or nonnumeric required metrics, read failures, truncated or decreasing inventories are `incomplete`, never invented zeros. Unavailable samples keep their category and fixed message. No prompts, tokens, payloads or free-form errors.
- A regression requires review, not automatic rollback. A monitor failure leaves the validated record intact.

## Rollback and recovery

- Rollback is a new forward release of retained last-known-good image digests with a newer generation, through the same repair, retirement and smoke gates. Traffic cannot shift to old revisions: they are deleted. Artifact Registry and image retention must keep referenced digests.
- Prefer a qualified forward fix. Rollback needs a qualified CP/native/config/schema combination. No automatic SQL DOWN, database restore, history overwrite, user archival or old-controller revival. Backup/PITR readiness is not a rehearsed restore.
- Releases with migrations or static-plane changes never roll back automatically; they need explicit approval, a verified recovery point and a forward-fix or migration-specific runbook.
- Preserve failed release, lock and migration evidence.

## Central Pi

- Code-mode workers share one CPU budget (`docs/pi.md`). The managed Cloud Profiler agent cannot attribute worker CPU.
- Share the Actions run URL before cutover: a deploying Pi conversation may lose publication or compute.

## Workflow security

- Manual `workflow_dispatch` on `main` only; automatic deploy on push is open question 40. Empty `validate_release` releases; a release ID or `latest` validates. Inputs pass through quoted environment variables, never interpolated shell.
- The workflow checks out the immutable dispatched SHA, verifies it, creates local `main` at it before authentication, and `exec`s `release.sh` for signal delivery. Hard cancellation still requires evidence-backed inspection of remote work and the lock.
- Pinned: every action by commit SHA, `ubuntu-24.04`, Node 26.13.0, Cloud SDK 592.0.0 with its beta component (checksum-verified), OpenTofu 1.13.2 (checksum-verified). Provider lock files are read-only. Job budget 240 minutes.
- Checks do not inherit the release's result-directory or fixture-recorder variables; only smoke gets the real recorder (`docs/postmortems/2026-09-09-release-test-environment.md`).
- `infra/release_report.py` exports exactly one allowlisted `release.json`; no diagnostics, state, plans, credentials or source. A successful step without a completed validated record fails the reporter.
- The release job uses concurrency group `pi-orb-production-release` without in-progress cancellation. GitHub coalesces pending runs and does not guarantee commit order; a strict every-push policy would need its own ordering check.
- Preserve `.dockerignore` exclusions for `.git`, credentials, state, plans and unrelated files.

## Local control-plane service

`PI_ORB_WEB_DIST` is immutable for a process lifetime; static routes are enumerated at startup. Build into a separate unserved root, then drain and restart the control plane against it, keeping database and auth directories. Replacing `index.html` is not publication; verify referenced JS/CSS status, MIME types and real browser rendering. Never rebuild a live static root in place (`docs/postmortems/2026-10-04-claude-management-assets.md`, `docs/postmortems/2026-09-09-live-web-rebuild.md`).
