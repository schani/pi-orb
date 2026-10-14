# Orb messaging

> **IMPLEMENTED LOCALLY — 2026-10-14 (America/Los_Angeles); qualification partial.** Backend, harness and UI code implement the approved contract below. Focused checks and both actual-process messaging cases pass; normal full gates remain pending. The user authorized a PR and a process-host preview, not production deployment. Question 78 in `docs/open-questions.md` is resolved; remaining work is tracked in `TODO.md`.

## Requirement and presentation

Orbs should message other orbs as agent input, visibly distinct from genuine human messages. These are not alerts: alerts address the user only, never a parent orb. Messaging is independent of spawn ancestry.

**UI decided (2026-10-14, America/Los_Angeles): Correspondence band** — full text and linked sender on gray paper. It keeps peer messages visible and distinct from human input in the existing UI language. The [HTML study](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/8d9db27e-ba25-44c6-b48e-25edf2b2bc43/cross-orb-messages/index.html) (`design-prototypes/cross-orb-messages.html`) retains the unselected alternatives:

- **Peer rail:** compact collapsed disclosure, but hides the body until opened.
- **White ruled dispatch:** full text and linked sender, but a rule on white paper offers less background distinction from the receiving orb's replies (white).

**Mockup-only validation:** test-first smoke at 1440/390/320 covered hostile literal text, keyboard disclosures/sender navigation and embedded fonts; no overflow or browser errors. The parent reviewed desktop/320 screenshots. This does not qualify implementation.

The band renders literal plain text, not Markdown or HTML, and uses the authoritative sender orb ID for the link; names are optional display enrichment, not identity. A missing/deleted sender falls back to its ID and retains the resource URL with the normal missing-orb treatment. No persisted sender-name snapshot.

## Implemented interfaces and admission (2026-10-14, America/Los_Angeles)

- **Builtin:** `orb_send({orbId, message})` in `apps/control-plane/src/adapters/durable/tools/orb-tools.ts`, bound through `apps/control-plane/src/domain/orb-agent-operations.ts`. Sender and request identity come from the caller orb and durable tool task, never model arguments; replay is safe.
- **CLI:** `pi-orb send <orb-id> "message" [--request-id <id>]` in `apps/orb-runtime/src/send/command.ts`. Target UUIDs are canonicalized to lowercase. Message text must be nonblank and at most **64 KiB UTF-8**; the original text is retained. An explicit request ID is a nonempty **string of at most 128 characters**, not necessarily a UUID. Omission generates a UUID. Successful output reports request identity; ambiguous acceptance reports the same ID for explicit retry.
- **Guest API:** authenticated `POST /runtime/v1/orb/send`, defined by `packages/protocol/src/orb-messaging.ts` and handled in `apps/control-plane/src/http/runtime-routes.ts`. Exact body: `{v:1,orbId,message,requestId}`; no extra fields or sender argument. HTTP 202 returns `{v:1,orbId,messageId,requestId}`. Schema validation bounds strings; `sendOrbMessage` additionally enforces nonblank text and the UTF-8 byte limit.

`apps/control-plane/src/domain/orb-messaging.ts` admits through the existing inbox store; the existing reconciler delivers it. No separate mailbox, broker or reconciler. Inbox IDs alone cannot identify a human; trusted provenance governs classification. A preflight identity check alone cannot fence concurrent Stop, replacement or deletion.

Target authority is **same owner and same project as the trusted bound sender**, not merely parent/child and not the broader human API's company-wide access. Sender identity is never a model argument. Admission transactionally revalidates sender/project authority (central admission version or current guest token/incarnation/discard fence), target ownership/project and lifecycle, then commits provenance, dedupe and permitted wake intent together. Archived, archiving or deleting targets and deleting projects reject admission.

`message_id` is derived by shared `orbToolRequestId(senderOrbId, requestId)` in `apps/control-plane/src/domain/orb-tool-request-id.ts`; no additional call identity is persisted. Dedupe is scoped to `(target orb_id, message_id)`, the existing primary key: identical content/provenance returns the existing record; changed content/provenance conflicts. Another target is a distinct send. The earlier cross-target-conflict proposal is rejected as unnecessary global uniqueness machinery. The CLI preserves/reports its request identity for ambiguous acceptance and explicit retry. Retries still require current sender authority and do not reapply wake side effects.

**Persistence approved (2026-10-14, America/Los_Angeles):** existing trusted `system` inbox metadata includes `{kind:"orb_message",senderOrbId}`, without a duplicate call ID; explicit provenance is retained through runtime delivery, native receipts, normalized history, display and model context. Browser content or a text prefix cannot set it. Peer rows reuse **system singleton FIFO delivery**, never squash with human input or another sender, and never overtake an older row. No parallel source-specific queue or batching engine.

