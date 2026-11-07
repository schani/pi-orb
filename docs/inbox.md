# Inbox

Every agent input from outside the live agent loop enters one durable, per-orb FIFO in PostgreSQL: browser messages, peer messages from other orbs, the spawn prompt, upload notifications and sleep notices. Abort, settings and compaction remain live-only requests (`docs/runtime-protocol.md`).

## Send-anytime ingress

The browser generates a message UUID and calls `PUT /api/v1/orbs/{orbId}/messages/{messageId}` whether the orb is busy, idle, starting or stopped. `202` means the message is durable in PostgreSQL, not that the agent consumed it. Identical retries return the same resource; different content conflicts. The body is the validated text/image block union, at most 6 MiB serialized (8 MiB body), fixed at or below every harness limit so it is enforceable before a runtime exists; there is no steer/follow-up mode. `202` follows durable commit of the row and wake intent, with status `queued | delivering | delivered | failed`, optional `turn | steer` after admission and a sanitized `error` after non-retryable rejection; retryable failures never change status. Accepted for `creating`, `starting`, `running`, `stopping`, `stopped` and recoverable `failed`; `archiving`, `archived` and `deleting` conflict.

**Poll.** `POST /api/v1/orbs/{orbId}/messages/poll` with `{after: <ordinal>, tracked: <UUID[]>}` (selectors in the body to avoid header limits; bootstrap `{after: 0, tracked: []}`) returns no-store `{items, updates, cursor}`: `items` are full rows after `after` by ordinal; `updates` are content-free metadata (every `OrbMessageView` field except `content` and `system`) for tracked rows at or before `after`; `cursor` is the maximum of `after` and the ordinals in the same snapshot. SQL projects content only for new rows. Invalid selectors fail and preserve the cursor. Later polls track only locally provisional or failed rows, including delivered rows not yet in local history (`docs/postmortems/2026-10-02-inbox-poll-payload.md`).

The browser never chooses between send, steer and queue, and never races an HTTP path against the live socket. Message content terminates at this finite command endpoint; the long-lived live proxy stays content-agnostic. Rejected: keeping `/live` open without a runtime, which would make the control plane impersonate the runtime handshake, retain frames and recover socket-local acceptance after process death.

There is no `expectedHeadId`. A FIFO is append intent: concurrent tabs are ordered by database admission, queued messages cannot all name the same future head, and the replica head may lag live history.

## Storage

`orb_messages` (migration `009_orb_messages.sql`, plus `system` from `025_orb_sleep.sql` and `045_orb_messaging.sql`), keyed by `(orb_id, message_id)`:

| Column | Meaning |
| --- | --- |
| `ordinal` | database-assigned insertion order |
| `content` | validated JSONB content blocks |
| `status` | `queued` \| `delivering` \| `delivered` \| `failed` |
| `delivery`, `operation_id` | observed `turn` \| `steer` and runtime operation, written after delivery |
| `delivery_batch_id` | durable batch identity |
| `auto_start`, `wake_state_version` | message-driven wake intent (below) |
| `last_error` | sanitized terminal failure |
| `system` | null for human input, or exact `{kind:"sleep_wake"\|"sleep_expired",sleepUntil}` / `{kind:"orb_message",senderOrbId}` |

Only authenticated internal enqueue sets `system`; browsers cannot. The check constraint requires exact keys, an RFC UUID sender, no extras, and fails closed through `COALESCE(...,false)`. Inbox rows are commands, not optimistic history: only the agent's persisted record enters `history_records` (`docs/history.md`). Per-orb admission holds the orb row lock through insertion and commit, so a later insertion cannot become visible ahead of an uncommitted lower ordinal. This is a purpose-built FIFO, not a generic job table.

## Wake

Insertion and its wake intent (`auto_start`, `wake_state_version`) commit atomically; admission performs no lifecycle transition. Wake rules: `docs/lifecycle.md` ("Message-driven wake").

## Batching

Delivery is strict FIFO with provenance-preserving partitions. Contiguous human rows share a batch; each system row is an immutable singleton barrier, never squashed with human or other-sender input and never overtaken, and renders as a notice, never a human turn. Delivery and `OrbMessageView` carry optional `system`; HTTP delivery must preserve it (`docs/postmortems/2026-10-07-sleep-notice-user-turn.md`). Human content is joined in FIFO order with one empty line (`\n\n`) between submissions; text and images otherwise stay lossless.

