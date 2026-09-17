# Scheduled orb sleep

> **Status:** Approved, implemented DST/tests first, and qualified locally 2026-09-17; Slender sleep tile implemented locally; not deployed. Results: `docs/testing.md`.

## Decision and scope

`pi-orb sleep 1h` schedules a graceful stop/start of this orb, retains its workspace, then gives the first wake-triggered inference one combined restart/sleep notification. It is not RAM suspend and adds no lifecycle state.

The deadline is control-plane durable acceptance time plus the requested duration. The CLI prints that absolute deadline. It is not measured from response receipt, drain completion, or host stop. A request may use any positive safe-integer duration in seconds whose resulting date is representable; there is no arbitrary maximum wait.

Sleep waits for aggregate root, child, and handoff work; admitted uploads; and the pending inbox to drain. It then uses the existing prepare-idle-stop admission barrier before final history drain and host stop. Visible browser presence does not postpone sleep. The deadline is accepted even when work may outlast it: expiry while still running cancels the stop rather than killing work.

## Admission and storage

`POST /runtime/v1/orb/sleep` is authenticated to the current self/incarnation. Its body is `{v:1,durationSeconds: positive safe integer}` and success is `202 {v:1,sleepId:string,sleepUntil:ISO}`. Deadline calculation and representability validation occur after acquiring the orb row lock, so database lock contention does not consume the requested duration. The CLI accepts positive integer `s`, `m`, `h`, or `d` durations, returns after one request, and never retries HTTP automatically. A second active sleep conflicts; a lost response leaves acceptance unknown. Orb status reveals a pending sleep, but its absence cannot distinguish rejection from subsequent cancellation or expiry.

The orb row gains only two nullable fields:

- `sleep_id`, a generated UUID and notice identity;
- `sleep_until`, the accepted absolute UTC deadline.

Migration `025_orb_sleep.sql` follows the credential-owner migration `024`. Its new fields are nullable, the widened stop-reason check still accepts every old value, and absent message provenance remains `NULL`, so supported old runtime writes remain valid under the migration rule in `docs/deployment.md`. A database check requires both sleep fields to be null or both set. `OrbView` exposes only optional `sleepUntil`. There is no appointment table, outcome table, generalized idempotency ledger, per-orb timer, or scheduler. Every sleep mutation bumps `state_version`; later work compares the sleep ID and version. Lifecycle edges durably record acceptance, waiting, stop initiation, cancellation, expiry, wake, failure, and delivery outcome without logging message content.

## Lifecycle

```text
running + pending sleep
  -> stopping (reason=sleep)
  -> stopped + pending sleep
  -> ordinary queued-message start
```

While running, sleep waits until aggregate work, admitted uploads, and existing inbox deliveries are complete. The reconciler enters `stopping`, then calls the existing prepare-idle-stop operation before final history drain. A busy result leaves the orb in `stopping` and preserves the sleep; it does not reopen admission. The sleep-stop CAS requires the deadline still to be in the future and no admitted upload. Once stopping begins, it finishes before wake handling. A long busy wait does not consume the later drain deadline: its process-local clock begins at successful admission preparation and survives drain/provider-stop retries within that stopping episode. Control-plane restart safely grants a fresh drain window; runtime admission remains fenced. At the deadline the sleep is due, never early.

If the deadline arrives while the orb is still `running`, one atomic write clears the sleep and enqueues a system `sleep_expired` notice without stopping. If it arrives while `stopping`, stopping finishes first. If the orb is `stopped` or `failed`, one atomic write checks sleep ID, deadline, lifecycle state, and `state_version`, clears the pair, and enqueues `sleep_wake` with current wake authority. The notice message ID equals `sleep_id`. Duplicate reconcilers produce one logical notice; stale work cannot consume a replacement sleep. The scheduler checks wall-clock deadlines without waiting for its terminal backstop, including forward clock jumps. Sleep deadlines never override error backoff or invariant-error parking. Failed wake retains the existing one-shot rule: failure and the queued notice remain visible, with no autonomous retry loop.

Accepted manual Start—including a running no-op—Stop, a message from an actual human, archive, or delete atomically cancels the pending sleep. Rejected Start while `stopping` changes nothing. Stop also clears wake authority already created for the notice while preserving the inbox row. Stop acknowledges only confirmed cancellation: transaction failure rolls back state and authority; lost commit acknowledgement leaves the outcome unknown. During a graceful sleep-stop, explicit Stop takes over as ordinary controlled Stop without waiting for idle. This starts one fresh stopping episode; repeated explicit Stops do not renew its deadline. Cancellation is tied to the human message admission command, not every internal enqueue: a delayed upload notification and a system notice do not cancel sleep. Old system notices cannot cancel a newer sleep.

Normal sleep reaches stopping only after the existing inbox drains, so the newly enqueued `sleep_wake` is the FIFO head. Exceptional or manual boots still obey FIFO: boot-context selection never skips an older human message merely to find a later sleep notice.

## Inbox provenance and boot context

`orb_messages` gains one nullable, validated `system` JSON field. Absence means human. The initial system shape is `{kind:'sleep_wake'|'sleep_expired',sleepUntil:string}`. Browser clients cannot set it; only authenticated internal enqueue can. Human rows batch only with a contiguous human FIFO head. System rows are immutable singleton deliveries and render as notices, never human turns.

Inbox delivery and `OrbMessageView` carry optional `system`. Both message and event `HistoryRecord` variants may carry optional `inboxMessageIds`; Pi's existing `details.messageIds` convention maps to that normalized field. Replication uses those IDs to retire provisional rows and acknowledge delivery regardless of record kind. Fetching boot context is not an acknowledgement.

