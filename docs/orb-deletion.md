# Orb deletion

Permanent removal of an orb and every resource owned by it.

## Requirement and scope

**Required and implemented 2026-08-08.** A user can permanently delete an orb. Completion means that neither the authoritative filesystem nor the replicated conversation remains recoverable through pi-orb. Deletion is asynchronous, idempotent while in progress, retryable after process failure, and available from every lifecycle state. Deleting one orb does not delete its parent project or shared deployment infrastructure. Whole-project deletion is the separate atomic fan-out design in `docs/project-deletion.md`; it invokes this same cleanup protocol for every child and removes the parent only after all child finalizers complete.

Export-before-delete is not part of this requirement and remains open in `docs/open-questions.md`.

**Hosted-file extension (implemented):** permanent deletion also removes
the orb's hosted-file catalog, operations, and objects as specified in `docs/hosting.md`. Cleanup
retains exact object inventory until absence is confirmed.

## Resource inventory

Resources owned by one orb and therefore deleted:

| Layer | Orb-owned resources |
| --- | --- |
| Control-plane database | The `orbs` row, including lifecycle intent, name/auto-name lease, host ref, runtime-token hash, session metadata, replication cursor/head, errors, and idle timestamps; every `history_records` row for the orb. A short-lived deletion tombstone is retained only while cleanup is being made race-safe, then removed. Exception (2026-09-08): project-owned `orb_spawns` acceptance/provenance retains source/target IDs and an immutable request fingerprint until project deletion, so retries cannot recreate deleted work; no prompt/history is retained there (`docs/orb-spawning.md`). |
| In-process control plane | Reconciler/poller retry state, boot probes, liveness/drain state, naming work, visibility state, live browser proxies, and in-flight provider/runtime operations for the orb. |
| Docker provider | Container `pi-orb-<orbId>` and persistent volume `pi-orb-data-<orbId>`. The volume contains the Git checkout, Pi session/history files, Tailscale state, and any repository-created files. |
| GCE provider | Instance `pi-orb-<orbId>`, its auto-delete native Debian boot disk, persistent data disk `pi-orb-data-<orbId>`, attached ephemeral network interface/public IP, `pi-orb-config` instance metadata, and guest attributes. Deleting the instance and explicitly deleting the non-auto-delete data disk is required. |
| Process provider | The runtime child process and its whole process group; the per-orb state directory, including `host.json`, plaintext runtime token, assigned-port metadata, workspace/session/Tailscale state, and runtime stdout/stderr logs. |
| Tailscale | Every auth key whose exact description identifies the orb, and every `tag:pi-orb` device whose exact machine identity identifies `pi-orb-<orbId>`. Key revocation prevents re-registration; device deletion removes the tailnet record and MagicDNS name. Cleanup must tolerate keys that expired and devices that never joined. |
| Runtime-only credentials | Short-lived model/GitHub access tokens and agent processes are memory-only and disappear when the host is destroyed. The per-incarnation runtime bearer token disappears with host metadata and its hash disappears with the orb row. |

Resources explicitly not owned by one orb and therefore retained:

- the parent project and its other orbs;
- shared Codex/GitHub credentials, credential-pointer rows, Secret Manager versions, and GitHub App installation;
- the Docker network and runtime images;
- GCP project/VPC/subnet/firewall/service accounts, Artifact Registry images, Cloud SQL, and control-plane services;
- Tailscale OAuth client, tailnet ACLs, and `tag:pi-orb` definition;
- provider audit logs, Cloud Logging entries, database backups/PITR, and third-party billing records governed by their own retention systems. These are retained records, not live orb resources, and deletion must not claim cryptographic erasure from backups.

## API and user experience

Add:

```text
DELETE /api/v1/orbs/:orbId
```

The first accepted request returns `202` with an `OrbView` whose state is `deleting`. Repeats while deletion is active are idempotent and return the same result. `start`, `stop`, rename, history, and new live connections conflict once deletion begins; existing live proxies are closed immediately. After the user-visible row is removed, `GET` returns `404`, which is the observable completion signal.

The orb header and project list expose a destructive **Delete orb** action with a confirmation that names the lost checkout and conversation history. While cleanup runs, show `deleting`; if cleanup is retrying, `stateDetail` identifies the resource class and sanitized failure. Remove the orb from the list only after the API reports completion. No undo is offered.

## Lifecycle and cleanup protocol

Add durable state `deleting`; do not compose deletion from `stop` followed by an untracked row delete.

