# Immutable compute replacement

Status: **decided 2026-08-12; both implementation stages completed locally 2026-08-12; release validation remains.** Stage 1 implementation and local deterministic coverage completed 2026-08-12: schema/store discard intent, atomic failure authorization revocation, diagnosis-before-discard with explicit unavailable evidence, shared disposal reconciliation and durable UI status, incarnation-carrying provider contracts and compute identities, Docker/GCE/process discard fences, persisted process-group disposal across provider restart, and bounded non-reusable per-incarnation Tailscale keys. Discard finalization preserves the failure `state_version` so explicit Start or a message wake admitted during cleanup survives until clean provision; archival can provision the advanced clean incarnation solely to seal retained history; durable cleanup-error recovery logs correctly after control-plane restart; dedicated discard/replacement failpoints and DST cover provider/store crash windows, concurrent disposal, lifecycle priority, one-shot retries, and at-most-one user-authorized replacement. A stateful deterministic Compute Engine model runs the real `GceOrbHostProvider` under DST for asynchronous operation polling, delayed deletion visibility, incarnation fencing, retained data disks, replacement around the same disk, and a zone operation completing after its caller process dies. A test-composition-only launch-failure seam and `infra/smoke-compute-replacement.sh` implement local and live acceptance. Stage 1 merged to `main` 2026-08-12 with both required E2E backends passing (Docker with real PostgreSQL, and process); the disposable live-GCE validation remains the one outstanding release gate. Stage 2 immutable host-spec replacement is implemented: providers calculate and stamp immutable fingerprints, the start path creates forward-only generation-fenced replacement intent, mixed-generation DST covers replacement rather than repair, and GCE in-place metadata/script repair has been removed. The process full-slice Stage 2 E2E passed 2026-08-12. Reviewed and hardened 2026-08-16: fingerprints go through one shared canonical hash, the zone/project exclusion and the GCE-only digest-pin assertion are decided and documented below, replacement requests preserve retained discard evidence, `expectedSpecFingerprint` is explicitly null-for-legacy, the transitional rollover stamp closes the one-deploy backward-repair hazard, the user-visible detail for a spec replacement is `replacing_stale_compute` rather than the failure banner, and the Stage 2 E2E/smoke legs gained compute-identity, single-identity, token-rotation, lifecycle-edge, and declined-generation assertions. `e2e/full-slice.e2e.test.ts` passed 4/4 on both backends on 2026-08-16 (process/PGlite 474 s; Docker with real PostgreSQL 523 s, including the declined-lower-generation step). The disposable live-GCE validation remains the outstanding release gate. Orb compute is immutable after creation: the control plane never repairs a VM/container/process incarnation in place. Stage 1: a terminally failed orb retains its authoritative workspace but disposes its compute; an explicit Start or queued-message wake provisions a clean incarnation on the retained workspace. Stage 2: a host-specification update replaces stopped compute on the orb's next Start instead of rewriting its startup script or image in place, and the GCE in-place repair machinery is removed.

Incidents: `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md` and `docs/postmortems/2026-08-12-spot-preemption-corrupt-entrypoint-layer.md`.

## Goal and invariant

A hard stop during Docker layer extraction can leave the COS boot disk structurally mountable while its extracted Docker layer contents are corrupt. Docker can then report the layer as `Already exists`, create the container from the expected digest, and crash before the runtime serves health. A normal stop/start and another `docker pull` reuse the poisoned cache.

The compute invariants are:

> A `failed` orb may retain authoritative workspace state, but it never retains or reuses the compute incarnation that observed or caused the failure.

> A compute incarnation is immutable. If the desired runtime image, startup script, host configuration, or host-specification fingerprint changes, the old incarnation is disposed and a new one is created around the retained workspace; it is never repaired in place.

“Compute incarnation” means disposable process/container/VM state. It does not mean the authoritative workspace:

- GCE: delete the instance and its `autoDelete: true` COS boot disk; retain `pi-orb-data-<orbId>` (`autoDelete: false`).
- Docker: remove the failed container; retain `pi-orb-data-<orbId>`.
- Process provider: terminate the runtime process and discard incarnation metadata/log handles; retain the workspace directory.

A replacement is not created merely because failure occurred. The orb remains `failed`, consumes no compute, and keeps its error visible. A later explicit Start or queued-message wake provisions a fresh incarnation and attaches/reuses the retained workspace.

This is a hygiene and recovery boundary, not a claim that every failure is host-local. A persistent repository error, replication-integrity failure, broken extension configuration, or bad runtime artifact may fail again on clean compute. That repeated failure is reported normally and causes the new incarnation to be disposed in turn; there is no autonomous reprovision loop.

An update does not bounce a healthy running orb. The currently running incarnation remains authoritative until an ordinary stop. On the next Start, reconciliation compares its committed host-specification fingerprint with the current desired fingerprint under the forward-only generation fence below, disposes the stopped stale incarnation, and creates the replacement. Same-spec ordinary stop/start may reuse its VM. An explicit future rolling-upgrade command is outside this plan.

## Product behavior

