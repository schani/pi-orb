# Orb deletion

Permanent removal of an orb and every resource owned by it.

## Requirement and scope

**Required and implemented 2026-08-08.** A user can permanently delete an orb. Completion means that neither the authoritative filesystem nor the replicated conversation remains recoverable through pi-orb. Deletion is asynchronous, idempotent while in progress, retryable after process failure, and available from every lifecycle state. It does not delete the parent project or shared deployment infrastructure.

Export-before-delete is not part of this requirement and remains open in `docs/open-questions.md`.

## Resource inventory

Resources owned by one orb and therefore deleted:

| Layer | Orb-owned resources |
| --- | --- |
| Control-plane database | The `orbs` row, including lifecycle intent, name/auto-name lease, host ref, runtime-token hash, session metadata, replication cursor/head, errors, and idle timestamps; every `history_records` row for the orb. A short-lived deletion tombstone is retained only while cleanup is being made race-safe, then removed. |
| In-process control plane | Reconciler/poller retry state, boot probes, liveness/drain state, naming work, visibility state, live browser proxies, and in-flight provider/runtime operations for the orb. |
| Docker provider | Container `pi-orb-<orbId>` and persistent volume `pi-orb-data-<orbId>`. The volume contains the Git checkout, Pi session/history files, Tailscale state, and any repository-created files. |
| GCE provider | Instance `pi-orb-<orbId>`, its auto-delete COS boot disk, persistent data disk `pi-orb-data-<orbId>`, attached ephemeral network interface/public IP, instance metadata (runtime token, Tailscale key, startup script), and guest attributes. Deleting the instance and explicitly deleting the non-auto-delete data disk is required. |
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

Tailscale cleanup is a separate provider-agnostic port because tailnet identity exists independently of Docker/GCE/process host state. Its adapter uses OAuth scopes to list/delete auth keys and devices, matches exact pi-orb identities rather than substring names, and returns typed `ResultAsync` errors.

## Persistence changes

Add a migration that:

- extends the orb-state check with `deleting`;
- creates the minimal `orb_deletions` tombstone table and indexes its retry/quarantine scan;
- adds store operations for atomic delete request, cleanup-outcome persistence, transactional history/orb removal, tombstone listing, and tombstone removal.

Do not add soft-delete columns to history and do not retain a browsable transcript. Database backups and PITR may contain old rows until their configured retention expires; product copy and documentation must say so.

## Sharing with archival

`docs/orb-archival.md` extends this tombstone into a generalized cleanup intent and extracts a shared resource-disposal routine. Permanent deletion semantics do not change: it still skips history drain and purges database records. Archive adds a history-seal precondition and a retaining finalizer, while calling these exact Tailscale cleanup, host `destroy`, quarantine, and final-absence operations. Delete may upgrade an in-progress archive and remains available after archival.

## Verification

Implemented coverage includes provider tests for Docker/GCE/process complete, repeated, and ownership-checked destruction; PostgreSQL/PGlite contract coverage for atomic tombstone creation and circular-FK-safe history/orb removal; DST coverage for full deletion, retryable destroy/store failures, command conflicts, quarantine, and control-plane restart recovery; protocol and UI type coverage; and the full-slice E2E, which proves the process/Docker host persistence and database history disappear and the API reaches final `404`. `npm run test:e2e` was run with the process backend on 2026-08-08 and passed the full slice (the Docker-only interrupted-turn suite was correctly skipped).

Live GCE and Tailscale destructive smoke validation remains tracked in `TODO.md`; adapter-level tests prove request ordering, exact ownership matching, and instance/data-disk plus key/device deletion without touching similarly named resources.
