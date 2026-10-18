# Orb messaging

**Implemented locally — 2026-10-14 (America/Los_Angeles); qualification partial.** Scoped checks and both actual-process messaging cases pass; full gates remain pending (`docs/testing.md`, `TODO.md`). The user authorized a PR and process-host preview, not production deployment. Orb messaging question 78 in `docs/open-questions.md` is resolved.

## Decisions (2026-10-14, America/Los_Angeles)

Peer messages are non-human agent input, independent of spawn ancestry; alerts address the issuing orb's user, never its parent. **Selected: Correspondence band**, full literal text and linked sender on gray paper, distinct from black human input and white receiving replies. The approved [hosted HTML study](https://files---pi-orb-issuer-1077475695242.us-central1.run.app/s/8d9db27e-ba25-44c6-b48e-25edf2b2bc43/cross-orb-messages/index.html) retains rejected **Peer rail** (collapsed disclosure hides the body) and **White ruled dispatch** (less background distinction from replies).

**Wake:** reuse message-driven wake for stopped/sleeping targets, including manually stopped targets when send follows Stop. Admission cancels scheduled sleep and clears existing inhibition; Stop after send cancels wake authority, not queued content. Sends during stopping wait for drain. Eligible failed targets retain the existing state-version-fenced one-attempt wake rule (`docs/lifecycle.md`). Rejected: queue-only or rejection solely because stopped/sleeping.

**Steering and Sleep ordering (decided 2026-10-16; local, undeployed):** busy central Pi Durable peers use native `whenBusy: steer`, retaining the current operation. Pending child-result waits yield without cancelling the child (`docs/subagents.md`); arbitrary tools/scripts must still return. Fresh peer admission cancels a pending deadline; later Sleep/Stop outranks earlier admission. Native-accepted input drains after Sleep, including before receipt finalization; unadmitted input waits for legitimate wake. Browser steering cannot bypass held SQL input. Retry never renews wake authority. Admission fencing and rejected busy-peer deferral: `docs/orb-sleep.md`.

## Interfaces and admission

- **Builtin:** `orb_send({orbId,message})` sends to another agent in an independent orb without a shared filesystem; local subagents coordinate through `notify_parent` instead (decision 2026-10-17). Sender/request identity comes from the authenticated caller/durable tool task, never model arguments.
- **CLI:** `pi-orb send <orb-id> "message" [--request-id <id>]`; canonical lowercase target UUID, nonblank original text up to 64 KiB UTF-8, request ID a nonempty string up to 128 characters (generated UUID if omitted). Success and ambiguous acceptance report the request ID for explicit retry.
- **Guest API:** authenticated `POST /runtime/v1/orb/send`, exact `{v:1,orbId,message,requestId}`, no extra fields/sender argument; no-store HTTP 202 `{v:1,orbId,messageId,requestId}`. Protocol: `packages/protocol/src/orb-messaging.ts`; service: `apps/control-plane/src/domain/orb-messaging.ts`.

Existing inbox admission/delivery is reused, without a mailbox, broker or reconciler. A transaction locks the active project before caller/target rows in ID order and revalidates **same owner and project**, sender central admission version or guest token/incarnation/discard fence, and target lifecycle. Archiving/archived/deleting targets and deleting projects reject admission. Preflight alone cannot fence Stop, replacement or deletion. Provenance, dedupe and permitted wake commit together.

Shared `orbToolRequestId(senderOrbId,requestId)` derives `message_id`; existing `(target orb_id,message_id)` dedupe returns identical content/provenance, conflicts on changed content/provenance, and treats another target as a distinct send. Retries require current authority and never renew wake/cancel sleep again. Rejected: cross-target conflict/global uniqueness machinery and duplicate persisted call identity.

## Exact persistence approved and implemented (2026-10-14)

- **SQL/inbox:** `045_orb_messaging.sql` replaces only `orb_messages_system_check`, retaining null/exact sleep variants and adding exact `{kind:"orb_message",senderOrbId}` with both required keys, string/RFC UUID validation, no extras, and `COALESCE(...,false)` fail-closed validation. No new tables, columns, indexes, foreign keys or backfill; existing IDs, content, ordinal, status, delivery/error/wake fields remain.
- **History JSON:** `eventType:"orb.message"`, original `content`, singleton `inboxMessageIds`, and structured `sender:{orbId}` (optional on event schema, required for peers by mappers). Display preserves sender; existing object-valued history storage needs no migration. Native origins/text prefixes cannot grant attribution; malformed peer receipts fail mapping rather than become human input.
- **Central Pi Durable:** existing `orb.identity.receipts[batchId].system` retains complete metadata covered by its fingerprint; atomic/public projection preserves it. No new receipt keys/IDs.
- **Claude:** existing delivery-state `system` accepts the variant; UUID-keyed `provenance.json` adds optional `sender:{orbId}` alongside `system:boolean`, requiring valid sender and singleton inbox identity. No new file/receipt identity.
- **Wake:** existing `auto_start`/`wake_state_version` and sleep/stop/admission fields change atomically; no new flag, deadline or state machine.

Trusted `OrbMessageSystem` provenance traverses delivery, native receipts, history, display and model context. Non-null system rows are singleton FIFO barriers: no peer/human or cross-sender squash, no overtaking. Peer input carries a stable-ID non-human/non-consent label; only that generated label is excluded from public content. Peers cannot reset human-only boot retry guards or grant explicit-user consent for deletion, archival or recursive spawning, even when forwarding permission claims. Receipt/replay/acknowledgement semantics remain unchanged; acceptance promises queueing, not consumption, reply or exactly-once effects.

Stable sender ID is not incarnation-scoped; no sender name/owner/project/incarnation snapshots or sender FK. Sender deletion preserves received messages; attribution survives sender/inbox removal. Inbox retention/dedupe lasts until receiver deletion, history follows receiver retention/archive; no TTLs/tombstones. Receiver deletion does not remove copies sent elsewhere.

**Projection decision (2026-10-15; prototype, unqualified):** codecs decode authenticated delivery or committed receipts into transient `SystemInput`; one constructor owns peer event fields and public-body formatting, and one renderer adds model-only context before provider image encoding. Native peers project directly from placed input, without an intermediate human record. SQL/wire/native formats, Sleep and #108 notification constructors remain unchanged. A broader shared Sleep/platform/child constructor was rejected: baseline churn increased owned production review from 239 to 290 lines against Main `6d1cecb`, including the new helper. Evidence: `.context/cross-orb/redesign112/`.

## Presentation and observability

Tool responses identify target/inbox record or typed rejection/unknown acceptance. Pending/history bands retain sender/body and visible durable errors (`docs/web-ui.md`). One content-free `lifecycle: orb=<target> message-accepted sender=<sender> message=<message-id>` edge correlates each new acceptance; retries emit none. Existing wake/delivery/failure edges, native history and inbox status/errors explain subsequent outcomes without logging message text.

Busy peer acceptance reports `delivery:steer` with the current operation ID; native history and replicated singleton receipts expose consumption. A receipt captured before rejected native admission is not duplicate acceptance: first successful submission returns `duplicate:false`, then exact retries deduplicate. Sleep rejection remains retryable; `central-delivery-blocked` records the content-free deferral edge and pending inbox rows remain visible.