- Entering `failed` preserves `last_error`, replicated history, checkout/session metadata, queued messages, and the authoritative workspace.
- A deployment or configuration update never mutates a running or stopped incarnation. Running orbs continue undisturbed; stopped stale-spec compute is replaced on the next Start.
- Failed-host disposal runs without user action and is retryable after control-plane or provider failure.
- The UI continues to show `failed`. While disposal is pending or blocked, `stateDetail` says that failed compute is being discarded and, when blocked, shows a sanitized provider error. The original `last_error` remains unchanged.
- A spec replacement is routine maintenance, not an incident, and says so. When the retained discard fence carries reason `host_spec_changed`, the view synthesizes the distinct `replacing_stale_compute` detail — "Replacing compute for an updated host specification…" — instead of the failure-shaped discard banner, so a user watching an ordinary Start after a deploy sees a normal explanation rather than one that reads like something broke.
- An explicit Start may immediately return an orb in `starting`, but reconciliation must complete any pending failed-host disposal before auth, provision, or host start.
- A message admitted against the current failed `state_version` retains the existing one-shot wake semantics from `docs/lifecycle.md`; its resulting `starting` episode is subject to the same disposal gate.
- Stop, archive, and delete continue to outrank Start/wake. Permanent deletion still uses `OrbHostProvider.destroy` and removes the workspace; archival still uses deletion-grade resource cleanup after sealing history.
- Missing resources remain explicit. Failed-host cleanup never turns an orb into a missing orb and never redirects its URL.

## Why disposal is not `destroy`

The existing provider `destroy(orbId)` contract is deletion-grade: it removes compute **and authoritative storage**, and the Tailscale cleanup path removes the orb’s tailnet identity. Reusing it here would destroy the checkout and Pi session.

Add a separate provider operation with intentionally narrower authority:

```ts
discardCompute(
  task: SimulationTask,
  request: {
    orbId: string;
    throughIncarnation: number;
  },
  context: OperationContext,
): ResultAsync<void, OrbHostProviderError>;
```

`discardCompute` is idempotent and resolves only after every managed compute incarnation for that orb at or below `throughIncarnation` is definitively absent. It must preserve authoritative storage and Tailscale state. Uncertainty is an error; absence is success.

Provider mappings:

- **GCE:** list/verify exact orb ownership; delete matching instances at or below the incarnation fence, including the legacy un-suffixed instance name, which reads as incarnation 0; wait for each operation and verify absence. Instance deletion auto-deletes its boot disk and ephemeral NIC/IP. Never delete `pi-orb-data-<orbId>`. Cloud Logging remains subject to its independent retention policy.
- **Docker:** force-remove matching incarnation containers at or below the fence. Never remove the fixed workspace volume or shared images/networks. A replacement container is fresh even though the developer machine’s global Docker image store is outside per-orb ownership; the production cache-corruption incident class is specifically isolated by GCE’s replaced boot disk.
- **Process:** the durable host metadata records the launched child’s process-group ID, so absence stays verifiable after a control-plane restart that lost the in-memory child table. Discard terminates the recorded process group if it still exists, closes its incarnation log handles, and removes only ephemeral host metadata needed to launch that incarnation. Keep the per-orb workspace, Pi state, and Tailscale state. Provision recreates the ephemeral metadata.

The ordinary orphan sweep remains stop-only. It must not infer destructive authority from a `failed` row alone; the durable incarnation-bounded discard intent described below is the authority to delete compute.

## Durable replacement intent, incarnation fence, and host specification

A boolean “needs cleanup” is not enough. Provider deletion can complete after its initiating state episode, and two Cloud Run revisions can reconcile concurrently. A late cleanup request must be incapable of deleting the replacement it was meant to precede. Host identity and desired host specification are separate concepts:

- `host_incarnation` is a per-orb integer, incremented only when replacement compute will be created. It fences side effects and appears in compute names/labels.
- `host_spec_fingerprint` is the committed fingerprint of the immutable launch specification used for the current incarnation: exact runtime digest, generated startup contract, machine/boot-image/network settings, and other non-secret inputs whose change requires replacement.
- `host_spec_generation` is the deploy generation the provider was configured with when that fingerprint was committed. It reuses the existing strictly-increasing deploy-generation allocation (`-var deploy_generation`; see `docs/open-questions.md` question 40) and fences the replacement decision forward-only, exactly as it fenced script repair.
- the provider exposes a pure `desiredSpecFingerprint({ orbId, repositoryUrl })` calculation. It hashes the exact runtime digest, startup-contract version/rendered non-secret inputs, boot image, machine/network settings, and other effective host configuration. Every provider hashes through one shared canonical helper (`apps/control-plane/src/adapters/spec-fingerprint.ts`: recursively key-sorted JSON, SHA-256), because `JSON.stringify` follows insertion order and two revisions that build the same effective specification through different code paths would otherwise disagree and replace the whole fleet's compute for no reason. A deployment whose effective specification is unchanged produces the same fingerprint; any effective update produces a different one.

**Zone and project ID are deliberately excluded from the GCE fingerprint (decided and implemented 2026-08-16).** The persistent `pi-orb-data-<orbId>` disk is zonal. A replacement provisioned in a different zone could not attach it and would come up on a fresh, empty workspace — silently destroying the property the whole design exists to protect. Treating a zone or project change as a specification change would therefore convert an operator decision into automatic workspace loss on every affected orb's next Start. A zone or project move is an explicit operator migration, out of scope for this mechanism; nothing in the fingerprint makes one happen by itself.

