# Orb alerts

> **Status:** Implemented and locally qualified, 2026-10-01; not deployed. Selected 2026-09-30: plain red flag without `!`, with white text on a red transcript band. Decision: `docs/open-questions.md`, question 71.

## Required behavior

- An orb can issue `pi-orb alert "message"` to alert the user.
- The message appears chronologically in the transcript with distinct alert styling.
- A durable orb-level unread flag replaces the normal state icon with a red alert icon, regardless of lifecycle/activity state.
- Selecting the orb clears the flag. The historical alert and its styling remain.

## Selected design and retained alternatives

[`design-prototypes/orb-alerts.html`](../design-prototypes/orb-alerts.html) ([interactive comparison](https://files---pi-orb-1077475695242.us-central1.run.app/s/5afe1687-87dd-48c8-92fa-44e4883eb5c9/studies/orb-alerts/index.html)) compares five treatments using the current light-only, monospace UI, black user bands, and white agent output:

| Proposal | Transcript | Red icon | Tradeoff |
| --- | --- | --- | --- |
| Signal tile | White message with a thin red left rule | Solid square, white `!` | Closest to existing state tiles; recommended |
| Warning slip | Pale red full-width slip | Outlined warning triangle | Familiar warning language, softer emphasis |
| Bulletin | Red top/bottom rules and a small alert tab | Outlined circle, `!` | Distinct notice boundary, more chrome |
| Interrupt | Red band with white message | Solid diamond, white `!` | Hardest to miss; long messages dominate |
| Margin flag | White message with a hanging flag/edge bracket | Flag | Quiet text surface; less conventional icon |

**Selected (2026-09-30):** combine Margin flag's red flag silhouette, removing its `!`, with Interrupt's reverse band. The other pairings remain unselected. The study preserves the original alternatives and simulates selecting an orb, clearing/re-raising its flag, and changing its underlying state; it does not invoke the CLI or runtime. No animation, sound, browser notification, unread count, snooze, or severity hierarchy.

## Implementation contract

### One transcript authority

`pi-orb alert "message" [--request-id <id>]` calls local `POST /v1/alert` with `{v:1,message,requestId}` and the runtime bearer. Messages are nonblank and limited to 4,096 characters; the HTTP byte limit accommodates JSON escaping. The response is `{v:1,id,duplicate}`. Explicit authentication is required because the runtime server binds to `0.0.0.0`, and tailnet forwarding can expose loopback listeners too. Shutdown and idle-stop fencing close alert admission. A runtime application service validates a bounded nonempty plain-text string and appends a non-model-context `pi-orb.alert` custom entry through the Pi adapter. The normalized event has `eventType: "pi.custom"` and `alert: {message, requestId}`. That typed field lets the web renderer identify it without inspecting harness-native overflow or parsing message text. The alert is not a human message, an instruction to the agent, or a new inference turn.

The synchronous SDK append shares the runtime's session writer; fsync precedes publication and CLI success. Existing live committed-history publication and pull-only replication carry the same record. Neither the control plane nor the WebSocket proxy manufactures a second transcript record. Fresh-session reopen tests and a busy-agent CLI integration test cover persistence without waiting for the invoking tool's turn to end. Plain-text `pi-orb transcript` exports the alert message once under an alert heading; JSON preserves the normalized record.

Initial CLI success means **saved locally**, not **already replicated or read**. The fleet icon follows normal history-pull and metadata-refresh latency. Do not add a push channel or a distributed two-write operation merely to remove that delay. The persisted request identity deduplicates replay. An unknown outcome reports the same `--request-id` for explicit retry; there are no automatic retries.

### A pointer rather than an unguarded Boolean

Migration `028_orb_alerts.sql` adds nullable `orbs.unread_alert_id`. In the existing replication transaction, newly inserted alert records advance it to the newest alert in the committed prefix. Replayed pulls must not re-arm cleared alerts. `OrbView.unreadAlertId` exposes the optional ID; presence is the requested alert bit. Alerts never mutate lifecycle state, wake compute, cancel sleep, or change lifecycle action availability.

A browser acknowledgement names the observed alert record ID. Clear only if it still equals `unread_alert_id`. A click for A cannot clear B, even across tabs, delayed responses, or a concurrent pull. Do not use wall-clock timestamps for this ordering. There is one pointer, no notification table, per-viewer read receipt, or general notification service.

Browser `POST /api/v1/orbs/:orbId/alerts/ack` accepts `{recordId}` and returns `{unreadAlertId: string | null}`. It calls an application service through the history-replication and store boundaries. If the selected view has already received an alert live but it is not replicated, attempt at most two normal pull iterations before acknowledging its ID. Cursor conflicts and integrity handling are bounded too; exhaustion remains a visible retryable failure, never a false caught-up result. Report failure visibly and retain the badge; do not silently accept an acknowledgement that will be undone by later replication. If a stopped/unreachable runtime cannot supply that record, acknowledge nothing unverified. A browser-only pending acknowledgement was considered but loses the user's action when the tab closes; a durable pending-ack queue adds avoidable state.

### Selection semantics (accepted 2026-09-30)

Treat explicit mouse/keyboard selection and foreground direct navigation as entry. Acknowledge the latest alert observed for that entry, not whatever happens to arrive later. Do not acknowledge through resource GETs, prefetch, polling, socket reconnect, or merely leaving a tab open. A new alert on an already-open orb remains flagged until explicit reselection/re-entry. Acknowledgement failure keeps the alert visible and gives the user a retry.

Apply the override in the shared status derivation for dashboard, index, Find, orb header, and favicon. Restore the actual current state icon after acknowledgement, not the state captured when the alert arrived. Lifecycle text/actions retain their meaning. Use an accessible alert label in addition to color; historical alerts do not repeatedly announce on reload.

The flag is shared orb state, as requested, not per-user inbox state. Use existing authenticated resource access and current-incarnation runtime authority. The CLI can alert only its own orb. Alert bodies are escaped plain text, preserve line breaks, and wrap long tokens; they are not raw HTML or implicitly Markdown.

### Touchpoints

- CLI/runtime: `apps/orb-runtime/docker/pi-orb`, runtime HTTP/application service, Pi persistence/mapping adapters.
- Protocol: normalized history event and `OrbView`/acknowledgement schemas in `packages/protocol`.
- Control plane: replication service, store port, PostgreSQL adapter/migration, authenticated route and view shaping.
- Web: `HistoryView.tsx`, shared status derivation in `lib/project-orbs.ts` and `lib/favicon.ts`, entry/acknowledgement handling, and styles.

## Tests and observability

Failing contracts/DST scenarios precede implementation:

- Fresh-session and busy-tool persistence; restart and stopped/archived transcript rendering.
- Duplicate request/pull, response loss, rollback, and concurrent replication workers.
- Acknowledgement of A versus new B in both transaction orders; two tabs and stale responses.
- Live alert before replication, bounded pull failure, reconnect, and explicit reselection.
- Every lifecycle/activity icon overridden; clear restores the latest real state; keyboard/mobile navigation.
- Empty/oversized/multiline/HTML-like text, accessible names, phone wrapping, and no repeated historical announcements.

The persisted alert record and unread pointer are durable evidence. Record content-free `lifecycle:` edges for replicated alert publication and successful clearing, correlated by orb/record/request identity; report failed CLI acceptance and failed browser acknowledgement to their callers. Do not duplicate alert bodies into operational logs, log healthy polling, or call a cleared alert “read” as proof of comprehension. Run full runtime E2E before any deployment touching the runtime server/protocol/harness; browser tests must cover the real CLI-to-history-to-icon-to-clear path, not only study interaction.

Study validation: `design-prototypes/orb-alerts.smoke.mjs` was written first and passes in Chromium after `npm ci`. It checks all five designs, all ten lifecycle/activity selections, exact restored state assets, header/sidebar clearing, keyboard entry, literal unsafe/multiline text, and desktop/390/320px containment. Desktop and phone screenshots were reviewed. These checks validate the mockup only, not the proposed runtime behavior.

## Qualification (2026-10-01)

Tests preceded implementation. Full `npm test` passed 2,325 tests (eight conditional skips) and all infrastructure checks. The final plain-text export correction then passed its seven focused tests. Typecheck and lint pass; lint retains existing warnings.

DST includes 30 concurrent A-ack/B-publication schedules, 30 competing-poller schedules, live-before-pull, bounded conflicts, and pre/post-commit acknowledgement loss. SQL contracts run on PGlite and PostgreSQL. Real-SDK tests cover first-turn persistence/reopen, exclusion from model context, busy admission, shutdown, escaped payload limits, and lost-response identity replay. Publication and acknowledgement log only actual committed edges.

The full Docker E2E run passed 239 cases and exposed three failures in the new fixtures: the A-only route intercepted B's later acknowledgement in both engines, and the CLI test approved an empty login placeholder. First evidence is retained in `.context/orb-alerts/validation/e2e-first-complete.log` and `.context/orb-alerts/evidence/11225796-ac62-4138-b524-d372bf8684fc/`. The one-shot interceptor now waits for B metadata to render before releasing A; login waits for a populated challenge. Both affected files then passed all eight tests, with no unhandled errors, in `e2e-focused-first.log`. No product change or timeout increase was needed. A prior host restart interrupted image setup; that incomplete log is retained separately.

The real CLI case invokes the same request twice inside one active Pi bash tool, observes one replicated alert, verifies dashboard/browser acknowledgement and reload retention, and proves only the ordinary tool-call/completion model requests occurred. Chromium and WebKit cover same-orb Find and delayed acknowledgement; phone tests cover literal hostile text and wrapping. Desktop/phone screenshots in `.context/orb-alerts/screenshots/` were inspected. No deployment.

## Alternatives not proposed

- **Pi custom message:** real SDK reopen tests show custom messages enter model context regardless of their display flag. A custom entry retains the alert without creating model input.
- **Control-plane-only alert transcript:** introduces a second history authority and merge ordering.
- **Separate transcript write plus Boolean mutation:** partial failure can yield an alert without a badge or a badge without history.
- **Unconditional clear:** can erase a newer alert the user never saw.
- **Presence-based automatic clearing:** can dismiss an alert in an unattended open tab.