Before session attachment, readiness, or inference, the runtime calls authenticated `POST /runtime/v1/orb/boot-context` with `{v:1}`. Token, incarnation, discard fence, and lifecycle authority are revalidated under the same orb row lock that freezes the inbox head; authentication before that transaction is insufficient. The response is:

```ts
{
  v: 1,
  context: null | {
    messageId: string,
    messageIds: string[],
    content: MessageInputBlock[],
    system: { kind: "sleep_wake", sleepUntil: string }
  }
}
```

The control plane selects and freezes only a FIFO-head `sleep_wake`. A human head returns `context:null`; ordinary delivery preserves it first. A typed prerequisite-read failure fails readiness closed and remains visible rather than starting context-free inference.

For the normal wake, the boot planner combines existing restart/interruption wording with sleep context in one visible `pi-orb.sleep-wake` custom record. It retains boot identity, trigger/guard classification, and the notice message IDs. The record is a system event, never a human user message, and cannot renew or reset crash-loop/resume authority. Its identity participates in boot and turn-resume classification. If the crash guard declines inference, the persisted visible non-triggering outcome remains authoritative.

The runtime persists the combined record before inference. A crash before append leaves the inbox notice pending. A crash after append but before replication deduplicates from local session identity; replication later acknowledges the inbox row. There is no separate acknowledgement endpoint. Running-orb `sleep_expired` remains ordinary system inbox delivery.

The guarantee is one logical persisted notice and, after successful delivery, one session record—not exactly one model turn, exactly-once inference, or exactly-once model effects.

## UI and API surface

The existing lifecycle status shows `sleepUntil` as pending/sleeping context; no new controls are added. A sleeping tile is derived only from `state === 'stopped'` plus `sleepUntil`, without a clock or backend state. Its selected Slender crescent asset is shared by dashboard, fleet index, orb header, favicon, and Find; it uses the stopped gray hue and selected rows retain their fill. Running/busy, stopping, failed, and cleanup marks retain precedence. Cancellation clears the deadline and restores the normal stopped tile. The existing Stop action remains available to cancel a stopped orb's scheduled wake or interrupt a graceful sleep-stop; ordinary stopping and terminal cleanup keep their current controls. System inbox rows appear provisionally as notices and retire when a replicated event names their inbox IDs. They never use human-turn styling. Complete browser/API contracts are linked from `docs/control-plane-api.md` and `docs/web-ui.md`; runtime and Pi boundaries are linked from `docs/runtime-protocol.md` and `docs/pi-adapter.md`.

## Deterministic validation

Tests/DST preceded implementation. Concurrency schedules use injected clocks and explicit barriers. Visual regressions pin exact asset geometry, shared favicon/UI parity, precedence, caller metadata propagation, gray/selected-row styling, and browser-visible cancellation across dashboard, index, header, favicon, and Find.

| Schedule | Required result |
| --- | --- |
| Busy caller, child, handoff, upload, or pending inbox; final history during drain | Sleep waits; existing inbox drains; admission closes; final records replicate before stop |
| Deadline while running, preparing, stopping, stopped, or failed; exact boundary | Running expires without stop; stopping finishes then wakes; terminal state wakes once; never early |
| Control-plane crash after acceptance or stop, and before/after due write | Persisted fields recover the same outcome and one notice |
| Wall time advances during control-plane downtime | First reconciliation applies the overdue transition once |
| Two reconcilers observe one due sleep | One clear, wake intent, and logical notice |
| Stop, Start, human message, archive, or delete races due handling both ways | Atomic winner governs; rejected Start and delayed upload notice do not cancel |
| Old due worker races cancellation and a new sleep | Old ID cannot clear or notify for the new sleep |
| Caller incarnation changes; acceptance response is lost | Stale caller is rejected; pending status reveals still-active acceptance |
| Wake fails, then a human recovers it | One-shot wake does not loop; notice remains deliverable and visible |
| Delivery crashes before append or after append before replication | Session identity and inbox reconciliation yield one persisted notice |
| Boot context read fails and recovers | Readiness/inference fail closed, then recover without losing or duplicating notice |
| Older human input or concurrent send surrounds sleep notice | FIFO never skips the human head; source-aware batches do not mix |
| Crash guard declines after combined record persists | Visible decline remains; notice does not grant new resume authority |
| Running expiry is delivered while another operation exists | Ordinary system delivery preserves provenance and does not cancel a later sleep |

Reuse lifecycle DST's production domain/store, fake runtime/provider ports, injected clocks, explicit scheduler checkpoints, and failpoints at atomic boundaries. Store tests cover pair atomicity, notice uniqueness, and source-aware FIFO. Actual-runtime boot DST covers context failure, crashes around append, replication/delivery races, first-inference context, and unchanged resume authority. CLI E2E retains the command result and final reply, observes stop, advances time, and observes one wake notice. Preserve and replay the first DST failure trace before any fix.

## Rationale and rejected scope

Two orb fields plus the existing reconciler, inbox, stop barrier, and replication path satisfy recovery and observability. Appointment/outcome state machines, a generalized idempotency ledger, provider suspend, a `sleeping` state, task scheduling, extra delivery acknowledgement, and a separate eventual-notification turn add machinery without improving the selected contract. Coordinating the FIFO-head notice into the existing boot decision is the smallest design that guarantees sleep context before the wake-triggered inference.
