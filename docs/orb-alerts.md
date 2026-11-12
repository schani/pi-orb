# Orb alerts

An alert tells the user that an orb needs attention. It is a transcript record plus a durable unread flag on the orb.

## Behavior

- Root agents alert with `orb_alert({message})` (central Pi tool) or `pi-orb alert "message" [--request-id <id>]` (any harness). Only the root conversation may alert; local subagents notify their parent instead with `notify_parent` (`docs/pi.md`).
- Alerts go to the user only. They never enqueue parent-orb messages, trigger a turn, enter model context, mutate lifecycle state, wake compute, cancel sleep or change action availability.
- The message appears chronologically in the transcript as an alert band (`docs/design-system.md`).
- A durable orb-level unread flag replaces the orb's state tile with the alert flag regardless of lifecycle or activity state.
- Explicitly selecting the orb clears the flag. The historical alert and its styling remain.

No animation, sound, browser notification, unread count, snooze or severity hierarchy.

## Writing an alert

There is one transcript authority; neither the control plane nor the WebSocket proxy manufactures a second record.

**Request.** `{v:1, message, requestId}`: message nonblank, at most 4,096 characters (the HTTP byte limit allows for JSON escaping), `requestId` 1–128 characters. Response `{v:1, id, duplicate}`, where `id` is the history record ID (`packages/protocol/src/orb-alert.ts`). The CLI calls the local runtime `POST /v1/alert` (32 KiB body limit) with the runtime bearer; it answers only after persistence, `409` on conflict and retryable `503` when unavailable. The browser never calls it; explicit authentication is required because the runtime binds `0.0.0.0`. The bearer is incarnation-scoped, so this route needs no incarnation header.

- **Central Pi.** The execution runtime forwards to the control plane `POST /api/runtime/alert` (bearer plus `x-orb-incarnation`, Pi harness only). The `orb_alert` tool reaches the same writer. The Durable agent appends an `orb.alert` entry to the root conversation in one commit with an `AlertReceipts` document keyed by request ID, after rechecking agent admission. Closing, paused or unadmitted agents reject it.
- **Native Claude.** While ready and accepting, the runtime writes a `pi-orb.alert` platform event directly to normalized history, including `alert: {message, requestId}`.

Both publish a history event with typed `alert` metadata, which lets replication and renderers identify it without parsing text or overflow. A repeated request ID with the same message returns the existing record with `duplicate: true`; a different message is rejected. Shutdown and idle-stop fencing close admission.

**Outcome.** CLI success ("Alert saved") means persisted, not replicated or read. The fleet icon follows normal publication/pull latency; no push channel or distributed two-write operation is added. On an unknown outcome the CLI reports the request ID for explicit retry; there are no automatic retries. Plain-text `pi-orb transcript` exports the message once under an alert heading; JSON keeps the normalized record.

## The unread pointer

`orbs.unread_alert_id` (nullable) is the flag; `OrbView.unreadAlertId` exposes it when set. The transaction that commits replicated or published history advances it to the newest alert in the committed prefix. Replayed records never re-arm a cleared alert.

`POST /api/v1/orbs/:orbId/alerts/ack` takes `{recordId}` and returns `{unreadAlertId: string | null}`. It clears the pointer only if it still equals `recordId`, so acknowledging A can never clear a newer B across tabs, delayed responses or concurrent pulls. Wall-clock ordering is not used. If the browser saw an alert live before it was committed, the service attempts at most two normal pull iterations first; cursor conflicts are bounded too. Exhaustion, or a stopped runtime that cannot supply the record, is a visible retryable failure that keeps the badge; nothing unverified is acknowledged. Responses are non-cacheable: missing orb `404`, unreplicated or non-alert record `409`, unavailable persistence or replication `503`. Acknowledgement never modifies history, lifecycle state or the replication cursor.

The flag is shared orb state, not per-viewer: one pointer, no notification table or read receipts.

## Selection semantics

- Explicit mouse/keyboard selection and foreground direct navigation count as entry. Entry acknowledges the latest alert observed for that entry, not alerts arriving later.
- Resource GETs, prefetch, polling, socket reconnect and an open tab never acknowledge. A new alert on an already-open orb stays flagged until reselection.
- The override lives in the shared status derivation (`lib/project-orbs.ts`, `lib/favicon.ts`) for dashboard, index, Find, orb header and favicon. Clearing restores the current state icon, not the state when the alert arrived. Lifecycle text and actions keep their meaning.
- The icon has an accessible alert label; historical alerts do not re-announce on reload.
- Alert bodies are escaped plain text with preserved line breaks and wrapped long tokens; never HTML or implicit Markdown.
- Acknowledgement failure keeps the flag and offers retry.

## Observability

The persisted alert record and the pointer are the durable evidence. `lifecycle:` edges `alert-published` and `alert-acknowledged` carry orb and record identity only, logged once per committed change. Failed CLI acceptance and failed acknowledgement are reported to their callers. Alert bodies never enter operational logs, and a cleared alert is not proof of comprehension.

## Rejected

- Pi custom messages: they enter model context regardless of their display flag.
- A control-plane-only alert transcript: a second history authority with merge ordering.
- A separate transcript write plus Boolean flag: partial failure yields an alert without a badge or the reverse.
- Unconditional clear: can erase an unseen newer alert.
- Presence-based clearing: dismisses alerts in unattended tabs.
- A browser-only pending acknowledgement (lost when the tab closes) or a durable pending-ack queue (avoidable state).