Claiming the head atomically assigns every currently queued eligible row to batches; later arrivals wait for the next claim. Singleton batches use the member UUID; multi-member batches use a deterministic UUID derived from ordered membership. Existing claims keep their batch IDs and immutable retry payloads. Host-runtime delivery addresses a batch by its first message ID. Cancelling an unadmitted member detaches the remaining rows to queued/null-batch, so changed membership gets a new identity; failure updates are fenced by the captured batch UUID.

## Delivery

The existing per-orb reconciler is the dispatcher: inbox commit nudges it immediately, and ordinary scans recover work after process death. No broker or extra loop. Durable FIFO claims and dedup recheck agent admission before delivery. Polling lanes keep central input independent of history catch-up (`docs/history.md`).

**Delivery choice** is state-derived by the agent plane, never browser-selected and never based on the control plane's lagging activity observation:

- busy central Pi → native steering into the existing operation; acceptance does not interrupt in-flight inference;
- busy Claude → the batch stays claimed in the inbox until native admission is available (the runtime answers retryable `503 message_unavailable`);
- idle → an ordinary new turn with a new operation ID.

**Central Pi snapshot admission.** `Store.claimOrbMessageBacklog` atomically freezes the complete eligible outstanding FIFO. Required `AgentPlane.deliverMessage` admits one partition; optional central-only `deliverMessages` admits several ordered partitions, with no sequential fallback. Its outer `ResultAsync` reports whole-call failure; ordered inner `Result`s carry each partition's outcome. Native input-only `Conversation.submitMany` admits them atomically before inference can be scheduled, keeping each partition's identity and receipt. Idle admission places the snapshot together; busy admission queues it for the next steering boundary without interrupting the current model request. Failed-run policy: `docs/pi.md`. A duplicate-only `submitMany` also drains an idle inbox. Active reopen recovers queued input after recovery/admission guards; passive read-only open does not. Stop/Sleep/admission fences stay authoritative: Native-accepted input drains after Sleep, unadmitted input waits for a legitimate wake, and retry never renews wake authority. Rejected: a dispatcher loop alone (reclaims the same SQL head until placement replicates) and `steeringMode: all` alone (cannot drain the SQL backlog). Postmortem: `docs/postmortems/2026-10-18-peer-inbox-stall.md`.

**Receipt identity (central).** Native returns transient `{submissions,busy,inputId?}` from its admission commit; fresh/queued classification uses committed ownership plus postcommit aggregate activity. Finalized duplicates keep their operation/delivery. Never-finalized settled partitions in one retry snapshot share the snapshot's first such Native submission ID as a canonical fallback with provisional delivery; this neither reconstructs the historical run nor binds to an unrelated current one.

**Claude** receives one partition through runtime `PUT /v1/messages/:messageId` with `{v:1,messageId,messageIds,content,system?}`; `messageId` must equal `messageIds[0]` and the path. Response `202 {v:1,messageId,status:"queued"|"persisted",delivery:"turn"|"steer",operationId,duplicate}`. Invalid bodies are `400 invalid_request`; agent failures are `503 message_unavailable` with typed retryability.

**Terminal failures.** The dispatcher obeys the runtime client's retryability, because head-of-line blocking turns a permanently undeliverable batch into a wedged inbox. Retryable failures (timeout, unreachable, `history_unavailable`) leave the batch claimed for the next pass; delivery is idempotent under the batch ID. A non-retryable rejection fails the whole batch in one write: every member becomes `failed` with the sanitized reason in `last_error` and its wake cleared, which unblocks the next message. Nothing is discarded; failed rows stay readable through poll.

**Delivery note.** The observed `turn`/`steer` and operation ID are written by a second store call after delivery returns, and replication may already have marked the rows delivered. The note therefore applies to `queued`, `delivering` and `delivered` rows and never downgrades a delivered status.

## Exactly-once logical delivery

One delivered batch produces exactly one durable record, every member ID is marked delivered exactly once, FIFO holds, and no second turn starts. The delivered record is itself the user message: its receipt carries every constituent inbox ID (`inboxMessageIds`), it maps and renders as an ordinary user message, and its content is ordinary model context. No marker plus second record.

