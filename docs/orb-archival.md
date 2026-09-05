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

## Self-archival (decided and implemented 2026-09-05)

An orb can archive **itself** with plain `pi-orb archive`, without an orb-ID argument, confirmation flag, or sibling mutation authority. The user approved this invocation after research (`docs/open-questions.md`, question 47). The environment prompt says to use it **only when the user requested archival of this orb**, and to push/export anything needed first. This instruction is agent guidance, not a security boundary against code already holding the orb's runtime bearer. Rejected: mandatory `--yes` adds ceremony without stronger authorization; a custom Pi tool adds harness coupling when the existing shell tool suffices.

### Findings from the current implementation

- `apps/orb-runtime/docker/pi-orb` dispatches to TypeScript commands. `apps/orb-runtime/src/inspection/cli.ts` and `endpoint.ts` already demonstrate runtime-environment discovery, bearer-authenticated control-plane requests, bounded HTTP calls, structured responses, and CLI exit classes. No Pi-specific tool or SDK extension is necessary: the agent can use its existing shell tool.
- Production injects the runtime-only control-plane URL. The existing browser `POST /api/v1/orbs/:orbId/archive` is not registered there (`docs/control-plane-api.md`). Calling it from the CLI is therefore not a viable production implementation.
- `apps/control-plane/src/http/runtime-routes.ts` resolves the calling orb from its per-incarnation bearer, rejecting missing/retired credentials and pending compute disposal. The shared broker state allowlist includes `archiving`, so retries can still authenticate while the current turn settles; archived finalization clears the token.
- `requestOrbArchive` in `apps/control-plane/src/domain/lifecycle.ts` already persists the cleanup intent, closes browser connections, logs the transition, and treats repeated archive requests idempotently. Runtime WebSocket disconnect cleanup only removes subscribers; it does not abort the agent (`apps/orb-runtime/src/http/server.ts`). Archival pulls until empty, checks reported activity, seals the retained history, then uses shared deletion-grade cleanup. This supports letting the requesting turn finish, rather than killing it at acceptance.
- The pre-existing archival DST covered retained records, cleanup, failed-compute restoration, and delete upgrade, but not a real agent's self-archive tool result and subsequent final reply. Self-archival adds that scenario to the full-slice E2E rather than treating static inspection as proof.

### Contract and safety boundaries

`POST /runtime/v1/orb/archive` accepts an empty object (or no body) and returns `202` with `{ "orbId": "<caller-id>", "state": "archiving" }`. The protocol defines the path, request, acknowledgement, and typed error envelope. The target derives exclusively from the authenticated bearer; target arguments/fields are rejected. It reuses the existing archive lifecycle rather than implementing runtime-local shutdown, direct provider deletion, a new pending state, or a separate cleanup loop.

Return as soon as intent is durable. CLI success means **archive requested**, not resources destroyed. Never wait for completion inside the tool call: archival waits for idle, and the waiting tool would itself keep the agent busy. Print a short acknowledgement explaining that the current turn may finish and the workspace will be permanently removed. An agent should push commits/export necessary files before requesting archival, then finish its reply; no automatic dirty-tree heuristic can establish that arbitrary workspace files are disposable. Browser live streaming closes at acceptance under existing semantics; the final reply is subsequently readable from replicated history, not guaranteed to stream live.

Do not simply authenticate once and pass an orb ID to the existing command: its CAS retry loop re-reads newer rows. A stopped/replaced incarnation could otherwise authenticate before a lifecycle change and archive a newer incarnation afterwards. Carry caller token/incarnation authority into the domain operation and revalidate it on every retry, with transactional fencing at the archive write. Authorization and destructive intent must have one linearization point. Admit new requests from `running` and idempotent retries from `archiving`; do not inherit the credential broker's broader boot-state authorization accidentally. This is an operation-specific restriction, not a change to broker access needed for draining. Both PostgreSQL and the simulation store check caller hash, incarnation, absence of a discard fence, and `running` state in the archive write; the domain revalidates before idempotent acknowledgement or a CAS retry.

A network timeout after submission is an **unknown acceptance outcome**, not proof that nothing happened. Report it honestly; an explicit retry while authorized is idempotent. Do not interpret a later `401` as successful completion. Permanent delete retains its existing priority and can intentionally discard the transcript.

The `archive_requested` lifecycle transition includes `source: "self" | "browser"` and, for self-requests, `callerIncarnation`, without logging the bearer. Preserve the current user-visible `archiving` state and seal/cleanup blockers. Use typed `Result`/`ResultAsync` failures at new first-party boundaries, with sanitized CLI errors; do not copy older ad-hoc failure conventions merely because the inspection command uses them.

### Verification

CLI subprocess tests cover argument rejection, missing environment, acceptance output, lost-response ambiguity, and typed error exit classes. Runtime route tests cover self-only targeting, idempotency, forbidden lifecycle states, missing identity, and discard fences. Shared store contracts exercise transactional hash/incarnation/state/discard checks; DST places replacement/discard/stop/delete between domain read and archive write to prove retries revalidate caller authority. A busy-turn DST restarts the control plane's ephemeral state after acceptance and proves recovery from durable intent, no seal/destruction while busy, and retention of later records. The full-slice E2E invokes the real CLI through an agent bash tool and asserts the tool result, final reply, terminal archived state, permanent Start rejection, and resource absence. These tests reuse the existing archive/delete cleanup machinery; self-archival adds no separate retry/reconciliation state machine.

**Validation (2026-09-05):** typecheck and lint pass; the full unit/DST suite passes with 1,051 tests and one environment-dependent skip. The first full process-backend E2E run passed the three compute-lifecycle scenarios and frontend session recovery but failed the new archive scenario because its mock rules were out of order (`docs/testing.md` records the cause and synchronization fix). After correcting that fixture, the targeted full-slice success scenario passes, including real self-archive, final-reply retention, and project cleanup. Docker/native PostgreSQL coverage was unavailable on this machine; no production deployment was performed. The first unit run also exposed a missing `jq` prerequisite and an incomplete discard-intent test fixture; installing the prerequisite and supplying the database-required reason/timestamp fixed those deterministic failures before the passing full run.

## Implementation and verification

Implementation adds protocol/API states and `archivedAt`, migration `007_orb_archival.sql`, atomic PostgreSQL/PGlite/fake-store archive request/seal/finalize operations, `requestOrbArchive`, and a shared `reconcileResourceDisposal` used by both archive and delete. The browser and frontend fixture expose archive separately, retain archived rows in project lists, and render archived history without a composer or start/stop capability. Broker authorization includes `archiving` only because a stopped runtime may need to boot and an in-flight turn may need credentials to settle before sealing; finalization clears the runtime-token hash.

Store-contract coverage proves archive finalization retains records and removes the cleanup intent. Deterministic simulation coverage proves complete history retention with host/filesystem destruction, permanent start rejection, and archive-to-delete upgrade. The existing deletion DST/provider suites continue to exercise the shared destructive path. Typecheck, the full unit/DST suite, and lint pass. `npm run test:e2e` was attempted in the implementation environment but Docker is unavailable (`spawn docker ENOENT`), so the Docker E2E suites could not execute; this environmental validation gap does not change the passing process-provider DST and store-contract coverage.
