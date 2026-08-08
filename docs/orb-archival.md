# Orb archival

Read-only retention of an orb's transcript and metadata after all runtime resources are removed.

## Requirement and status

**Required and implemented 2026-08-08.** A user can archive an orb. Archival removes every external/runtime resource removed by permanent deletion, but retains the control-plane orb row, replicated history, and descriptive/session metadata. The archived orb remains in project lists and can be opened and renamed, but can never be started again. Permanent deletion remains available for an archived orb.

An archive is irreversible. Restoring, cloning, exporting, or reconstructing a runnable orb from its replica is out of scope. In particular, the history replica does not contain the checkout or arbitrary workspace files.

## Product semantics

Add terminal state `archived` and transitional state `archiving`.

- `POST /api/v1/orbs/:orbId/archive` asynchronously enters `archiving` and returns `202` with the current `OrbView`.
- Repeated archive requests in `archiving` or `archived` are idempotent.
- Entering `archiving` closes and refuses live connections and conflicts with start, stop, message, and automatic naming work. History reads remain available throughout archival. Rename is allowed after completion, but not while cleanup is in progress.
- `start` on an archived orb always returns non-retryable `409 conflict`. There is no unarchive endpoint.
- Permanent `DELETE` is allowed during `archiving` and after `archived`. During `archiving`, it atomically upgrades the durable cleanup intent to deletion; deletion then skips transcript sealing and eventually removes the retained database records. This is the escape hatch when a complete archive cannot be produced.
- Project orb lists continue to include archived orbs. Opening one shows the complete retained transcript in read-only mode, with no composer or lifecycle start/stop controls.

The confirmation copy must distinguish the operations: archive deletes the checkout, files, compute, and tailnet identity but retains the conversation; delete also destroys the conversation. While work is in progress, `stateDetail` reports whether archival is waiting for the runtime, sealing history, cleaning resources, quarantining stale provisions, or blocked by a sanitized error.

## Completeness boundary

Archival must not knowingly turn a lagging replica into the only copy. Before destructive cleanup it creates a durable **history seal**:

1. stop accepting new live mutations and wait for the runtime to report `idle`, so an in-flight agent turn is not deliberately truncated;
2. pull and commit complete history records until an empty pull, reusing the controlled-stop drain implementation;
3. transactionally record the seal (time, cursor, and head) on the cleanup intent before destroying any host or filesystem.

A crash before the seal is recorded only causes another idempotent drain. A crash after it is recorded may safely resume resource destruction even if the host has already disappeared.

A stopped orb may have complete filesystem records beyond the database cursor because abnormal stops are allowed to skip the drain (`docs/history-replication.md`). Therefore `archiving` must temporarily restore/start its retained host and wait for runtime readiness when necessary, using the existing start/readiness machinery without reopening live access or transitioning through user-visible `running`. Never-ready orbs with no harness session may seal an empty history without starting a runtime.

Replication-integrity failures, an unavailable authoritative filesystem, or a runtime that cannot be restored leave the orb visibly blocked in `archiving`; they do **not** destroy resources or silently accept a partial transcript. The user may repair the condition or choose permanent deletion. Ordinary retryable runtime/provider/store failures retry under injected clocks and typed errors.

“Complete” means every complete harness record present after the runtime becomes idle and the pull-until-empty barrier succeeds. It cannot recover records already lost before archival, and it does not include transient streaming output that was never committed by the harness.

## Shared disposal machinery

Archive and delete should share the destructive half rather than grow parallel provider cleanup paths.

The deletion tombstone is now a shared durable cleanup intent with a `kind: "archive" | "delete"`, cleanup deadline, last sanitized error, and archive-only seal fields. Migration `007_orb_archival.sql` extends the existing `orb_deletions` table in place; its historical name is inert storage detail, while both operations use the same intent and reconciler path.

Extract one `reconcileResourceDisposal` routine from `reconcileDeleting`. For both intent kinds it must, unchanged:

- revoke exact-match Tailscale keys/devices through `resourceCleaner.cleanupOrb`;
- invoke the existing idempotent `OrbHostProvider.destroy(orbId, context)` for compute and persistent storage;
- repeat cleanup through the existing quarantine window to fence in-flight provisions;
- perform the same final provider/Tailscale absence pass;
- persist blockers and emit edge-only lifecycle events.

Only the precondition and final database transaction differ:

- delete requires destructive intent but no history seal, then removes history, orb row, and cleanup intent;
- archive requires a committed history seal, then retains history and identity metadata, clears runtime-only/host fields and naming leases, sets `archived_at`, transitions the orb to `archived`, and removes the cleanup intent.

Retain at least: orb/project IDs, name, checkout commit, harness session ID/header, replication cursor/head, history records, creation/update/archive timestamps, and enough state metadata to render the archived resource. Clear `host_ref`, runtime token hash, idle/stop fields, auto-name lease/backoff, cleanup errors, and other fields that authorize or schedule runtime work. `host_kind` may remain as inert provenance. The replica becomes the authoritative transcript only for `archived` orbs; it still must never be used to reconstruct a runtime.

The orphan sweep may destroy a host only when an `archiving`/`deleting` row plus its cleanup intent proves destructive intent. An `archived` row has no active cleanup intent; any exact-identity host observed for it is an integrity violation and must be destroyed and logged, never adopted or started.

## Implementation and verification

Implementation adds protocol/API states and `archivedAt`, migration `007_orb_archival.sql`, atomic PostgreSQL/PGlite/fake-store archive request/seal/finalize operations, `requestOrbArchive`, and a shared `reconcileResourceDisposal` used by both archive and delete. The browser and frontend fixture expose archive separately, retain archived rows in project lists, and render archived history without a composer or start/stop capability. Broker authorization includes `archiving` only because a stopped runtime may need to boot and an in-flight turn may need credentials to settle before sealing; finalization clears the runtime-token hash.

Store-contract coverage proves archive finalization retains records and removes the cleanup intent. Deterministic simulation coverage proves complete history retention with host/filesystem destruction, permanent start rejection, and archive-to-delete upgrade. The existing deletion DST/provider suites continue to exercise the shared destructive path. Typecheck, the full unit/DST suite, and lint pass. `npm run test:e2e` was attempted in the implementation environment but Docker is unavailable (`spawn docker ENOENT`), so the Docker E2E suites could not execute; this environmental validation gap does not change the passing process-provider DST and store-contract coverage.
