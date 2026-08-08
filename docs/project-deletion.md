# Project deletion

Permanent removal of a project, every orb in it, and every pi-orb-owned resource reachable through those orbs.

## Requirement and status

**Required and implemented 2026-08-09.** A user can delete a whole project. Deletion is asynchronous, durable, idempotent, and recoverable after control-plane failure. Completion means the project and every one of its orbs return `404`, and all resources owned by those orbs have passed the permanent-deletion absence checks in `docs/orb-deletion.md`.

Project deletion is permanent deletion, not archival. Archived or archiving orbs are upgraded to permanent deletion along with active, stopped, failed, and already-deleting orbs. There is no undo and no project-level export in this requirement.

## Resource inventory and ownership boundary

A project currently owns only:

- its `projects` database row, including repository URL, display name, deletion intent, and timestamps;
- every `orbs` row whose `project_id` names it;
- transitively, every resource owned by those orbs in the complete inventory in `docs/orb-deletion.md`: history records and cleanup intents; live proxies and in-process work; Docker/GCE/process compute and persistent filesystems; runtime processes, logs stored in process-provider directories, host metadata and bearer tokens; and exact-match Tailscale keys/devices.

Project deletion does **not** delete or mutate the remote Git repository. It also retains shared model/GitHub credentials and credential pointers, control-plane infrastructure, provider images/networks, deployment-level Tailscale configuration, audit/Cloud Logging records, billing records, and database backups/PITR governed by their own retention. Product copy must not promise erasure from those retained systems.

There are currently no project-scoped clone caches, snapshots, credentials, ports, or provider resources. If one is introduced later, it must be added to this inventory and the project finalization gate before shipping.

## API and user experience

The browser API includes:

```text
DELETE /api/v1/projects/:projectId
```

The first accepted request returns `202` with the project in `deleting` state. Repeats while deletion is active are idempotent. The project remains returned by project list/detail APIs while cleanup is in progress, then disappears and returns `404` only after finalization. Creating another orb in a deleting project returns non-retryable `409 conflict`; existing orbs reject ordinary mutations because they have atomically entered their own `deleting` state. Individual orb `GET` and list responses remain available while cleanup is underway so the UI can show which child is blocked.

Extend `ProjectView` with `state: "active" | "deleting"`, `updatedAt`, and optional deletion progress synthesized from durable rows:

```ts
interface ProjectDeletionProgress {
  total: number;
  remaining: number;
  blocked: number;
}
```

`total` is the child count captured when deletion is first accepted; `remaining` is the current orb-row count; `blocked` counts cleanup intents with a persisted error. The dashboard exposes **Delete project** with confirmation that the project, every orb, all checkouts/files/compute, and all conversation history will be permanently deleted. While deleting, disable new-orb creation and all project actions, show progress and sanitized child blockers, and poll until the project disappears. A failed API request leaves the project in place with visible feedback. There is no optimistic disappearance and no silent redirect for a stale resource URL (`docs/web-ui.md`).

## Atomic intent and race fence

Do not implement this as a browser loop issuing independent orb deletes followed by a project-row delete. The accepted command is one database transaction:

1. lock the project row and verify it exists;
2. move `projects.state` from `active` to `deleting`, set `deletion_requested_at`, and capture the initial orb count once;
3. transition every child orb, from every lifecycle state, to `deleting` and create or upgrade its durable cleanup intent exactly as `requestOrbDeletion` does; existing delete intents keep their original quarantine deadline, while archive intents become delete intents;
4. commit, then close child live proxies, cancel child-local work, wake each orb reconciler, and wake the project-deletion finalizer.

Orb creation must lock/read the parent project in the same transaction as its insert and require `state = 'active'`. This serializes create-versus-delete: either the orb commits first and is included in the bulk deletion transaction, or deletion commits first and creation conflicts. The foreign key remains restrictive; never add `ON DELETE CASCADE`, because cascading the database rows before external cleanup would leak hosts and filesystems.

The project row is the durable top-level intent. The existing per-orb cleanup intents remain the authority for destructive external work, quarantine, retries, and blockers. No new provider operation is needed: project deletion fans out to the existing idempotent orb deletion protocol instead of teaching providers about projects.