**The digest-pin requirement is GCE-composition-enforced (decided and implemented 2026-08-16).** A moving image tag would change host contents without changing the fingerprint, so `apps/control-plane/src/main.ts` asserts `isDigestPinnedImage(runtimeImage)` for the GCE provider before any side effect — a composition failure, not a runtime surprise. Docker and process compositions are deliberately exempt: local development runs the mutable `pi-orb-runtime:dev` tag, and requiring a digest there would make every local rebuild a manual pinning step. The accepted, local-only consequence is that rebuilding that image does not change the fingerprint, so local compute is replaced when a *configured* launch input changes, not when the image content does. The E2E therefore drives its specification change through a configured input (`PI_ORB_E2E_HOST_SPEC`) rather than through an image rebuild, and always rebuilds the image anyway so a stale runtime can never be exercised.

Add a migration with these orb columns (names may be adjusted during implementation, semantics may not):

```text
host_incarnation                   integer not null default 0
host_spec_fingerprint              text null
host_spec_generation               bigint null
host_discard_through_incarnation   integer null
host_discard_reason                text null  -- failed | host_spec_changed
host_discard_error                 text null
host_discard_evidence              text null
host_discard_requested_at          timestamptz null
```

A PostgreSQL `integer` for the incarnation is intentional: it maps exactly to a TypeScript `number` and gives more than two billion incarnations per orb. Add non-negative/range checks; do not use a `bigint` that silently loses comparison precision in JavaScript. (`host_spec_generation` values are Unix-timestamp-sized and stay far below 2^53.)

Rules:

1. Every provision/start/discard request carries the expected incarnation; every provider resource and observation carries the same incarnation plus host-spec fingerprint, and observations report the actual incarnation-specific resource name rather than reconstructing a deterministic one (the Docker adapter used to rebuild the name from the orb label; Stage 1 switched it to the inspected container name). Existing unstamped resources are incarnation 0 with an unknown/stale fingerprint.
   `StartOrbHostRequest.expectedSpecFingerprint` is therefore `string | null`: the durable committed fingerprint, or **null for a legacy row that predates spec stamping**. Providers conflict on any stamp difference, and a null expectation matches only an unstamped resource — so legacy compute restarts in place until its next ordinary Start replaces it, while a null expectation can never be used to start a stamped incarnation whose specification nobody checked.
2. Every transition to `failed` atomically sets `host_discard_through_incarnation = host_incarnation`, reason `failed`, request time, and clears the previous discard error. It preserves `host_ref` as the resource to remove but **clears `runtime_token_hash` in the same transaction**, so changing the state to `starting` cannot reauthorize the failed runtime through the broker.
3. Only the ordinary start path compares specifications. When a `starting` orb has compute, its committed fingerprint differs from `desiredSpecFingerprint`, and the provider’s configured deploy generation is greater than or equal to the committed `host_spec_generation`, one CAS creates the same discard intent with reason `host_spec_changed` and clears the old runtime token. A lower configured generation — a draining stale revision — declines with one edge and starts the existing compute unchanged, so a stale revision can never replace newer-spec compute backward. `stopped` and `running` orbs are never evaluated, so a deploy neither sweeps the stopped fleet nor bounces running orbs. No update rewrites instance metadata, startup script, or image in place. A `host_spec_changed` request **preserves whatever `host_discard_evidence` is already retained** rather than clearing it: a spec replacement is not an incident and has no evidence of its own, so overwriting the retained evidence would erase the last failure's forensics for a routine deploy. That evidence is cleared exactly once, when replacement provision commits (rule 6), because from then on it could only shadow a later unrelated incident.
4. `discardCompute(orbId, throughIncarnation)` may delete only resources whose exact orb identity matches and whose incarnation is less than or equal to the durable fence. It must never delete a later incarnation.
5. After the provider verifies absence, one CAS store operation clears `host_ref`, the committed fingerprint/generation, discard fence/reason/error/request time, and advances `host_incarnation` above the disposed range. It retains bounded `host_discard_evidence` until replacement succeeds or a later failure supersedes it.
6. New provision uses the advanced incarnation and current desired fingerprint, then commits the new host ref/token hash/fingerprint/generation through the existing CAS path.
7. An ordinary same-fingerprint stop/start can reuse its stopped incarnation. A healthy running orb is never replaced merely because the desired fingerprint changed; the comparison runs only after it enters the ordinary start path.

Incarnation is reflected in compute identity so a delayed delete-by-name cannot hit a replacement after name reuse. GCE instance names become incarnation-specific (for example `pi-orb-<orbId>-i<incarnation>`); the persistent data-disk name remains `pi-orb-data-<orbId>`. Both keep the `pi-orb-` prefix that the deployment’s IAM conditions scope compute mutations to (`infra/iam.tf`). Docker/process incarnation identities follow the same rule while workspace identity remains fixed.

This is a direct breaking change to the internal host contract, consistent with the project’s POC policy. Do not add dual-read naming or long-lived compatibility phases. The first replacement removes an unstamped legacy resource by exact orb ownership before incarnation 1 can provision.

The GCE `ensureCurrentScript`/metadata-repair machinery is removed. `provision` and `start` verify immutable incarnation and fingerprint stamps; mismatch returns a typed conflict requiring the durable replacement path, never `setMetadata` plus restart. The `repaired` outcome disappears; the deploy generation itself survives as the committed `host_spec_generation` and the forward-only replacement fence above, renamed end to end from `PI_ORB_SCRIPT_GENERATION`/`scriptGeneration` to `PI_ORB_HOST_SPEC_GENERATION`/`specGeneration` because it no longer fences a script write.

### Rollover (transitional, 2026-08-16)