1. `DELETE` CAS-transitions any current state to `deleting`, writes an `orb_deletions` tombstone in the same transaction, and wakes reconciliation. The tombstone contains only orb ID, provider kind, request time, cleanup attempt/outcome fields, and a quarantine deadline—no conversation, repository URL, secret, or host token.
2. Entering `deleting` immediately revokes broker authorization through the existing lifecycle-state check, closes/refuses live proxies, cancels local poll/reconcile/name work, and clears browser activity. No history drain runs: replicated history is itself being deleted.
3. Cleanup lists exact-match Tailscale identities, revokes matching auth keys first, and deletes matching tagged devices; a surviving host therefore cannot enroll a replacement node. It then invokes the idempotent `OrbHostProvider.destroy(orbId, context)` that removes compute and persistent storage by deterministic orb identity, not only by the possibly missing/stale `host_ref`. The whole pass repeats during quarantine, so finalization follows a pass that verified no key/device or host resource remained. Absence is success; uncertainty is a typed retryable error.
4. After every configured external cleaner reports success, the orb row and tombstone remain in `deleting` through a quarantine window. The ordinary reconciler repeatedly destroys any matching host and Tailscale identity during that window. This catches a provision that was already in flight when deletion began. The production window is 65 seconds, exceeding the enforced 60-second bound on one provider operation; it uses the injected clock.
5. After the quarantine deadline, one final provider enumeration and Tailscale absence check runs. Only then does one database transaction null the cursor/head if needed and delete all history rows, the orb row, and the tombstone. At that point `GET` becomes `404` and all pi-orb-owned resources are gone.

The tombstone is durable cleanup progress and the race fence for stale provisioners and control-plane crashes between an external side effect and its database commit. The ordinary orphan sweep remains conservative for hosts with no orb row; only a live `deleting` row plus its tombstone authorizes destructive cleanup.

External cleanup is retry-until-success. A non-retryable adapter response does not silently drop the row or claim completion; it persists a sanitized blocker on the tombstone/`stateDetail` for the user and operators, and a repeated delete or reconciliation retries after configuration is repaired. Lifecycle logs emit edges for deletion requested, each cleaner outcome, blocked/recovered cleanup, row removal, and tombstone removal; the durable tombstone makes the decision and last outcome queryable after the orb row is gone.

## Provider contract

Extend `OrbHostProviderOperation` with `destroy` and the provider port with:

```ts
destroy(
  task: SimulationTask,
  orbId: string,
  context: OperationContext,
): ResultAsync<void, OrbHostProviderError>;
```

`destroy` is idempotent, removes all provider resources owned by the orb, and resolves only when they are definitively absent at that observation. Docker force-removes the container before the volume. GCE deletes the instance, waits for completion, then explicitly deletes and waits for the data disk (also tolerating an already-auto-deleted boot disk). Process mode marks the child intentional, terminates its process group, waits for exit, and recursively removes the host directory without following symlinks outside it.

**Immutable-compute extension (decided 2026-08-12; implementation planned in `docs/compute-replacement.md`):** compute names become incarnation-specific. `destroy` remains deletion-grade but must enumerate and remove every exact-orb incarnation before deleting the fixed workspace volume/directory/data disk; it may no longer assume one legacy deterministic compute name. The separate `discardCompute` operation in that plan is intentionally narrower and never substitutes for deletion because it preserves authoritative storage and tailnet identity.

Tailscale cleanup is a separate provider-agnostic port because tailnet identity exists independently of Docker/GCE/process host state. Its adapter uses OAuth scopes to list/delete auth keys and devices, matches exact pi-orb identities rather than substring names, and returns typed `ResultAsync` errors.

## Persistence changes

Add a migration that:

- extends the orb-state check with `deleting`;
- creates the minimal `orb_deletions` tombstone table and indexes its retry/quarantine scan;
- adds store operations for atomic delete request, cleanup-outcome persistence, transactional history/orb removal, tombstone listing, and tombstone removal.

Do not add soft-delete columns to history and do not retain a browsable transcript. Database backups and PITR may contain old rows until their configured retention expires; product copy and documentation must say so.

## Sharing with archival

`docs/orb-archival.md` extends this tombstone into a generalized cleanup intent and extracts a shared resource-disposal routine. Permanent deletion semantics do not change: it still skips history drain and purges database records. Archive adds a history-seal precondition and a retaining finalizer, while calling these exact Tailscale cleanup, host `destroy`, quarantine, and final-absence operations. Delete may upgrade an in-progress archive and remains available after archival.

## Self-deletion (implemented locally 2026-09-19)

The user approved in-orb CLI self-deletion and requested review of its agent prompt guidance (`docs/open-questions.md`, question 70). The CLI, runtime route, transactional authority fences, and prompt are implemented locally. Deployment is not authorized.

### Invocation and semantics

Use plain `pi-orb delete`, matching `pi-orb archive`: no target argument, interactive prompt, or `--yes` flag. Target identity comes exclusively from the runtime bearer. A confirmation flag does not strengthen authorization for code already holding that bearer. Agent guidance must require an explicit user request to delete this orb and pushing/exporting needed work first.

Reuse permanent deletion unchanged: remove compute, workspace, hosted files, and replicated conversation, but not the parent project or siblings. Unlike archive, deletion does not wait for the current turn, child agents, uploads, or history sealing. It may kill the CLI before its acknowledgement arrives; neither a tool result nor a final assistant reply is guaranteed. Quarantine delays final database removal, not initial host destruction. Graceful self-deletion would require a separate lifecycle decision and is not proposed here.

