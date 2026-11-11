# Teardown: archive and delete

Permanent removal of orb resources. One deletion-grade cleanup engine serves orb deletion, orb archival and project deletion. HTTP status semantics for the browser routes are in `docs/control-plane-api.md`; lifecycle states and commands are in `docs/lifecycle.md`.

## Orb resource inventory

Owned by one orb, removed by deletion:

| Layer | Resources |
| --- | --- |
| Database | The `orbs` row (lifecycle intent, names and auto-name lease, host ref, runtime-token hash, session metadata, replication cursor/head, errors, idle timestamps), every `history_records` row, and every orb-keyed table: inbox messages, workspace uploads, activity headlines, previews, resource snapshots and events, agent artifacts, and the private Durable namespace (`durable_pg_*`). |
| Hosted files | Catalog, operations and stored objects (`docs/http-exposure.md`). Cleanup keeps the exact object inventory until absence is confirmed. |
| In-process | Reconciler/poller retry state, boot probes, liveness/drain state, naming work, visibility state, live browser proxies, in-flight provider/runtime operations. |
| Docker | Containers `pi-orb-<orbId>[-i<n>]` and volume `pi-orb-data-<orbId>` (checkout, home, native Claude history). |
| GCE | Instances `pi-orb-<orbId>[-i<n>]` with auto-delete boot disks, ephemeral NICs/IPs, `pi-orb-config` metadata and guest attributes, and the non-auto-delete data disk `pi-orb-data-<orbId>`, which must be deleted explicitly. |
| Process | The runtime process group and the per-orb state directory (`host.json`, plaintext runtime token, port metadata, workspace, logs). |
| Credentials | Guest model/GitHub access tokens and native agent processes die with the host; central Pi owner resources close through agent cleanup; the runtime bearer disappears with host metadata and its hash with the row. |

Retained, not owned by one orb:

- the parent project and sibling orbs;
- shared Codex/GitHub credentials, credential pointers, Secret Manager versions and the GitHub App installation;
- Docker network and runtime images; GCP project, VPC, firewall, service accounts, Artifact Registry, Cloud SQL and control-plane services;
- project-owned `orb_spawns` acceptance/provenance (source/target IDs and request fingerprint, no prompt or history) until project deletion, so retries cannot recreate deleted work (`docs/inbox.md`);
- `model_calls` usage rows, which have no foreign keys by design (`docs/model-usage.md`);
- provider audit logs, Cloud Logging, database backups/PITR and billing records under their own retention. Deletion never claims erasure from these; product copy says so.

## Cleanup engine

### Cleanup intent

`orb_deletions` is the shared durable cleanup intent (the table name is historical): `orb_id`, `kind` (`archive | delete`), `host_kind`, `requested_at`, `cleanup_after` (quarantine deadline), `last_error`, `updated_at`, and archive-only seal fields `history_sealed_at`, `sealed_cursor`, `sealed_head_id`. It holds no conversation, repository URL, secret or token. It is both cleanup progress and the race fence for stale provisioners and crashes between an external effect and its commit. Delete does not add soft-delete columns to history.

### Entering cleanup

Request CAS-transitions the orb to `deleting` or `archiving` and writes the intent in the same transaction, then:

- broker authorization is revoked through the lifecycle-state check (archiving keeps it only while needed to seal; see Orb archive);
- live proxies close and are refused, local poll/reconcile/name work is cancelled and browser activity cleared;
- any pending sleep is cancelled (`cancelled_sleep_id` on the transition edge);
- the transition edge records `reason=archive_requested|delete_requested`, `source: self | browser` and, for self-requests, `callerIncarnation`.

### Resource disposal

`reconcileResourceDisposal` is shared by both kinds:

1. Dispose the central agent (`AgentPlane.dispose`): archive seals public history and removes private authority; delete also deletes it.
2. Call `OrbHostProvider.destroy(orbId)` (`docs/host-provider.md`), which removes every exact-orb compute incarnation and then persistent storage, by orb identity rather than possibly stale `host_ref`. Absence is success; uncertainty is a typed retryable error.
3. Repeat the whole pass until `cleanup_after`. The 65 s quarantine exceeds the 60 s bound on one provider operation, so a provision already in flight when cleanup began is caught and destroyed. Finalization follows a pass that verified absence.
4. Clear persisted blockers on a successful pass.

Cleanup retries until success. A non-retryable adapter response never drops the row or claims completion: it persists a sanitized blocker on the intent and `stateDetail`, and retries after configuration is repaired. Edges: transition, `host-destroy` outcomes, blocked and recovered cleanup, `archive-history-sealed`, `archived`, `deleted`. The intent keeps the last outcome queryable.

Only a live `deleting`/`archiving` row plus its intent authorizes destructive cleanup. An `archived` row has no intent; the orphan sweep destroys any exact-identity host observed for it as an integrity violation (`archived-host-resurrected`), never adopting or starting it (`docs/lifecycle.md`).

## Orb delete

`DELETE /api/v1/orbs/:orbId` is accepted from every lifecycle state (status semantics: `docs/control-plane-api.md`). Start, stop, rename, history and live connections conflict once deletion begins; the orb becoming not-found is the completion signal.

Delete skips the history drain and seal: the replica is being deleted. After disposal, it removes hosted files, then one transaction nulls the cursor/head if needed and deletes history, the orb row (cascading orb-keyed tables) and the intent.

UI: the orb header and project list offer **Delete orb** with a confirmation naming the lost checkout and conversation. While cleanup runs the orb shows `deleting` (dotted state border on the dashboard), with the resource class and sanitized failure as a grey line when retries fail. It leaves the list only after the API reports completion. No undo. Export-before-delete is an open question (`docs/open-questions.md`).

## Orb archive

Archival removes everything deletion removes except the orb row, replicated transcript, descriptive/session metadata, hosted files and links. An archived orb stays in project lists, opens read-only with the complete transcript and no composer or start/stop controls, can be renamed, and can never start again. It is irreversible: no unarchive, restore, clone or reconstruction of a runnable orb from the replica, which lacks the checkout and workspace files.

`POST /api/v1/orbs/:orbId/archive` enters `archiving`; repeats in `archiving`/`archived` are idempotent. `archiving` conflicts with start, stop, message and naming work; history reads stay available; rename waits for completion. Start on an archived orb is a permanent conflict. Delete may upgrade an in-progress archive (atomically converting the intent to `delete`, which skips sealing) or remove an archived orb; this is the escape hatch when a complete archive cannot be produced.

Archive is offered separately from delete in the orb header and project list. Confirmation copy distinguishes them: archive deletes checkout, files and compute but keeps the conversation; delete also destroys the conversation. Copy never suggests an archived orb can be restored. `stateDetail` reports waiting for the runtime, sealing history, cleaning resources, quarantine, or a sanitized blocker.

### History seal

Archival never knowingly turns a lagging replica into the only copy. Before destructive cleanup:

1. Close live access and obtain `POST /v1/prepare-idle-stop` permission (`docs/runtime-protocol.md`). It declines while owned work remains; acceptance closes admission before any final snapshot. Archival keeps pulling history while preparation is declined (`archive-waiting-for-work`, logged once); the ordinary poll loop does not own archiving orbs. A failed or lost preparation response never authorizes sealing. The lifetime-scoped runtime fence survives runtime-only restart (`docs/postmortems/2026-09-14-idle-stop-admission-race.md`).
2. Pull and commit until an empty pull, reusing the controlled-stop drain.
3. Verify the prepared host ref and incarnation are still current, then record `history_sealed_at`, cursor and head with a state-version CAS before destroying anything (`archive-history-sealed admission_fenced=true`).