The one deploy that removes in-place repair has a hazard the fence above cannot close, because the fence lives in the *new* code. Cloud Run drains a revision for 12+ minutes (`docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`), so during that window the pre-Stage-2 revision is still reconciling with `ensureCurrentScript`. That code compares `pi-orb-script-generation` and treats a missing or unparseable stamp as generation 0 — the lowest — precisely so it would repair *older* hosts forward. A brand-new instance created by the new code carries no such stamp, so the draining old revision would read it as ancient, stop it, rewrite its startup script in place, and start it again: the exact repair-war class this design exists to end, aimed backward at compute the new code just created.

The closing move is a transitional stamp. New GCE instances still carry `pi-orb-script-generation` set to the current deploy generation. Nothing in the new code reads it back — provision, start, and the replacement decision all read `pi-orb-host-spec-fingerprint` and the durable `host_spec_generation` — so it is inert except as something for the draining revision to compare against, which makes that revision see the future and leave the instance entirely alone. It is a one-window compatibility shim, deliberately the kind of machinery the POC policy otherwise forbids, and it earns the exception because the alternative is a known incident class rather than a hypothetical one. Removing it once no revision containing in-place repair can drain is tracked in `TODO.md`.

## Lifecycle ordering

### Entering failure

Refactor all terminal-failure paths to follow one order:

1. Collect the best evidence available at the decision point and format the typed `last_error`.
2. CAS the orb to `failed`, clear its runtime-token hash, and create the incarnation-bounded discard intent in the same transaction.
3. Log the terminal transition and discard request.
4. Clear episode-local control state and wake reconciliation.
5. Let shared replacement-intent reconciliation own compute disposal.

Do not stop the host before committing failure intent. The existing replication-integrity path already demonstrates why durable state must win first: another reconciler can otherwise observe a stopped host and commit a clean state that loses the failure. Removing the current best-effort stop-before-fail split also gives one crash-recoverable disposal owner.

Every way of reaching `failed` must use this operation: readiness deadline, `runtime_never_answered`, runtime-reported failure, identity mismatch, non-retryable provider error, `auth_failed` device-login failure, unrecoverable drain, and replication integrity. An orb that fails with no compute yet (the auth cohort can) still gets the fence: discard of nothing verifies absence trivially and still rotates the incarnation.

### Reconciling replacement intent in every state

At the top of `reconcileOrbOnce`, before normal state dispatch, run one shared replacement-intent routine for `failed`, `starting`, `stopping`, `stopped`, and `archiving`. `deleting` alone supersedes it because deletion-grade cleanup removes compute and workspace. Archival first finishes any discard, then applies the same immutable-spec gate before provisioning a clean runtime to seal history. No state can park indefinitely with a discard fence and reusable failed/stale compute.

1. If a discard fence exists, collect bounded sanitized diagnosis when not already present, then call `discardCompute` through the provider deadline wrapper.
2. On failure, persist a sanitized `host_discard_error`, emit one edge, retain the current lifecycle state/intent, and retry through the ordinary scheduler. A nominally non-retryable adapter response remains durable and visible rather than silently abandoning cleanup; a later configuration/deploy repair may make another pass succeed.
3. On recovery after an error, emit one recovered edge.
4. On verified absence, CAS-finalize discard and advance the incarnation.
5. Continue according to the current state: `failed` waits or evaluates a current-failure message wake; `starting` proceeds to clean provision; `stopping`/`stopped` converge to `stopped` with no compute. A Stop racing replacement cancels wake intent but cannot cancel required disposal or preserve the invalid incarnation.

A normally stopped same-spec orb has no discard intent and retains reusable compute. An update creates the intent only when that orb next enters `starting`.

### Starting after failure or update

`failed -> starting` remains the public transition for explicit Start and current-version queued-message wake. It preserves any discard fence. At the top of `reconcileCreateStart`, before authentication, provision, observe, or start:

1. Finish any existing discard intent through the shared routine.
2. If compute remains, `host_spec_fingerprint !== desiredSpecFingerprint`, and the configured deploy generation is not lower than the committed one, atomically request `host_spec_changed` disposal, clear its token, and return `waiting("stale_compute_disposal")`. A lower configured generation declines with one edge and continues with the existing compute.
3. Provision only after the store records old incarnations absent and advances `host_incarnation`.
4. If compute remains with the same fingerprint, ordinary start-in-place is allowed.

Therefore Start cannot adopt or start failed/stale compute. A queued message retains exactly one boot attempt: disposal is preparation for that attempt, not an additional attempt.

### Races and authority

The incarnation fence makes a late provider call harmless: names are incarnation-specific and `discardCompute` refuses anything above its fence, so a delayed delete cannot reach a replacement even after a crash or a slow provider operation.

The one *decision* this plan adds that concurrent control-plane revisions can disagree about is the desired host specification. That disagreement is closed by the forward-only `host_spec_generation` fence in rule 3 — the same mechanism that ended the 2026-08-06 repair war, now fencing replacement instead of repair: a draining stale revision declines and the surviving revision replaces forward on its next start pass. Failure-driven disposal carries no such disagreement: every revision agrees that fenced compute must go, and disposal plus finalization are idempotent CAS store operations, so two current reconcilers converge without provisioning early.

What remains is the pre-existing authority class: a stale revision can still start hosts, run boot detection, and make terminal transitions at full authority (`docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`). This plan deliberately does not gate on the durable active-generation/lease work that closes that class (`TODO.md`); the one way this plan enlarges a stale wrong decision — a mistaken terminal transition now discards a boot disk instead of merely stopping it — is bounded to state that is disposable by design, because `discardCompute` cannot touch the workspace. Within its own paths the plan still:

- re-checks durable lifecycle state immediately before requesting discard, calling `discardCompute`, starting/provisioning compute, making terminal transitions, and finalizing discard;
- keeps provider operations bounded and passes their incarnation fence explicitly;
- treats a CAS conflict after an external side effect as a reason to re-read and reconcile, never as permission to clear a newer intent;
- treats a non-retryable provision *conflict* the same way (added 2026-08-16): the revision that loses a provision race receives the winner's typed conflict while the winner's commit may not have landed yet, so the loser's `state_version` CAS could still succeed — routing that conflict into `failOrb` would terminally fail the orb and discard the winner's fresh compute during an ordinary rollover. A racing conflict re-reads; only non-conflict permanent provider errors fail the orb. Covered by the create-race scenario in the mixed-generation DST;
- uses incarnation-specific compute names so delayed GCE deletion cannot target a replacement by reused name.

No cleanup path may delete by substring, by stale `host_ref` alone, or without exact provider ownership and incarnation checks.

## Credentials and Tailscale

Failure and update-replacement intents clear the old runtime-token hash atomically. Broker authorization also rejects any orb carrying a non-null discard fence regardless of lifecycle state. Replacement provision mints a new token and commits its hash using the existing read-back/CAS model; no old incarnation is reauthorized during `failed -> starting`.

Tailscale daemon state lives on the retained workspace, so a replacement resumes the same device identity; the device record is non-ephemeral and survives compute disposal. An auth key delivered through instance metadata dies with its VM, so each newly provisioned incarnation gets a fresh non-reusable, pre-authorized key whose description names the exact orb ID and incarnation. Before minting, the adapter revokes every earlier exact-orb key — matching both the legacy `pi-orb <orbId>` description and the incarnation-suffixed form — and serializes revoke/mint/cleanup per orb within the adapter process, so concurrent local provisioners cannot leave two unconsumed keys. Retained state normally resumes the existing node without consuming the key; a lost or corrupt state consumes the current key to re-register. Revocation is idempotent, retryable, and incarnation-fenced; a mint failure remains a retryable provider error. Port exposure stays optional: a replacement that never joins the tailnet still has its keys bounded by the next mint or by archive/delete, which removes every exact-orb key and device as today (`docs/orb-deletion.md`).

Deliberately out of scope: detecting and deleting the duplicate device record left behind when a state-loss re-registration creates a second exact-hostname node. Doing that safely needs the runtime to report its stable node ID — a protocol extension guarding a rare corner — so both devices simply remain until permanent archive/delete. Tracked in `TODO.md`.

Adapter tests must assert bounded keys and an untouched device record across replacement — including a replacement that fails before readiness, whose unconsumed key the next mint revokes. Live tailnet validation remains with the deletion live smoke in `TODO.md`.

## Observability

The incident must be reconstructable after the VM is gone. Add lifecycle edges:

```text
lifecycle: orb=<id> compute-discard-requested host=<ref> through_incarnation=<n> reason=<failed|host_spec_changed> failure_code=<code?>
lifecycle: orb=<id> compute-discard host=<ref> through_incarnation=<n> outcome=ok evidence="..."
lifecycle: orb=<id> compute-discard host=<ref> through_incarnation=<n> outcome=error error="..." evidence="..."
lifecycle: orb=<id> compute-discard-recovered through_incarnation=<n>
lifecycle: orb=<id> replacement-provisioned host=<new-ref> incarnation=<n> spec=<fingerprint-prefix>
lifecycle: orb=<id> spec-replacement-declined committed_generation=<g> configured_generation=<g'>
```

The declined edge exists because a guard that declines silently is invisible at exactly the moment someone asks why an update did not arrive; like other persisting conditions it logs once per episode, not per pass. Noise remains edges-only: do not log every retry or every pass that sees pending cleanup. Preserve original failure evidence in `last_error`; cleanup errors and bounded sanitized host evidence live separately in the durable discard columns. `stateDetail` derives from those columns so a control-plane restart does not make user-visible cleanup status disappear — including the `replacing_stale_compute` detail above, which is the user-facing half of the same durable fact the `compute-discard-requested reason=host_spec_changed` edge is the operator-facing half of.

Disposal deliberately trades away post-hoc host forensics. The 2026-08-06 root cause was proven by inspecting the still-existing VM’s filesystem; after this plan that VM is gone. The compensation is capturing evidence before deletion: the terminal decision folds `diagnose` output — container status, restart count, last exit code — into the typed `last_error`, and before deleting GCE compute the routine calls the existing best-effort `diagnose` path when the terminal failure did not already capture host evidence, persisting its sanitized, size-bounded result in `host_discard_evidence` before provider deletion and including it in the one discard outcome edge. Diagnosis failure is persisted as unavailable evidence but must not block disposal. Container stdout/stderr already ships to Cloud Logging and outlives the VM; guest attributes needed for the product/operator explanation no longer disappear solely with the instance. The 2026-08-12 incident was root-caused entirely from these channels without touching the host, which is the bar this section maintains.

## Implementation stages

**Stage 1 — failed-compute disposal.** Independently shippable; addresses both incidents.

1. **Schema/store contract**
   - Add the incarnation/spec/discard columns and row mapping.
   - Add the atomic fail-and-request-discard operation; it clears runtime authorization.
   - Add CAS operations to persist evidence/errors and finalize verified disposal/advance incarnation.
   - Make explicit/queued-message starts and stop transitions preserve the fence.
   - Add migration and PostgreSQL/PGlite/fake-store contract coverage.