`POST /runtime/v1/orb/delete` accepts no body or `{}` and returns non-cacheable `202 { "orbId": "<caller-id>", "state": "deleting" }` once intent is durable. Reject extra fields. Print “Deletion requested” only on acknowledgement; never wait for completion or claim resources are already gone. Bound the request and report a lost response as unknown acceptance, not failure to delete.

Route through the existing domain deletion operation and durable cleanup machinery; add no state, table, grace period, or cleanup loop. Admit self-deletion only from `running`. Carry caller hash/incarnation through the domain CAS loop and check hash, incarnation, lifecycle state, and absence of pending compute disposal atomically at the deletion write in both PostgreSQL and the simulation store. Revalidate on each retry. Browser deletion keeps its every-state authority.

Preserve immediate runtime credential revocation in `deleting`; do not broaden broker authorization for retry acknowledgements. Requests after acceptance normally receive `401`, which proves neither successful deletion nor its absence. Concurrent requests must produce at most one accepted transition and cannot alter another incarnation.

Extend the durable `delete_requested` lifecycle event with `source: "self" | "browser"` and self-request `callerIncarnation`; never record bearer credentials. Existing `deleting` state, cleanup blockers, recovered edges, and final removal remain the user/operator outcome surfaces. The CLI, protocol, runtime API documentation, environment prompt, and `DESIGN.md` share this contract.

### Verification contract

Implementation follows tests-first coverage:

- **CLI/endpoint:** real dispatcher invocation, argument/target rejection, missing environment, exact authenticated request, response validation, acceptance-only output, typed/sanitized error exit codes, deadline, and unknown acceptance after a lost response. Prompt tests require explicit-user-request guidance and warn that deletion can interrupt the turn.
- **Runtime routes:** self-only targeting; malformed/extra fields; missing, stale, and discard-fenced credentials; non-running rejection; first acceptance followed by revoked authorization; sanitized store errors; sibling isolation; one secret-free self-request event. Keep browser routes unavailable under runtime credentials.
- **Shared store contract:** correct authority atomically writes state and cleanup intent; wrong hash/incarnation, non-running state, or discard fence writes neither. Exercise PostgreSQL/PGlite and the simulation store; retain unrestricted browser-deletion tests.
- **Authority DST:** force stop, replacement, discard, archive, and competing delete between authentication/domain read and deletion write, including CAS retries. Assert no stale caller can delete replacement compute or create unauthorized intent; duplicate requests yield one transition.
- **Lifecycle DST:** accept while continuously busy, then reconstruct control-plane ephemeral state. Prove cleanup proceeds without idle preparation, history drain, or seal; workspace, replica, and hosted resources disappear while siblings survive. Inject a lost response after commit and crashes/failures around external cleanup and finalization. Reuse existing deletion retry, quarantine, late-provision, and busy-child scenarios rather than introducing a second cleanup model.
- **Full-slice E2E:** a disposable orb's real agent invokes the real CLI. Observe acceptance through control-plane evidence and eventual API `404`, history/resource absence, and sibling survival. Do not assert receipt of CLI output or a final reply. Use explicit synchronization rather than timing sleeps. Retain the self-archive E2E proving its different finish-the-turn behavior.

Run typecheck, lint, unit/store/DST suites, and `npm run test:e2e` before deployment. Preserve and replay any first DST failure trace before changing code or scenario assumptions.

The prompt adds, after archive guidance: “Use `pi-orb delete` only when the user explicitly requests deletion of this orb. It permanently deletes the workspace, conversation, and hosted files; push or export anything needed first. It may interrupt the current turn before acknowledgement.”

**Local qualification (2026-09-19):** typecheck and lint pass (three existing warnings and one informational diagnostic). `npm test` passes 2,153 tests with eight conditional skips plus the infrastructure suites, including the full 51-case PGlite store contract. The full `PI_ORB_E2E_BACKEND=process npm run test:e2e` passes 138 tests with two expected skips for Docker interruption and network PostgreSQL. The self-delete E2E holds the requesting tool on a fixture FIFO after the CLI so cleanup is proven while busy, without an optional follow-up inference consuming later archive rules. It verifies lifecycle acceptance, final `404`, history/workspace/hosted-object removal, and surviving sibling history/compute; the existing self-archive final-reply checks still pass. Tests-first red baselines and validation logs are retained under `.context/self-delete/`. No deployment.

## Verification

Implemented coverage includes provider tests for Docker/GCE/process complete, repeated, and ownership-checked destruction; PostgreSQL/PGlite contract coverage for atomic tombstone creation and circular-FK-safe history/orb removal; DST coverage for full deletion, retryable destroy/store failures, command conflicts, quarantine, and control-plane restart recovery; protocol and UI type coverage; and the full-slice E2E, which proves the process/Docker host persistence and database history disappear and the API reaches final `404`. `npm run test:e2e` was run with the process backend on 2026-08-08 and passed the full slice (the Docker-only interrupted-turn suite was correctly skipped).

Live GCE and Tailscale destructive smoke validation remains tracked in `TODO.md`; adapter-level tests prove request ordering, exact ownership matching, and instance/data-disk plus key/device deletion without touching similarly named resources.