Central agents instead prepare the agent stop, suspend the active owner, read public PostgreSQL history passively and catch publication up before sealing, without reopening a Harness; the user-visible transcript is published, drained and sealed before private agent state is deleted (`docs/history.md`). Publication or seal failure blocks deletion; sealing and private cleanup stay idempotent across retries, crashes, concurrent cleanup and reopen, and no private mutation escapes the archive admission fence. History pulls after suspension never require a live actor. During graceful archival an already-admitted current-generation actor may use an already-running guest until preparation closes admission; absence fails promptly and never boots compute. Archive closes new admission while admitted work drains; completion revokes its generation. Central archival closes only execution browser connections and keeps conversation delivery until finalization.

A stopped orb may hold complete records beyond the cursor, because abnormal stops skip the drain. Archival therefore restores the retained host and waits for readiness when needed, using normal start/readiness machinery without reopening live access or passing through `running`. After failed-compute disposal it provisions the already-advanced clean incarnation (`docs/lifecycle.md`). Never-ready orbs without a harness session seal an empty history without starting.

A crash before the seal causes another idempotent drain; after it, destruction may resume even if the host is already gone. Integrity failures, an unavailable filesystem or an unrestorable runtime leave the orb visibly blocked in `archiving` without destroying anything; the user may repair or delete. "Complete" means every harness-committed record present once admission is fenced while idle; it cannot recover records lost earlier or uncommitted streaming output.

Broker authorization includes `archiving` only so a stopped runtime can boot and an in-flight turn can settle before sealing.

### Finalization

After disposal, one transaction keeps history and identity metadata (orb/project IDs, name, checkout commit, session ID/header, cursor/head, timestamps, enough state to render), clears fields that authorize or schedule runtime work (`host_ref`, token hash, idle/stop fields, auto-name lease/backoff, cleanup errors), sets `archived_at`, transitions to `archived` and removes the intent. `host_kind` may remain as provenance. The replica becomes the authoritative transcript only for archived orbs and is never used to reconstruct a runtime.

## Project delete

`DELETE /api/v1/projects/:projectId` enters `deleting`; repeats are idempotent. The project and its children stay visible in list/detail responses during cleanup, then become not-found. Creating an orb in a deleting project is a permanent conflict. There is no undo, no project export, and no force-delete that bypasses absence checks. Remote Git repositories are never touched.

A project owns its row (repository URL, name, deletion intent, timestamps), its project-scoped secret pointer and every secret-store bundle version naming it (including crash residue, `docs/credentials.md`), its MCP catalog, connection metadata and project-bound OAuth secret versions (`docs/mcp.md`; upstream authorization is not revoked), `orb_spawns` rows (foreign-key cascade), and every child orb with its full inventory above. Any future project-scoped resource must join this inventory and finalization gate before shipping.

**Atomic intent.** One transaction locks the project row, moves `active → deleting`, sets `deletion_requested_at`, captures `deletion_initial_orb_count` once, and transitions every child from every state to `deleting` with a delete-kind intent exactly as orb deletion does (existing delete intents keep their deadline; archive intents become delete). After commit it closes child proxies, cancels child work and wakes child reconcilers. Orb creation locks the parent and requires `state = 'active'` in the same transaction as its insert, so either the orb is included in the fan-out or creation conflicts. `orbs.project_id` stays restrictive: cascading rows before external cleanup would leak hosts. Accepting deletion immediately makes project-secret reads and writes conflict. Providers know nothing about projects.

**Finalizer.** A deterministic-clock loop scans deleting projects every tick. It repairs any child missing a delete intent (`deletion-fanout-repaired`), wakes child reconcilers, computes progress, and does nothing destructive while any child row remains. Then, after the deletion quarantine measured from the request (longer than the bounded secret write, so a pre-fence write cannot land after the scan), it enumerates and destroys every project secret version before removing the pointer, deletes MCP OAuth secrets, and deletes the project row only if a transactional recheck finds zero children. Absence after a competing finalizer is success. Child errors keep the project `deleting` and retry. A restart reconstructs everything from durable rows.