## Reconciliation and finalization

A deterministic-clock project-deletion loop runs beside the existing lifecycle loops. For every deleting project it:

- verifies that every remaining child is in `deleting` with a delete-kind cleanup intent, repairing any missing child intent transactionally rather than assuming the initial fan-out was complete;
- wakes child reconciliation without duplicating provider cleanup logic;
- computes durable progress for the API;
- does nothing destructive at project scope while any child orb row remains;
- deletes the project row only when a transactional recheck finds zero child orb rows and the captured child count has therefore been fully finalized by `docs/orb-deletion.md`.

A child cleanup error leaves the project visibly `deleting` and retries indefinitely under the existing typed-error rules. There is no force-delete path that bypasses provider/Tailscale absence checks. A control-plane restart reconstructs all work from the deleting project row and child cleanup intents. Project finalization is idempotent: absence after a competing finalizer is success.

Lifecycle observability follows the edges-not-levels rule in `docs/lifecycle.md`. Emit project-scoped events for deletion requested (with child count), child fan-out repaired, blocked/recovered cleanup summary, and project finalized; never log every polling pass. Persisted project state, request time, child intents, and their sanitized blockers must make the current decision reconstructable without guest logs.

## Persistence and domain changes

Migration `008_project_deletion.sql`:

- adds `state` (`active | deleting`), `state_version`, `updated_at`, nullable `deletion_requested_at`, and nullable `deletion_initial_orb_count` to `projects`, backfilling existing rows as active;
- indexes deleting projects for the finalizer scan;
- keeps `orbs.project_id` restrictive.

`ControlPlaneStore` and its PostgreSQL/PGlite/fake implementations expose transactional operations for atomic project-delete request/fan-out, active-project-checked orb insertion, deleting-project scans/progress, fan-out repair, and zero-child project finalization. Both individual and project deletion produce the same delete-kind `orb_deletions` invariant, covered by the shared store contract; provider cleanup remains exclusively in the existing orb reconciler so external deletion behavior cannot fork.

No in-memory project job is authoritative: the periodic finalizer discovers the durable project row after a restart, while the accepted command immediately wakes child reconciliation through the existing per-orb scheduling path. Child cancellation/connection closure also continues to use those per-orb paths. The credential broker requires no project-specific cleanup: authorization is revoked by each child's `deleting` state, and the shared credentials are intentionally retained.

## Implementation and verification

Implementation landed in this order: migration/project/domain/protocol types and store contract; atomic delete/fan-out plus the create-orb race fence; deterministic finalizer and edge observability; HTTP route/views; dashboard and frontend fixture; then deterministic, adapter, API/UI, and end-to-end verification.

Coverage includes:

- the shared PGlite/PostgreSQL store contract for atomic fan-out, archive-to-delete upgrade, idempotent repair with blocker preservation, the active-project insertion fence, progress counts, restrictive early finalization, and final removal;
- deterministic simulation schedules for create racing delete, mixed running/stopped/archived children, two competing finalizers, provider-destroy/store failures, and control-plane restart recovery, asserting final row/intent/replica/host/filesystem absence;
- HTTP tests for first and repeated `202`, progress, late-child `409`, and a missing project's `404`;
- pure web presentation tests pinning the full destructive confirmation scope and remaining/blocked progress copy; the frontend fixture implements asynchronous project deletion through the production `ProjectView` contract;
- the full-slice E2E with one stopped orb containing committed history and one running orb, proving late creation conflicts, every project/orb/history endpoint reaches `404`, the project list drops the row, and process-provider state directories are absent.

No provider-specific implementation changed: project deletion delegates every child to the already-tested orb `destroy` path in `docs/orb-deletion.md`. `npm test`, typecheck, lint, and `PI_ORB_E2E_BACKEND=process npm run test:e2e` passed on 2026-08-09; the E2E deleted one stopped child with replicated history and one running child, rejected a late create, and proved final project/orb/history/process-provider absence. Docker/GCE/Tailscale destructive behavior remains covered by the existing orb-deletion adapter suites and the live cloud smoke follow-up in `TODO.md`.