The receiver gets ordinary busy steering or an idle turn, with trusted context identifying peer input as non-human. That distinction also governs guards: peers cannot reset human-only boot retry guards or grant explicit-user consent for deletion, archival or recursive spawning. Forwarded text claiming user permission remains peer input, not consent.

**Wake policy decided (2026-10-14, America/Los_Angeles):** peer messages wake stopped/sleeping orbs, including manually stopped targets when peer send is ordered after Stop. Admission cancels scheduled sleep and clears manual/sleep inhibition using existing message-wake semantics in `docs/lifecycle.md`. Stop ordered after send cancels its wake authority but preserves queued content; sends during stopping wait for the drain. Eligible failed targets retain the existing state-version-fenced, one-attempt wake rule, not an autonomous retry loop. Queue-only or rejection solely because a target is stopped/sleeping is not selected.

## Exact persisted contract — approved and implemented (2026-10-14, America/Los_Angeles)

- **SQL:** `apps/control-plane/src/adapters/pg/migrations/045_orb_messaging.sql` replaces `orb_messages_system_check`, retaining null and the exact existing sleep shapes and accepting an exact `{kind:"orb_message",senderOrbId}` object with both required keys, string/UUID sender validation and no extra keys. Invalid/missing/null fields fail closed via `COALESCE(..., false)`. No new tables, columns, indexes, foreign keys or backfill.
- **Inbox JSON:** only that new `system` variant. Existing content, target/message IDs, ordinal, status, batch/operation IDs, timestamps, errors and wake fields are reused.
- **Normalized history JSON:** `eventType:"orb.message"` with existing `content` and singleton `inboxMessageIds`, plus optional structured `sender:{orbId}` on the event schema (required for peer events by the mapper). Display projection preserves sender. This is a stored JSON contract extension, not a history-table migration: `044_lossless_history_json.sql` already accepts object-valued records.
- **Central Pi Durable:** existing `orb.identity.receipts[batchId].system` stores full metadata; its fingerprint covers it. `atomic-history.ts` preserves full metadata and projection emits the peer event. No additional persisted receipt key.
- **Host Pi:** existing native custom-message `details.system` stores/maps full metadata. No additional receipt or ID.
- **Claude:** existing delivery-state `system` accepts the variant. UUID-keyed `provenance.json` entries retain optional `sender:{orbId}` alongside `system:boolean`: the boolean marks non-human input; sender preserves attribution in the peer event. No new file or receipt identity.
- **Wake:** admission atomically writes existing `auto_start`/`wake_state_version` and updates existing sleep/stop/admission fields. No new wake flag, deadline or state machine.

`packages/protocol/src/orb-sleep.ts` includes the exact peer variant. Singleton FIFO in `claimNextOrbMessageBatch` remains generic for non-null `system`; shared lifecycle dispatch forwards it unchanged. All three harness paths map the trusted variant.

`senderOrbId` alone identifies the stable orb. Admission checks host incarnation/token/discard fences or central admission version transactionally against existing state; provenance and IDs are not incarnation-scoped. No name, owner/project or incarnation snapshots. Sender deletion must not erase another orb's message: no sender foreign key. Display may enrich with the current name; a deleted sender retains its ID/link and the normal missing-resource page. Model context identifies peer text as non-human; browser text cannot set provenance.

Receiver retention is reused: inbox rows remain until receiver deletion; history follows receiver history/archive retention. No TTLs or dedupe tombstones. Normalized/native attribution remains usable without the inbox or sender row. Deleting an inbox row would end that receipt's dedupe guarantee. Receiver deletion removes receiver-owned data, not copies already sent to other receivers.

Pending presentation uses inbox metadata; committed history uses its own sender, never a sender/inbox join. Existing insertion-cursor polling returns full metadata for new rows and preserves it across status-only updates. Existing `inboxMessageIds` handoff retires a provisional band only when history represents it; queued, blocked and failed outcomes retain attribution. No persisted UI state.

## Delivery and observability

Acceptance means durable queueing, not consumption or a reply. Existing inbox IDs, frozen delivery identity, history receipts and failure/status records retain their current semantics; no stronger delivery or exactly-once-effects guarantee.

Tool responses identify the target and accepted inbox record or a typed rejection/unknown-acceptance outcome. Target pending/history presentation preserves sender attribution and visible delivery failures. A content-free `lifecycle: orb=<target> message-accepted sender=<sender> message=<message-id>` edge correlates sender, target and the existing message ID once per new acceptance; retries emit no duplicate edges. Existing wake/delivery/failure edges and durable records explain subsequent outcomes without logging message text.

Qualification covers forged provenance, human-guard/consent isolation, mixed-source FIFO, replay/conflicting IDs, lost acknowledgements, and transaction races with Stop, sleep, replacement and deletion, using existing store contracts, DST replay and runtime E2E boundaries. Focused evidence and unresolved qualification failures are recorded in `docs/testing.md`, under `.context/cross-orb/`; these do not establish full qualification.