**Progress.** `ProjectView.deletionProgress` (`docs/control-plane-api.md`): `total` is the child count captured at acceptance, `remaining` the current child rows, `blocked` the child intents with a persisted error.

**UI.** **Delete project** (red bin in the shared project header, dashboard and orb index) confirms that the project, every orb, all checkouts, files, compute and conversations are permanently deleted. The browser never deletes orb by orb. While deleting, the project is greyed in place, configuration/create/delete are disabled, its column body is replaced by the progress and sanitized child-blocker line, and the dashboard polls until the project disappears. Deleting an unrelated project from the orb index keeps the current conversation; deleting the current project returns to the dashboard (index selection effects: `docs/web-ui.md`). A deleting project keeps its first-observed ordering; only projects already deleting on first appearance rank last (`docs/web-ui.md`). A failed request leaves the project in place with feedback; no optimistic disappearance.

**Edges** (project-scoped): `deletion-requested` (child count), `deletion-fanout-repaired`, `deletion-blocked`/`deletion-recovered` (blocked and remaining counts), `deletion-retry`/`deletion-retry-recovered`, `deleted`, and `project-deletion-loop-blind`/`-recovered`. Never per pass.

## Self-service CLI

Inside an orb, plain `pi-orb archive` and `pi-orb delete` request archival or deletion of **this** orb; central Pi exposes the same operations as `orb_archive` and `orb_delete` tools. There is no target argument, interactive prompt or `--yes`: the target derives exclusively from caller authority, and a confirmation flag would not strengthen authorization for code already holding the bearer. Agent guidance (environment prompt and tool descriptions) requires an explicit user request for this orb and pushing or exporting needed work first. This is guidance, not a security boundary.

**Routes.** `POST /runtime/v1/orb/archive` and `POST /runtime/v1/orb/delete` accept no body or `{}` and reject extra fields or targets. They acknowledge with `{orbId, state: "archiving" | "deleting"}` once intent is durable, reusing the same domain operations and cleanup machinery: no new state, table, grace period or loop. Browser routes are unavailable under runtime credentials. Extra fields are `400`, invalid identity `401`, incompatible lifecycle or changed authority `409`, and store failures sanitized `503`/`500` in the standard error envelope (`docs/control-plane-api.md`).

**Caller authority.** Runtime callers carry token hash and incarnation (`callerIncarnation`) into the domain CAS loop. Hash, incarnation, absence of a discard fence and lifecycle state are checked atomically at the archive/delete write in PostgreSQL and the simulation store, and revalidated on every CAS retry, so a stopped or replaced incarnation cannot authenticate before a lifecycle change and act on a newer one afterwards. Archive admits new requests from `running` and idempotent retries from `archiving`; delete admits only `running`. This deliberately does not inherit the broker's broader boot-state authorization. Central callers instead must match orb, project, owner and current `agent_admission_version`, with no manual/sleep stop inhibition and the orb not archived or deleting. Browser requests keep their every-state authority.

**Semantics.**

- Self-archive lets the requesting turn finish: archival waits for idle before sealing. The CLI never waits for completion (the waiting tool would keep the agent busy) and prints that archive was requested, that the current turn may finish and that the workspace will be removed. Live browser streaming closes at acceptance; the final reply is readable from replicated history.
- Self-delete does not wait for the turn, children, uploads or a seal; quarantine delays only final row removal, not host destruction. It may kill the CLI before acknowledgement, so neither a tool result nor a final reply is guaranteed. The CLI prints "Deletion requested" only on acknowledgement.
- Requests are bounded. A lost response is reported as unknown acceptance, not failure; an explicit retry while authorized is idempotent. Credentials are revoked at `deleting` (and after archive finalization), so a later `401` proves neither completion nor absence. Concurrent requests yield at most one accepted transition.
- CLI failures are sanitized stderr lines with typed exit classes.

Rejected: a mandatory `--yes` flag; calling the browser archive route, which is not registered on the runtime-facing control-plane URL; runtime-local shutdown or direct provider deletion; graceful self-deletion.