2. **Provider contract**
   - Add incarnation fields to provision/start/discard requests, results/observations, labels/metadata, and compute names; observations report actual incarnation-specific names.
   - Implement idempotent `discardCompute` for GCE, Docker, and process providers; the process provider persists the launch process-group ID so absence is verifiable after a control-plane restart.
   - Add the stateful deterministic GCE model behind `GceApiTransport` (below) and compose the real GCE adapter into DST worlds for the discard/fence scenarios.
   - Keep `destroy` deletion-grade, but update it to enumerate and remove every exact-orb incarnation — including legacy unstamped names — before deleting authoritative storage.
   - Verify GCE discard deletes the instance/auto-delete boot disk but never the persistent data disk.
3. **Lifecycle integration**
   - Route every terminal failure through the atomic store operation and remove stop-before-fail behavior.
   - Run one shared disposal gate in failed/starting/stopping/stopped and before archival recovery.
   - Preserve one-shot inbox wake and stop/delete/archive priority.
   - Surface durable user detail and edge logs.
4. **Credentials and Tailscale**
   - Fence broker authorization on discard intent and mint a fresh runtime token only for committed replacement compute.
   - Implement per-incarnation non-reusable auth keys with revoke-before-mint across both description formats.

**Stage 2 — host-spec replacement (implemented locally 2026-08-12).**

5. **Immutable specification**
   - Add the pure orb-specific `desiredSpecFingerprint` calculation with the digest-pinned-image assertion; commit fingerprint plus deploy generation on provision.
   - Add the forward-only-fenced `host_spec_changed` intent in the start path with the declined edge.
   - Remove GCE `ensureCurrentScript`, `setMetadata` repair, and all `repaired` outcomes; a mismatch is a typed replacement requirement. The `pi-orb-script-generation` stamp is still *written* — and never read — for the one rollover window (see "Rollover" above); its removal is tracked in `TODO.md`.
   - Extend the mixed-generation DST from repair fencing to replacement fencing.

**Release validation (both stages)**

- Run unit, store-contract, provider, DST, lint, and typecheck suites.
- Run both required E2E backends below; this changes runtime boot/recovery and therefore requires `npm run test:e2e` under `AGENTS.md`.
- Perform the scripted disposable live GCE validation before deployment completion.

## Deterministic and adapter verification

Add named deterministic checkpoints at the exact crash boundaries:

```text
compute-replacement.failure-intent-committed
compute-replacement.discard-before-provider
compute-replacement.discard-after-provider
compute-replacement.discard-before-finalize
compute-replacement.discard-finalized
compute-replacement.replacement-before-provision
compute-replacement.replacement-after-provision
compute-replacement.replacement-before-commit
compute-replacement.replacement-committed
```

Add one-shot failpoints for provider discard, evidence persistence, discard finalization, replacement provision, and replacement commit. Tailscale is outside the DST world, so key-revocation failure is covered at the adapter layer instead: scripted-transport tests assert that a failed revoke aborts the mint and stays retryable. Process death at a checkpoint is exercised by driving the machine to the durable state that crash leaves behind and restarting the control plane there; adjacent checkpoints that share a durable state share one crash window. DST failures retain their first `determined` trace under `test-failures/` and must be replayed with `DST_REPLAY` before changes; never rerun merely to obtain green.

**Deterministic GCE model (initial implementation landed 2026-08-12).** The incarnation fence and exact-ownership checks are enforced *inside* each provider adapter, so DST scenarios that assert them execute the real adapter, not a fake’s reimplementation of the rule. The generic `FakeOrbHostProvider` world remains the default for lifecycle scenarios, but the discard/fence scenarios additionally compose the real `GceOrbHostProvider` over a stateful deterministic GCE model implementing the existing `GceApiTransport` seam. Both enablers already exist: the adapter runs on `SimulationTask` (its `waitOperation` polling sleeps through the simulated clock) and all HTTP passes through that one transport interface. The model keeps instances and disks with labels/metadata, completes zone operations asynchronously across later polls, returns 409 on duplicate insert, filters list by label, and models an operation completing after its caller’s process died plus delayed deletion visibility. Injectable preemption/fault controls beyond those first scenarios remain to be added with the rest of the matrix. The modeled surface is deliberately small: instance get/insert/delete/start/stop, disk get/insert/delete, operation wait, guest attributes, label-filtered list. The existing scripted-response transport tests remain only for exact wire-shape assertions; real API behavior drift stays the live GCE validation’s job, which is why that leg is mandatory.

Required DST scenarios:

- failure commits discard intent and clears token authorization before any provider deletion;
- process death at every named checkpoint resumes from durable state;
- instance deletion succeeds but store finalization fails, then retries verified absence safely;
- disposal error/evidence persist without replacing the original orb error and recovery logs once;
- a crash-looping host’s diagnose evidence (status, restart count, last exit code) reaches the typed `last_error` and `host_discard_evidence` at the terminal decision;
- explicit Start races cleanup and cannot provision/start until the fence clears;
- queued-message wake has the same gate and remains one-shot after another failed boot;
- Stop during failed/stale replacement finishes discard and converges to stopped with no compute;
- delete and archive racing replacement retain their priority and storage semantics;
- two current reconcilers call idempotent disposal without provisioning early;
- an old-incarnation disposal completes after a newer incarnation exists and cannot delete it;
- a lower-generation reconciler declines spec replacement with one edge, cannot discard or replace newer-generation compute, and the surviving revision replaces forward on its next start pass (mixed-generation DST extended from repair to replacement);
- failures originating in creating, starting, running, stopping, and replication integrity all create cleanup intent, including `auth_failed` with no compute yet;
- a host-spec change leaves a running orb untouched, replaces it on its next Start, and same-spec stop/start reuses it;
- repeated deterministic runtime failure creates at most one incarnation per user-authorized start, never an autonomous loop;
- old runtime authorization stays rejected throughout replacement and the new token works only after commit;
- Tailscale key revocation failure is bounded/retryable and at most one unconsumed exact-orb key exists;
- invariants: workspace identity never changes, at most one live compute incarnation exists, and no incarnation at or below a cleared discard fence remains;
- the discard/fence scenarios above run additionally with the real GCE adapter composed over the deterministic GCE model, including a zone operation that completes after a control-plane crash and a delete whose absence becomes visible only on a later poll.

Provider tests (the GCE ones run against the deterministic model wherever state or interleaving matters; scripted transports cover wire shapes only):

- GCE deletes all exact-match instances through the fence — including the legacy un-suffixed name — waits for operations, preserves the labeled data disk, rejects ownership mismatch, and treats absence/repetition as success;
- GCE ignores a higher-incarnation instance even if another field/name is similar;
- GCE provision/start never rewrites metadata on fingerprint mismatch;
- Docker removes incarnation containers, retains the workspace volume, and reports the actual incarnation-specific container name in observations;
- process mode kills the recorded process group — including after a provider restart with no in-memory child — and retains workspace/session files;
- Tailscale bounds exact-orb keys across incarnations and never touches the device record;
- full `destroy` still removes compute, workspace, keys, and devices for archive/delete.

### Local E2E

The test-only runtime launch seam is enabled solely by the E2E composition environment, not a production route or API. A workspace marker selects one exact orb/incarnation, exposes a typed terminal runtime failure, and durably records the injected event; the marker remains armed for that incarnation so process/container restart cannot heal suspect compute in place, while later incarnations launch normally. Tests wait on API state, durable store fields, provider inventory, and lifecycle edges. Exactly two deliberate elapsed-time waits exist, both of them negative assertions with no completion signal to wait on: the 65-second window proving a failed orb is not autonomously reprovisioned (more than two terminal-backstop intervals), and a 5-second window in the Stage 2 leg proving a deployed specification change leaves a *running* orb's compute untouched. Everything else is a bounded predicate wait that dumps the orb row, provider inventory, and control-plane log tail on first timeout. The composition always rebuilds `pi-orb-runtime:dev` before running (a warm cache makes it seconds), so the suite can never silently exercise a stale runtime image.

"Untouched" is asserted on the compute *identity*, not the incarnation number: the Docker container ID, and on the process backend the recorded process-group leader plus loopback port. An in-place bounce that relaunches the same incarnation would leave the number unchanged and is exactly the mutation this design forbids, so an incarnation-only assertion would pass through it. The identity is compared while the orb is running on both backends, and additionally across the stop on Docker, where a stopped container keeps its ID; the process provider deliberately clears the recorded process group when the child exits, so a stopped process host has no live identity left to compare and its stale-compute check is the incarnation plus the surviving metadata.

Run both real backends:

```bash
npm run test:e2e
PI_ORB_E2E_BACKEND=process npm run test:e2e
```

Acceptance sequence:

1. Create an orb, reach ready, write a unique sentinel, and commit session/history.
2. Arm the one-incarnation launch failure and perform an ordinary stop/start.
3. Wait for typed `failed`, verified compute absence, cleared old token authorization, and a completed discard fence; assert the row/history/workspace remain.
4. Observe two terminal-backstop intervals (65 seconds total) with no replacement-provisioned event or compute, proving failure does not autonomously reprovision.
5. Explicitly Start or send against the current failure.
6. Assert a higher incarnation reaches ready, sentinel/session/history survive, token changes, and exactly one compute identity exists.
7. Separately change the desired test host-spec fingerprint on a healthy running orb, observe the 5-second window with its compute identity unchanged, then stop/start and assert replacement rather than repair: incarnation 1 with a new compute identity and a rotated runtime token, the workspace sentinel intact, exactly one compute identity for the orb, and the durable edges `compute-discard-requested … reason=host_spec_changed` followed by `replacement-provisioned … incarnation=1`.

   The two backends prove different halves of the fence, because they change the specification differently. The **process** leg changes one effective launch input in place via the E2E-only `SIGHUP` seam — the control plane cannot be restarted there without terminating its own child compute — so it proves replacement at an *equal* deploy generation, which is also what local development runs at forever. The **docker** leg restarts the control plane at a *higher* generation, proving forward replacement across a revision boundary, and then adds the case that has no equal-generation analogue: a restart at a *lower* generation with yet another specification must decline. That declined start must reach `running` on the existing incarnation with an unchanged compute identity, log one `spec-replacement-declined` edge, and request no discard at all.

Every bounded wait prints current orb row, provider inventory, and lifecycle edges on first timeout; a timeout is a failure to root-cause, never grounds for rerun or extension.

### Live GCE validation