- **Central Pi** submits with durable native request identity `inbox:<UUID>`; native state, public projection and receipt updates share one PostgreSQL transaction. Only durable inbox UUIDs enter `inboxMessageIds`; browser request tokens are not acknowledgement authority. Duplicates join the existing identity.
- **Claude** commits submitted-input provenance before enqueue and derives the canonical receipt from complete native history. Retries verify retained receipt identity before enqueueing. Dedup order: persisted session record first, then the incarnation's in-memory pending-batch set, then enqueue. Uncertain ownership fails visibly rather than replaying side effects (`docs/claude.md`).
- Acknowledgement follows the replicated receipt commit, never transport success alone: a runtime acknowledgement is a hint, and the batch stays claimed and is redelivered every pass until the replication transaction marks all member rows delivered (`docs/history.md`). Message and event records may both carry `inboxMessageIds` (Pi's `details.messageIds` maps to it); replication acknowledges by them regardless of record kind. Fetching boot context is not acknowledgement. After Claude compute recovery, canonical receipts are pulled before any retained batch is redelivered (`docs/lifecycle.md`).

Harness adapters must preserve durable message identity in their native records; a harness that cannot must reject durable offline acceptance rather than weaken to duplicate-prone delivery.

## Cancelling a queued message

Central only. Abort with `operationId: "inbox:<UUID>"` cancels by durable inbox identity, outside the resource-loading queue and without loading a Harness. The orb-locked transaction checks actual native submission and batch membership, using the selected row's canonical UUID so a differently cased ID cannot bypass committed admission. If native admission won first, Abort delegates to the active operation. Cancellation winning prevents native admission atomically; cancelled frozen-batch members detach surviving rows into a new batch, and a late old-batch failure cannot fail them. Abort never matches a historical receipt for an unrelated later turn. A queued native abort with no public representation records app failure `Cancelled after agent admission`. An active request with no loaded engine reports retryable `history_unavailable`.

## Observability

Inbox rows are user-visible resources. Poll restores statuses after reload; the UI shows each pending item once as a provisional user turn with its queued/steering state, and a delivered item stays provisional until the record carrying its ID is applied locally, because inbox polling and live history are independent channels. Several provisional turns may collapse into one committed squashed turn; system rows stay provisional until a replicated event names their inbox IDs. A `failed` message stays visible with its reason. On a failed orb, `queued`/`delivering` rows display `blocked` without changing durable status or identity; delivered-but-unreplicated rows stay delivered (`docs/postmortems/2026-10-09-glideos-delivery-blocked.md`). Rendering: `docs/web-ui.md`.

Edge-only `lifecycle:` records carry orb and message IDs, never content: `message-queued` (with `wake: requested` when set and the orb state that decided it), `sleep-cancelled`, `message-batch-dispatched` (batch ID, count, observed `turn`/`steer`; exactly once per batch even with concurrent dispatchers), `message-batch-failed` (batch ID, count, runtime error code/message), `message-accepted` (peer), `spawn-accepted`, `central-delivery-blocked` (Sleep deferral).

## Peer messages

An orb agent can message an independent agent in another orb owned by the same user. Peer messages are non-human input, independent of spawn ancestry; local subagents use `notify_parent` instead.

**Interfaces.** Sender and request identity come from the authenticated caller or durable tool task, never model arguments.

- Builtin `orb_send({orbId,message})`.
- CLI `pi-orb send <orb-id> "message" [--request-id <id>]`: canonical lowercase target UUID; nonblank text up to 64 KiB UTF-8; request ID a nonempty string up to 128 characters (generated UUID if omitted). Success and ambiguous acceptance print the request ID for explicit retry.
- Guest API `POST /runtime/v1/orb/send` with exactly `{v:1,orbId,message,requestId}` → no-store `202 {v:1,orbId,messageId,requestId}`. Schemas: `packages/protocol/src/orb-messaging.ts`; service: `apps/control-plane/src/domain/orb-messaging.ts`.

**Admission** reuses inbox admission; no mailbox or broker. One transaction locks the source project, then caller and target orb rows in ID order, then reads the target project to check same owner and both projects active, sender authority (central admission version, or guest token/incarnation/discard fence) and target lifecycle. Archiving/archived/deleting targets and deleting projects reject. Provenance, dedupe and wake commit together; preflight alone cannot fence Stop, replacement or deletion. Project deletion marks child orbs deleting atomically, so the target orb lock fences deletion without locking the target project.

**Dedupe.** `orbToolRequestId(senderOrbId,requestId)` derives `message_id`. The existing `(target orb_id,message_id)` key returns the original for identical content/provenance, conflicts on change, and treats another target as a distinct send. Retries require current authority and never renew wake or cancel sleep again.

**Wake.** Ordinary message-driven wake applies to stopped/sleeping targets, including manually stopped ones; Stop after send cancels wake authority, not content. Sends during stopping wait for drain. Failed targets follow the one-attempt rule (`docs/lifecycle.md`). Rejected: queue-only, or rejecting stopped/sleeping targets.

**Busy targets.** Busy central Pi peers use native `whenBusy: steer` within the current operation, in shared SQL FIFO order. Pending child-result waits yield without cancelling the child; arbitrary tools must still return. Fresh peer admission cancels a pending sleep deadline; a later Sleep/Stop outranks earlier admission. Busy acceptance reports `delivery: "steer"` with the current operation ID. A receipt captured before rejected native admission is not a duplicate: the first successful submission returns `duplicate:false`. Sleep rejection is retryable and pending rows stay visible. Human and peer steering already accepted by Native may drain after Sleep: a matching durable native record or finalized receipt bypasses new-admission fencing, including placement before receipt finalization, and the native admission transaction checks sleep under the orb lock. Unadmitted rows wait for a legitimate wake, do not block the sleep stop, and cannot be overtaken by direct browser input. Rejected: rejecting busy peers, claim-only fencing (misses queued native steering), cancelling Sleep on old claims or retries (reverses command order), native placement/lease suspension.

**Provenance.** This is the single statement of peer provenance. Trusted `OrbMessageSystem` `{kind:"orb_message",senderOrbId}` is set only by authenticated delivery; browser messages cannot supply it, and text prefixes or Claude native origins never grant it. It travels unchanged through delivery, native receipts, history, display and model context:

- History: an `EventRecord` with `eventType:"orb.message"`, original `content`, singleton `inboxMessageIds` and `sender:{orbId}`. Mappers require `sender` for peers; malformed peer receipts fail mapping instead of becoming human input.
- Central Pi: `orb.identity.receipts[batchId].system` keeps the complete metadata under its fingerprint; atomic projection preserves it.
- Claude: delivery-state `system` accepts the variant; UUID-keyed `provenance.json` adds optional `sender:{orbId}` next to `system:boolean`, requiring a valid sender and singleton identity.
- Codecs decode delivery or committed receipts into a transient `SystemInput`; one shared constructor builds the peer event and public body, constructing it directly from placed native content without an intermediate human record. One renderer adds a model-only, stable-ID source label stating the input is not a human request or consent; only that label is excluded from public content.
- Peers cannot reset human-only boot retry budgets, settle exhausted interruption evidence, or grant explicit-user consent for deletion, archival or recursive spawning, even when forwarding permission claims.
- Display keeps sender and body independently of the sender orb and inbox row. Plain-text transcript export prints source and body once; JSON keeps the event. Presentation: `docs/web-ui.md`.

Acceptance promises queueing, not consumption, reply or exactly-once effects. The sender ID is not incarnation-scoped; no sender name/owner/project snapshots or sender foreign key. Received messages survive sender deletion. Inbox dedupe lasts until receiver deletion; history follows receiver retention and archive. Receiver deletion does not remove copies sent elsewhere.

## Spawning

`pi-orb spawn` lets an agent create an independent orb in its own project with an initial prompt and receive its browser URL. It is a narrow runtime-authenticated mutation over the ordinary lifecycle and inbox: no worker, orchestration loop, parent/child lifecycle, result callback, wait/cancel protocol or scheduler. Cross-project spawning, quotas and TTLs are out of scope (question 29 in `docs/open-questions.md`).

The new orb gets a fresh workspace (default-branch checkout, or an empty directory without a repository), normal project secrets, boot hooks and agent configuration. It inherits the caller's harness unless a model is given, and always the caller's stored user time zone (including `NULL`), read under the same transaction fence. It inherits no model settings, workspace or conversation; the prompt must carry needed context and name pushed commits/artifacts. Central `orb_spawn` tells the model "Orbs do not share workspaces." The orb survives the caller stopping, archiving or deleting; project deletion removes both. Agent instructions forbid recursive fan-out without user direction.

**Model selection.** Optional `model` is canonical `{provider,id}`, e.g. `orb_spawn({prompt, model:{provider:"claude",id:"sonnet"}})` or CLI `--model claude/sonnet`. The provider selects the harness (`openai-codex` → Pi, `claude` → Claude). Before new acceptance, one availability check consults only that provider under the project owner: Pi uses its eligible-model policy and the owner credential broker; Claude uses `ClaudeSubscriptionAuth.grant` and an input-free SDK `supportedModels()` query without a session. Invalid, unadvertised or disconnected models return `invalid_request`; lookup failures retryable `unavailable`. The owner observed before the check is fenced under the project lock at acceptance. Migration `046_orb_initial_model.sql` adds nullable immutable `orbs.initial_model` JSONB, committed with creation. Rejected: merged catalogs, alias resolution and storing intent only in native settings (a crash before bootstrap would lose it).

**Bootstrap.** Runtime `POST /runtime/v1/orb/boot-context` returns `{v:1,context,userTimeZone,initialModel?}`; `initialModel` is omitted exactly when stored intent is null, otherwise it is the exact `{provider,id}`, and present-null or malformed refs reject. It seeds only a fresh native session and never replaces restored settings. Central sessions receive the same intent through `initialSettings`. A model removed after acceptance fails durably with `no_model` at first generation, not at readiness. `context` (sleep wake): `docs/lifecycle.md`.

**CLI.**

```sh
pi-orb spawn --prompt 'Implement the parser tests and push your branch.'
pi-orb spawn --prompt-file task.md --name 'Parser tests' --json
pi-orb spawn --prompt-file - < task.md
pi-orb spawn --prompt 'Review the parser.' --model openai-codex/gpt-6.1-sol
```

Exactly one prompt source; nonempty UTF-8; the serialized request is limited to 1 MiB; file/stdin reads are bounded. `--name` uses normal name validation. Stdout is one absolute URL; `--json` returns `{orbId,projectId,url,messageId}`; diagnostics go to stderr. Success means the orb and its initial message committed, not that boot or the task succeeded; no browser is needed to start delivery. `--id <uuid>` chooses the orb ID and is the retry key (generated if omitted, lowercased); the initial message ID equals the orb ID. One request, 10-second deadline, no automatic retry: network errors, malformed or lost responses and retryable server errors report unknown acceptance and the ID to reuse with the same prompt/name/model. Exit codes: 2 invalid input, 3 unauthorized, 4 conflict/missing, 6 retryable/unknown, 7 internal.

**Runtime API.**

```text
PUT /runtime/v1/orbs/:orbId/spawn
Authorization: Bearer <per-incarnation runtime bearer>

{ "prompt": "...", "name": "optional", "model": { "provider": "claude", "id": "opus" } }

202, Cache-Control: no-store
{ "orbId": "...", "projectId": "...", "url": "https://<app-origin>/orbs/<id>", "messageId": "..." }
```

Native `orb_spawn` and this route share `OrbSpawnRequestSchema`; extra fields are rejected. Caller and project come from the bearer. Requests require a running caller whose token hash and incarnation match and whose discard fence is absent, rechecked at the mutation boundary. The transaction locks the project, then the caller, and inserts the `creating` orb (with the caller's time zone and `initial_model`), its queued inbox row (`auto_start = false`, since `creating` already requests startup) and an immutable `orb_spawns` row together. Normal reconciliation survives process loss, including loss of the post-commit nudge.

`orb_spawns` (migration `014_orb_spawns.sql`): target `orb_id`, `project_id` (cascade on project delete), `caller_orb_id`, `caller_incarnation`, SHA-256 `request_hash` of prompt/normalized name/canonical model, `accepted_at`. No prompt or bearer. No foreign key to caller or target: deleting either must not cascade, erase provenance or allow silent recreation. Rows are project-owned retry tombstones.

Identical retries by a currently authorized caller return the original IDs without inserting or redelivering; comparison uses the immutable fingerprint, and accepted IDs skip the mutable availability check. Changed body or caller, an unrelated ID collision, or a deleted/archiving/archived/deleting target returns `409`. Incarnation is provenance, not the retry key: a currently authorized replacement incarnation of the same caller may recover an ambiguous spawn; a retired bearer never regains authority. Errors: `400` invalid, `401` identity, `409` conflict, `503` retryable storage, `500` invariant. Prompt and bearer never appear in logs.

The URL is `PI_ORB_APP_ORIGIN` + `/orbs/<id>`, never derived from the runtime service URL or Host header. Split deployments must configure the browser origin; combined local deployments default to the control-plane origin.

**Relations.** Browser orb views expose the immutable caller as optional `OrbView.spawnedByOrb`, kept after caller archival/deletion and used only for derived nesting (`docs/web-ui.md`). Native `orb_self` and `pi-orb self` report parent and direct children from `orb_spawns` (`docs/control-plane-api.md`). `spawnedByOrb` distinguishes orb provenance from a local subagent's parent. There is no completion notification; inspect progress with `orb_transcript` or `pi-orb transcript <id>`.

Rejected: browser `/api/v1/*` calls from the CLI (the runtime-only service registers no browser routes); create-then-send (a crash strands a promptless orb); a spawn worker or direct prompt injection (lifecycle and inbox already recover).