`infra/smoke-compute-replacement.sh` owns one disposable project/orb and cleans it through the normal delete API on every exit. When `PI_ORB_SMOKE_STAGE2_DEPLOY_COMMAND` is supplied, it also requires that command to deploy a higher-generation changed specification, proves the running instance is untouched, then proves stop/start replaces it around the same disk with a different fingerprint. It arms the same test-composition-only launch-failure marker the E2E uses, delivered onto the retained `/workspace` disk over `gcloud compute ssh` with base64-encoded contents so no shell-quoting layer can corrupt the sentinel or the marker JSON. The validation deployment must therefore run with `PI_ORB_E2E_LAUNCH_FAILURE_MARKER` configured; the seam stays inert in deployments without it.

1. Create a healthy disposable orb, assert its instance is `pi-orb-<orbId>-i0`, write a workspace sentinel, and record the instance ID, boot-disk name, persistent data-disk name, and the incarnation-0 runtime token from instance metadata.
2. Arm the incarnation-0 marker on `/workspace` and stop/start the orb normally.
3. Wait, predicate-based, for the typed failed state and exact GCE inventory absence: original instance and boot disk absent, persistent disk still present, and the old runtime token answered 401 by the broker. Observe the explicit 65-second negative window with no replacement instance and the orb still failed.
4. Explicitly Start. Wait for ready and assert `pi-orb-<orbId>-i1` with a different instance ID and boot disk, the same attached persistent disk, the intact sentinel, a different runtime token, exactly one instance, and the old instance still absent.
5. (Stage 2) Deploy a different desired host-spec fingerprint under a higher deploy generation. Observe a second explicit 65-second window in which the running orb keeps its state, its single instance name, and — checked at both ends of the window — its numeric instance ID, so a same-named recreation inside the window cannot pass. Then stop/start and prove a second replacement: instance `pi-orb-<orbId>-i2` with a different instance ID, a different boot disk, a different spec stamp, the same attached data disk, the sentinel intact, and the incarnation-1 instance absent. The script does not claim to observe "no repair event": the new code contains no repair path to emit one, so what is provable — and what is asserted — is that the identity changed rather than being mutated in place.

Per-step deadlines are named variables derived from one documented outer budget; the two 65-second negative windows are the only deliberate elapsed-time assertions. The script preserves first-failure logs under `test-failures/` and exits nonzero without retrying. Bounded Tailscale keys and device survival across replacement are asserted by the adapter tests; live tailnet validation remains with the deletion live smoke in `TODO.md`.

## Rejected alternatives

- **Restart every failed VM in place.** Reuses the cache that this design treats as untrusted; rejected by both Docker-cache incidents.
- **Repair a stale VM in place by rewriting metadata/startup script.** Makes a mutable host whose resulting specification depends on repair races and stale control-plane authority. Remove `ensureCurrentScript`; immutable-spec mismatch causes replacement on next Start.
- **Run `docker pull` again.** Docker can call corrupted extracted layers `Already exists`; insufficient.
- **Only `docker rmi` and re-pull.** It repaired the 2026-08-06 host, but shared/referenced layers and Docker’s local metadata make it a weaker invariant than replacing the disposable boot disk. It remains an operator diagnostic, not automatic correctness machinery.
- **Wipe `/var/lib/docker` from the startup script.** Could work on current COS but couples recovery to host internals and dockerd shutdown ordering. Instance replacement uses the existing storage boundary and is easier to prove.
- **Provision a replacement immediately on failure.** Burns compute while the orb remains failed and turns deterministic failures into autonomous loops. Replacement is user/wake driven.
- **Use permanent `destroy`.** Deletes the authoritative workspace and violates the core requirement.
- **Delete by deterministic orb name without an incarnation.** A late delete can target a replacement after name reuse. Incarnation-bounded, incarnation-specific compute identity is required.
- **Apply only to `runtime_never_answered`.** Other terminal failures can follow host corruption, and a simple failed-state invariant is safer than an incomplete failure-code allowlist. Clean replacement may repeat non-host failures, which is acceptable because it is not automatic.
- **Retain failed VMs for manual forensics.** Keeping the suspect compute invites exactly the reuse this design forbids and accumulates cost with no owner. Evidence is captured durably before deletion instead; direct disk inspection is knowingly given up.
- **Gate the plan on the reconciler-lease work in `TODO.md`.** The lease closes a pre-existing stale-authority class this plan neither depends on nor materially worsens — a stale wrong terminal decision now costs a disposable boot disk rather than a stop, while the workspace is unreachable by `discardCompute`. The only *new* cross-revision disagreement, the desired specification, is closed by the forward-only generation fence. Blocking on the lease would delay protection against a recurring incident class.
- **Report the Tailscale node ID through runtime health/pull status to deduplicate device records.** A protocol extension guarding the rare lost-tailscaled-state corner; keys stay bounded without it and a duplicate device is harmless until archive/delete removes both. Deferred to `TODO.md`.

## Completion criteria

This plan is complete when:

- every transition to `failed` durably requests incarnation-bounded compute disposal and clears old authorization;
- a failed orb converges to no compute while retaining workspace/history;
- Start, Stop, archive, delete, and message wake cannot bypass or race required disposal;
- host-spec updates never mutate compute in place, leave running orbs untouched, and replace stale compute on next Start, forward-only by deploy generation;
- replacement uses a higher, uniquely identified incarnation, immutable spec fingerprint, and fresh token;
- late/stale cleanup cannot delete a newer incarnation, and a stale revision cannot replace newer-spec compute;
- Tailscale device identity survives with at most one unconsumed per-incarnation key;
- original failure, host evidence, and cleanup errors are durable and user-visible without log spam;
- provider, store, DST, E2E, and live GCE validation pass; and
- the release smoke completes without weakening or rerunning around a failure.
