# Orb lifecycle

Orb states, commands and reconciliation; message wake, idle stop and sleep; central-agent execution demand; compute replacement and Claude recovery; the orphan sweep; and the lifecycle event log. Provider operations are `docs/host-provider.md`. Archive and delete are `docs/teardown.md`.

## States

The `orbs` row is both reconciliation intent and user-visible state; there is no separate desired-goal enum. Every transition is a `state_version` compare-and-swap; providers are idempotent, so competing reconcilers are harmless. `state_changed_at` anchors transition deadlines and episode memory; ordinary replication writes never touch it. `updated_at` is a general row timestamp.

| State | Reconciler behavior |
| --- | --- |
| `creating` | Ensure the owner's harness and GitHub auth, provision by orb ID, wait for runtime ready. |
| `starting` | Finish any compute discard, apply the spec gate, ensure auth, observe/start or reprovision around the retained workspace, wait for ready. |
| `running` | Observe the host; derive liveness from the ~10 s history pull (guest-hosted) or execution health probes (central placement); deliver inbox batches; check idle and sleep. |
| `stopping` | Finish any compute discard; otherwise close live proxies, prepare the runtime admission fence (idle/sleep), run the final history-pull barrier, stop the host, mark `stopped`. A non-retryable drain failure fails the orb and requests disposal. |
| `stopped` | Start when an outstanding inbox wake intent or due sleep exists; otherwise do no runtime work and reconcile an unexpectedly running host back to stopped. |
| `failed` | Keep workspace, history and error; revoke runtime authorization; converge fenced compute to absence. Start only for explicit intent or a current-failure wake, after disposal; never autonomously. |
| `deleting`, `archiving`, `archived` | `docs/teardown.md`. |

`creating` and `running` stay distinct from `starting`; they are execution states, not agent states. No agent-boot, VM-wait or agent×VM product state machine exists.

Rejected: suspend/resume (`docs/host-provider.md`). Stop/start plus full restart recovery is the only path.

## Commands

- **Create** inserts `creating` and wakes reconciliation.
- **Start** is idempotent in `creating`/`starting`/`running`. From `stopped` or `failed` it clears `last_error`, enters `starting` with a fresh `state_changed_at` and wakes reconciliation. From `stopping` it returns `409 conflict`; the caller retries after stopped. Archived orbs reject it permanently.
- **Stop** atomically cancels scheduled sleep and every message wake intent in every state. From `creating`, `starting`, `running` or `failed` it also enters `stopping` with `stop_reason = manual`; `stopping`/`stopped` keep their state but still perform real cancellation. Success confirms cancellation; transaction failure rolls back; a lost commit acknowledgement is reported as unknown outcome. Rejected: answering `ok` when terminal-state wake clearing failed; it allowed one unwanted wake.
- **Delete** and **archive**: `docs/teardown.md`.
- **Startup preflight.** An optional per-orb preflight runs before explicit Start's early success, sleep cancellation or CAS. A legacy central Pi orb returns `409` with “This orb uses the old Pi backend. Create a new orb to continue.”; inbox delivery terminally fails each claimed batch with that reason, with no compute-failed transition or perpetual retry. Start, health and delivery share one condition edge `central-agent-start-rejected` (typed code, admission generation, public session ID, disposition); cleanup failure logs `agent.startup_cleanup_failed`. Database outages stay retryable.

The process-local live-proxy gate records the `state_version` that entered `stopping` and rejects a connection only while that marker is at least as new as the row the proxy read. Markers are monotone for the process lifetime (`docs/postmortems/2026-09-07-stale-stopping-marker.md`). Inbox admission stays open in `stopping`; it requests restart only after the drain completes.

## Reconciliation

### Scheduling

Per-orb reconciliation is concurrent. The scheduler rescans every 1 s tick, launches each due orb on its own task and keeps an in-flight map so at most one pass per orb runs per process. Cross-orb concurrency is unlimited at POC scale; `SerializedAuthGate` serializes only within one owner, and CAS plus idempotent providers fence brief multi-revision overlap. Shutdown stops dispatch and drains in-flight work; an unexpected worker rejection fails the background loop (`reconcile-task-crashed`) rather than being detached (`docs/postmortems/2026-08-08-serial-reconciler-head-of-line-blocking.md`). Central polling and compute reconciliation run on independent tasks, never coroutines sharing one `SimulationTask` (`docs/postmortems/2026-10-04-central-reconcile-task-sharing.md`).

Admission and explicit Start set the orb's next attempt to now; a 30 s terminal backstop bounds wakes whose nudge was lost with the process (`docs/postmortems/2026-09-07-explicit-start-terminal-backstop.md`).

### Constants

All use injectable clocks (`apps/control-plane/src/domain/constants.ts`).

| Constant | Value |
| --- | --- |
| readiness health poll during create/start | 5 s |
| unreachable-runtime grace | 30 s |
| post-restart grace | 3 min |
| `runtime_never_answered` boot sub-deadline | 12 min native GCE, 3 min Docker/process |
| create/start deadline | 15 min |
| setup-hook hold | 22 min |
| history pull interval | 10 s |
| runtime request timeout | 10 s |
| provider operation bound | 60 s |
| retry backoff | 0.5 s base, capped at 10 s |
| idle stop | 15 min |
| orphan sweep | 5 min |
| deletion quarantine | 65 s |

### Rules

- Retryable provider/network failures leave the transitional state unchanged and retry with deterministic exponential backoff.
- **Store invariants are never retried.** A `StoreError` with code `invariant` is a deterministic bug (bad SQL, unencodable parameter). The reconcile loop, history-pull loop and project-deletion sweep park the subject after one edge carrying `invariant=true` (`reconcile-retry`, `pull-failed`, `deletion-retry`). Parking is process-local, so a fixed deployment resumes normally; the orb is never failed for our own bug. HTTP answers non-retryable `500 internal` (`docs/postmortems/2026-08-11-orb-message-jsonb-param-encoding.md`).
- A non-retryable provider error, a runtime `failed` health, identity mismatch, deadline, `runtime_never_answered`, `auth_failed`, unrecoverable drain or replication-integrity failure enters `failed` through the single fail-and-discard operation (Compute replacement, below). This includes boot failure after automatic preemption recovery (`docs/postmortems/2026-09-30-preemption-boot-context.md`).
- Runtime `failed` health is terminal for that boot, never a level to poll. A runtime owning bounded recovery stays `initializing` until exhaustion (`docs/postmortems/2026-08-09-private-repo-clone-outside-github-app-installation.md`).
- Central-running execution probes consume validated terminal guest health regardless of retryability or central activity. The failure/discard preserves central admission, conversation and history; replacement needs fresh authority. Answered HTTP/schema errors and `initializing` are reachable, not terminal.
- Validated terminal guest health also retires previously-ready compute during `stopping`, including idle/sleep preparation failures; answered preparation errors trigger a health inspection, not failure by status or elapsed time. A failed guest cannot block Stop indefinitely by still answering history requests. Initializing or busy health and local store errors grant no disposal authority.
- Provider absence in `creating`/`starting` calls idempotent `provision`. Absence or unexpected stop in `running` transitions to `starting` and restores the host around the retained filesystem.
- An orb becomes `running` only after ready identity, session and commit are persisted. `last_ready_at` is set on every ready.
- A stopping orb that never reached ready (`last_ready_at` null) and has no `harness_session_id` skips the drain. A definitively absent or already stopped host during `stopping` is marked `stopped` directly; complete records on disk are found at the next start.
- A retryable drain pull/commit failure keeps `stopping` with the host running. Local drain-store errors preserve execution, including across controller restart; invariants keep their message in the drain detail and go to the scheduler's once-only parking. Preparation and history waits have no age-based disposal authority. A non-retryable replication-integrity failure in `running` or a drain fails the orb (`docs/history.md`); during a drain, terminal runtime/provider evidence or corroborated silence after the one permitted restart also authorizes failure, but drain age and local store errors do not.

### Boot deadlines and the setup hold

A `creating`/`starting` orb older than the create/start deadline (from `state_changed_at`) fails `deadline_exceeded`. A later Start begins a fresh deadline. Device-login waits never count: completion re-enters the state with a fresh `state_changed_at`, and a waiting challenge ends at its own expiry.

Boot detection records a per-probe picture (host state, attempts, whether the runtime ever answered, last error), exposed as `waiting_for_runtime` detail. A running host whose runtime never answers within the boot sub-deadline fails `runtime_never_answered` with the probes plus `diagnose()` evidence. A transiently failing `diagnose` defers failure one poll so evidence is not dropped.

The deadline is held while `.agents/setup` runs (`docs/orb-setup-hook.md`). The hold is anchored at the first `setup_running` report of the episode and bounded by `setupHookHoldMs` from that anchor, enough for the hook plus the rest of boot, so a later phase does not end it. Every hold also ends once the episode is `createStartDeadlineMs + setupHookHoldMs` old by `state_changed_at`, because restarts renew in-memory holds (`docs/postmortems/2026-10-10-starting-deadline-restarts.md`). Further rules:

- The hold survives one failed probe and ends after the boot-sized `postRestartGraceMs` of silence. `runtime_never_answered` is never held.
- After a control-plane restart, the deadline waits until the runtime has actually answered this process (a cancelled or refused probe is not evidence), bounded by the boot sub-deadline; the anchor is reseeded from the runtime's reported setup start time.
- A running hook shows `running_setup` only while the runtime answers; otherwise `waiting_for_runtime`.

### Owner-gated device login

Before host work, `creating`/`starting` resolve the project owner's selected harness credential (`pi` → Codex, `claude` → Claude) and then GitHub. Missing credentials keep the orb transitional and start one owner-scoped device flow; challenges and blocked cohorts are keyed by owner UUID and provider, and same-owner Pi and Claude challenges cannot overwrite each other. Completion CAS-reenters matching blocked rows with fresh `state_changed_at`; expiry or denial fails only that cohort. Retryable storage/upstream/SDK errors keep the cohort transitional. Edges `auth-blocked`, `auth-resolved`, `auth-failed` carry owner UUID and provider, never codes, URLs or tokens. Flow details: `docs/credentials.md`.

### Runtime silence and unreachable restart

**Silence is measured at the transport boundary.** The clock starts when a pull, delivery or health request is handed to the runtime client and ends at any HTTP response. HTTP errors and malformed responses prove reachability; connection failure and cancellation do not. Delay before the first request cannot start the grace (`docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`). Central `SdkAgentPlane` starts silence immediately before transport, after its provider observation and incarnation/cancellation checks. Placement, not adapter presence, selects central polling.

**Corroboration.** After the grace, a successful provider observation is followed by a fresh bounded health request. Any answer, including one received concurrently by a pull or delivery, defers restart (`unreachable-restart-deferred` with `runtime_answered_corroboration` or `silence_episode_changed`); a restart logs `corroboration=health_no_answer`. A delivery the runtime accepts also refreshes the liveness baseline (`ControlState.noteRuntimeAnswered`). An egress partition can still fail both requests while provider access works; cross-orb corroboration is not implemented.

Transport failures record headers/body phase, elapsed time, HTTP status, syscall code, cancellation and endpoint origin, never content, paths, queries or credentials. undici's bare `fetch failed` is unwrapped at the adapter (`fetch failed (ECONNREFUSED)`), separating "host up, nothing listening" from routing failures. Failed corroboration records `runtime-health-failed`. Compare with the native supervisor's local health edges (`docs/host-provider.md`). GCE requests use the private VPC.

**Restart shape** (`docs/postmortems/2026-08-05-unreachable-restart-livelock.md`). A restarted host is a booting host; a grace shorter than a boot concludes "unreachable" forever.

- From `running`, the reconciler issues provider stop/start, then CAS-transitions to `starting` with fresh `state_changed_at`, handing recovery to readiness polling, the boot sub-deadline and the create/start deadline. No path restarts a host twice from `running`.
- From `stopping`, the drain cannot be handed off, so the inline restart is bounded twice: its baseline gets `postRestartGraceMs`, and at most one restart per stopping episode. If that baseline expires again with no pull success, the drain fails `drain_runtime_unrecoverable`, logging `drain-restart-cap` first. Any answer vetoes silence-based failure. These bounds are process-local.
- A revision adopts another revision's drain restart: if the observed `lastStartedAt` belongs to this stopping episode and is inside `postRestartGraceMs`, it anchors its grace there and logs one `drain-restart-deferred` per newly observed start. Missing, malformed, future or older evidence keeps the bounded restart (`docs/postmortems/2026-09-07-mixed-generation-drain-restart.md`).
- Baselines seeded by a pull success or by entering `running` get the ordinary grace; only restart-seeded baselines get the boot-sized one.

Rejected: restarting inline everywhere with a larger grace; `running` would still have no deadline and would cycle forever more slowly.

**Restart budget.** Five automatic restarts per rolling hour, recorded in `orbs.auto_restart_times`. Each automatic `running` → `starting` (`no_host_ref`, `host_absent`, `host_observed_*`, `unreachable_restart`) and each central agent open that would resume unfinished tasks (`agent_recovery`, charged before resume) counts, including preemptions and rollovers. The sixth fails the orb `restart_budget_exhausted`; because plain `failed` leaves a central agent running, this also sets `stop_reason = manual` and advances `agent_admission_version`. Explicit Start and message wake clear the record. Unreachable recovery checks the budget after corroboration and before provider stop/start; retryable provider failures consume no slot; the check does not reserve slots across concurrent recoveries. Guest-local restarts inside the grace are not counted (`docs/postmortems/2026-10-09-central-durable-oom-recovery.md`, `docs/postmortems/2026-10-16-c9a30a6d-restart-loop.md`).

**Attribution.** Distinguish unreachable-recovery decisions, completed provider stop/start, admitted recovery transitions and readiness; none proves completed agent work. Attribute Spot preemption only with provider evidence. Correlate guest shutdown admission, provider audit and lifecycle edges before attributing a restart to an extension error (`docs/postmortems/2026-10-04-spot-preemption-loadout.md`).

### Episode-scoped memory

Process memory about an orb between passes (boot probe and its clock, drain status, half-finished restart, liveness baseline and grace) describes one visit to one state. It is keyed by the row's durable `state_changed_at`, checked at the top of every pass, and dropped when it changes. This holds for reconcilers that lost the CAS during a rollover, which otherwise judged the next episode by stale clocks and failed healthy orbs. Forgetting is always safe: it is what a restart loses, and every path reseeds from the row. Within an episode the boot clock restarts whenever the host is observed absent, stopped or failed.

## Message-driven wake

Inbox mechanics, delivery and replication receipts are `docs/inbox.md`. Lifecycle owns the wake:

- Admission records the message row, its wake intent and `last_busy_at` in one transaction and performs **no** transition. The reconciler's terminal backstop transitions through `casStartOrbForQueuedMessage` (one transaction: wake decision plus transition) and logs `transition … reason=queued_message`. Central agents use the same CAS from `reconcileCentralAgent` to move a `failed` orb to `starting` before publication can retire the row.
- Each intent records `wake_state_version`. A `stopped` orb wakes for any outstanding intent, wherever it sits in the FIFO. A `failed` orb wakes only for an intent naming its current `state_version`; the wake bumps the version, so the same intent can never wake it again and an intent from an older failure is inert. A new send buys exactly one further attempt.
- The wake does not clear the intent; it stands until delivered, failed or explicitly stopped, so it is retryable with no second write to strand.
- In `creating`/`starting`/`running` a send only wakes dispatch; in `stopping` it records restart-after-stop and never bypasses the drain. A Stop ordered after a send clears its wake but keeps the message; a send ordered after Stop sets a new wake. A genuinely overlapping stop and send on a `failed` orb may linearize either way; this is accepted at POC scale.
- A terminal boot failure leaves the orb failure and the queued message visible; no autonomous retry.
- Viewing a stopped orb never starts it; sending does. Rejected: warming on view, which started every idle-stopped orb the user looked at.

**Running pass order:** observe host → liveness/unreachable restart → claim and deliver the next batch → idle check. An outstanding batch returns before the idle check, so an undelivered message is activity. A runtime-accepted delivery refreshes `last_busy_at` through `touchLastBusy`, so the idle window measures from arrival, not from queueing.

## Idle auto-stop

- `last_busy_at` (restart-stable) is refreshed through the monotone `touchLastBusy`, which bumps no `state_version`, by a pull observing `busy`, accepted mutating requests, accepted message admission and delivery, and visible browser presence.
- A browser connection counts only while its tab has affirmatively reported `visible` (presence frame on connect and every `visibilitychange`). Unreported counts as hidden, so a lost frame causes an earlier stop, never a leak. Presence is in-memory `ControlState` (`registerBrowserConnection`, `setBrowserVisibility`, `unregisterBrowserConnection`); periodic watched-activity persistence is an idle anchor, not a durable lease. Visible presence keeps a running VM up but never starts a stopped one.
- When `wallNow() - max(last_busy_at, state_changed_at, lastVisibleAt) > 15 min`, the reconciler CAS-enters `stopping` with `stop_reason = idle`. It refuses while the most recent pull observed `busy`, because wall time can leap past the deadline faster than pulls refresh the timestamp.
- Admitted workspace uploads block idle stop for the whole transfer (`docs/workspace-uploads.md`).
- An unexpired preview activity lease blocks idle stop; explicit Stop ignores it (`docs/http-exposure.md`).
- **Admission fence.** Idle `stopping` first calls `POST /v1/prepare-idle-stop` (`docs/runtime-protocol.md`). A busy decline (`prepared:false`) returns to `running` (`idle_stop_declined_busy`); acceptance closes admission for the current execution lifetime (host execution, or the managed supervisor lifetime on process hosts; detached processes are not claimed dead), and the drain edge records `idle_stop_prepared:true`. Explicit Stop does not require preparation. Lost acknowledgements are retried without reopening work. Settings mutation ownership also blocks preparation, and a prepared runtime rejects settings changes (`docs/agent-context.md`). Failures log `idle-stop-prepare-blocked`. Explicit Stop still interrupts uncooperative work (`docs/postmortems/2026-09-14-idle-stop-admission-race.md`).
- Detached background processes are not agent work and do not prevent idle stop (open question 9). The fix, if needed, is OS-level process inspection, not a background-job tool.
- `stop_reason` is `idle | manual | sleep`; the UI shows "stopped (idle)". Start clears inhibition.

## Sleep

`pi-orb sleep <duration>` (central Pi: the `orb_sleep` tool) schedules a graceful stop and a later wake. It retains the workspace and gives the first wake-triggered inference one combined restart/sleep notice. It is not RAM suspend and adds no lifecycle state or provider state. The runtime prompt directs agents to use it rather than timers or shell sleep.

**Admission.** `POST /runtime/v1/orb/sleep` authenticates the current running self/incarnation, body `{v:1, durationSeconds}` (positive safe integer whose deadline is representable; no maximum), success `202 {v:1, sleepId, sleepUntil}`. The deadline is durable acceptance time plus the duration, computed after taking the orb row lock. The CLI accepts `s|m|h|d` integers, prints the absolute deadline, sends one request and never retries; a lost response leaves acceptance unknown. A second active sleep conflicts. HTTP status semantics: `docs/control-plane-api.md`.

**Storage.** Two nullable orb columns, `sleep_id` (UUID, also the notice message ID) and `sleep_until`, both null or both set (check constraint). `OrbView` exposes optional `sleepUntil`. Every sleep mutation bumps `state_version`. No appointment table, scheduler or per-orb timer.

**Stop.** While `running`, sleep waits for aggregate root, child and handoff work, admitted uploads and native-accepted inbox work; unadmitted SQL rows wait for the wake and do not block. Visible browsers do not postpone it. The reconciler enters `stopping` (`stop_reason = sleep`, `sleep-stop-initiated`) only while the deadline is still in the future and no upload is admitted, then prepares the admission fence before the final drain. A busy preparation leaves the orb in `stopping` with sleep preserved. Once stopping begins it finishes before wake handling. After successful history catch-up, provider-stop retries have a process-local budget from successful preparation (renewed on controller restart); corroborated silence keeps its one-restart bound.

**Due handling** runs only in `running`, `stopped` or `failed`, never early, including after forward clock jumps or controller downtime; it never overrides error backoff or invariant parking. Creating/starting finish readiness first; stopping/archiving/deleting finish first.

- Due while `running`: one write clears the pair and enqueues a system `sleep_expired` notice without stopping (`sleep-expired`).
- Due while `stopped`/`failed`: one write checks sleep ID, deadline, state and `state_version`, clears the pair and enqueues `sleep_wake` with current wake authority (`sleep-wake-queued`). Duplicate reconcilers produce one logical notice; stale work cannot consume a replacement sleep. A failed wake keeps the one-shot rule.
- A queued-message start declines while `sleep_id` is set, even overdue; only the due transaction or fresh accepted input/command clears it.

**Cancellation.** Accepted Start (including a running no-op), Stop, fresh human or peer message admission, archive or delete atomically cancels a pending sleep (`sleep-cancelled`). Rejected Start while `stopping`, delayed upload notifications, system notices, and claims or retries of older input do not. Stop also clears wake authority already created for the notice, keeping the inbox row; during a sleep-stop, explicit Stop takes over as one fresh controlled stopping episode. Sleep or Stop after earlier admission wins. Native-accepted human and peer steering may still drain after Sleep; the native admission transaction checks sleep under the orb lock (`docs/inbox.md`). Persisted `sleep` inhibition blocks callers even after the deadline row clears.

**Wake notice.** Sleep preserves FIFO; the `sleep_wake` notice may follow older input, which is never skipped. Central Pi receives it as ordinary native input with restart wording prepended, projected as a `pi-orb.sleep-wake` record. Native Claude, before readiness, calls `POST /runtime/v1/orb/boot-context` `{v:1}`; token, incarnation, discard fence and lifecycle authority are revalidated under the row lock that freezes the inbox head. The response carries `context` (only a FIFO-head `sleep_wake` item `{messageId, messageIds, content, system}`; a human head returns null; fetching never acknowledges) plus `userTimeZone` and `initialModel` (`docs/inbox.md`). The runtime claims the notice's inbox identity before submission and deduplicates crashes from persisted local identity. Each request has a 10 s timeout; retryable failures back off 1/2/4 s up to 180 s; permanent auth, schema failure or exhaustion fails readiness closed (`docs/postmortems/2026-09-18-boot-context-cold-start.md`). The boot planner combines restart wording and sleep context in one visible `pi-orb.sleep-wake` system record that cannot renew resume authority; replication of its `inboxMessageIds` acknowledges the inbox row. HTTP delivery must preserve `system`; omitting it turned a notice into a human turn (`docs/postmortems/2026-10-07-sleep-notice-user-turn.md`). The guarantee is one logical persisted notice, not exactly-once inference.

**UI.** The lifecycle status shows a pending sleep and its deadline; the waiting notice exposes work, upload and drain blockers. A stopped orb with `sleepUntil` uses the sleeping tile across dashboard, index, header, favicon and Find (geometry: `docs/web-ui.md`), derived with no clock or backend state; running/busy, stopping, failed and cleanup marks take precedence, and clearing the deadline restores the stopped tile immediately. Wake notices and provisional system inbox rows render as notices, never human bands. Stop cancels a scheduled wake or interrupts a sleep-stop. No new controls.

Rejected: appointment/outcome tables, a generalized idempotency ledger, provider suspend, a `sleeping` state, and a separate notification turn.

## Central agents and execution demand

Central Pi inference and history are independent of execution startup (`docs/pi.md`). Lifecycle owns the execution side.

- **VM demand** is agent work OR upload/transfer holds OR an unconsumed explicit Start/wake. Agent work (root tasks, background children, admitted submissions, VM-tool waits) warms execution eagerly in parallel; only VM-backed calls wait. Housekeeping, projection and Luna summaries never demand a boot. Visible browsers only keep a running VM up. The 15-minute idle grace retains an existing execution episode; it cannot restart a stopped VM. No persisted `agentReady`/`VMdesired` flags.
- Agent `idle`/`working` is derived. Central history is available in every compute state. Only guest health resets execution liveness. Execution metadata hydration precedes publishing `running`; initialization failure is typed and visible, and permanent guest initialization failures propagate through readiness into terminal health instead of leaving creation waiting. The UI shows agent activity and a compact VM phase and never disables the composer because execution is starting, stopped or failed; waiting for execution is a tool reason, not a lifecycle state.
- **Idle stop does not abort central work** or suspend its admission. Work admitted after an idle-stop commit continues; only VM-backed calls await stop and a new start. A read-only reopen preserves unfinished work without scheduling it or reporting it active.
- **Unloading** a Harness requires a stopped host and a quiescent agent, rechecked against persisted host state and admission before closing. Stopped compute, an empty inbox and no loaded work do not prove quiescence: one read-only orb-indexed query checks any task in `pending|running|waiting|completing` or submission in `queued|placed` across all conversations. Demand reopens through normal health/admission fences (`central-agent-recovery-requested`); probe/open failure retries without unloading (`central-agent-recovery-failed`, exposed through `OrbView.lastError` from `ControlState`, not database writes). Passive history reads never load a Harness (`docs/postmortems/2026-10-20-stopped-central-agent-recovery.md`).
- **Lost ownership.** Confirmed database ownership loss on a matching storage capability retires the agent locally after joined teardown, without drain writes; the manager may then replace it. SQL/capability and genuine cleanup failures still block replacement; an aborted signal alone is not owner loss (`docs/postmortems/2026-10-23-agent-lease-loss-drain.md`).
- **Stop authority.** Explicit Stop revokes agent admission and dispatch and stops execution; `Harness.close()` suspends unfinished tasks for authorized recovery. Every explicit Stop advances `agent_admission_version`, even on a stopped orb; central callers capture this generation, not incarnation or state version. Fresh Start or human input advances it when clearing manual/sleep inhibition; ordinary VM recovery and cancelling a not-yet-drained sleep preserve the active agent. Explicit root abort is terminal cancellation, not close. Reconnects and heartbeats cannot undo Stop.
- **Resource retry.** Start or a current-failure wake from `failed` advances `agent_admission_version` only when no immutable resource snapshot exists and the current admission has a failed resource event. Successful snapshots and compute-only failures preserve admission.
- **Browser scopes.** Central conversation subscriptions survive Stop and execution replacement; execution terminals close immediately. Claude closes both scopes. Delete closes both; central archival preserves conversation delivery until finalization.
- **Execution waits.** The execution facade asks lifecycle for readiness, never the provider. Waits never occupy the per-orb command queue. Bind immutably at dispatch and recheck cancellation and execution admission after every await. Stop cancels pending waits and forbids late dispatch or reprovisioning. Cancelling one wait removes only its own demand. Lifecycle binding acquires the VM-only lease before its final admission check; failure and cleanup release it idempotently. Affected VM waits fail with typed, visible outcomes while central work continues; dispatched calls are never rebound to replacement compute.
- Recovery remains bounded by the unreachable-restart, deadline and restart-budget rules above. `failed` stays fenced against persistent demand.
- Persist sanitized demand-reason changes, start/stop decisions, suppression edges and task-correlated wait/ready/fail/cancel outcomes (`execution.*`); include incarnation once bound. Private instruction contents never enter edges or tool errors.

## Compute replacement

Incidents: `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`, `docs/postmortems/2026-08-12-spot-preemption-corrupt-entrypoint-layer.md`. Provider half: `docs/host-provider.md`.

> A `failed` orb may retain its workspace, but never retains or reuses the compute incarnation that observed or caused the failure.

> A compute incarnation is immutable. When the desired host specification changes, the old incarnation is disposed and a new one created around the retained workspace; it is never repaired in place.

### Persisted state

```text
host_incarnation                   integer not null default 0  -- 0..2147483646
host_spec_fingerprint              text null    -- null together with generation
host_spec_generation               bigint null
host_discard_through_incarnation   integer null -- set with reason and requested_at
host_discard_reason                text null    -- failed | host_spec_changed | claude_recovery
host_discard_error                 text null
host_discard_evidence              text null
host_discard_requested_at          timestamptz null
```

`integer` maps exactly to a TypeScript `number`.

### Rules

1. Every provision/start/discard carries the expected incarnation; every resource and observation carries incarnation and fingerprint.
2. Every transition to `failed` atomically sets the discard fence to `host_incarnation` with reason `failed`, clears the previous discard error, keeps `host_ref` as the resource to remove, and clears `runtime_token_hash`, so `failed → starting` cannot reauthorize the failed runtime. Broker authorization also rejects any orb with a non-null discard fence.
3. Only the ordinary start path compares specifications. When a `starting` orb has compute whose committed fingerprint differs from `desiredSpecFingerprint` and the configured deploy generation is ≥ the committed `host_spec_generation`, one CAS creates a `host_spec_changed` discard intent and clears the token. A lower configured generation (a draining stale revision) declines with one `spec-replacement-declined` edge and parks before readiness or boot-failure decisions. `stopped` and `running` orbs are never evaluated: a deploy neither sweeps the stopped fleet nor bounces running orbs. A `host_spec_changed` request keeps any retained `host_discard_evidence`.
4. `discardCompute` deletes only exact-orb resources at or below the durable fence.
5. After verified absence, one CAS clears `host_ref`, committed fingerprint/generation and the discard fence/reason/error/time, and advances `host_incarnation` above the disposed range. It keeps bounded evidence until replacement commits. Finalization does not bump `state_version`: it is preparation inside the same failure episode, so a wake admitted during cleanup stays authorized.
6. Replacement provision uses the advanced incarnation and current fingerprint and commits host ref, token hash, fingerprint and generation only if state version and incarnation still match and no discard is pending. Commit clears retained evidence. A losing pass discards its side effect only when the durable incarnation is higher. A provision `conflict` from a racing revision re-reads instead of failing the orb.
7. Same-fingerprint stop/start reuses the stopped incarnation. A null committed fingerprint (pre-stamping row) matches only unstamped compute, which restarts in place until its next ordinary Start replaces it.

### Ordering

**Entering failure:** collect evidence and format `last_error` (folding in `diagnose()` output); CAS to `failed` with token clear and discard intent; log transition and `compute-discard-requested`; clear episode memory and wake reconciliation. Never stop the host before committing failure: another reconciler could otherwise commit a clean state that loses the failure. An orb failing with no compute (for example `auth_failed`) still gets the fence; discarding nothing verifies trivially and rotates the incarnation.

**Shared disposal gate.** At the top of every pass in `failed`, `starting`, `stopping`, `stopped` and `archiving` (not `deleting`, which supersedes it):

1. If a fence exists and no evidence is retained, collect bounded sanitized diagnosis (GCE boot-status guest attribute) and persist it in `host_discard_evidence` before deletion. Diagnosis failure is recorded as unavailable and never blocks disposal.
2. Call `discardCompute` within the provider deadline. On failure persist sanitized `host_discard_error`, log once, keep state and intent, and retry; a nominally non-retryable error stays visible rather than abandoning cleanup. Log one recovered edge after an error.
3. On verified absence, CAS-finalize.
4. Continue by state: `failed` waits or evaluates a current-failure wake; `starting` proceeds to clean provision; `stopping`/`stopped` converge to `stopped` with no compute. A Stop racing replacement cancels wake intent but cannot cancel disposal.

**Starting after failure or update.** Before auth, provision, observe or start: finish any discard; apply rule 3 (`waiting("stale_compute_disposal")`); provision only after old incarnations are recorded absent; start in place only with a matching fingerprint. A queued message keeps exactly one boot attempt; disposal is preparation, not an attempt.

**Archival** finishes any discard, applies the same spec gate, and provisions a clean incarnation if it needs a readable runtime to seal history (`docs/teardown.md`).

**Authority.** The incarnation fence makes late provider calls harmless. The forward-only generation fence closes the only new cross-revision disagreement, the desired spec. A stale revision can still make wrong terminal decisions at full authority (`docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md`); the worst new consequence is losing a disposable boot disk, because `discardCompute` cannot touch the workspace. Every path rechecks durable state immediately before requesting discard, calling the provider, provisioning, failing or finalizing, and treats a CAS conflict after an external side effect as a reason to re-read, never to clear a newer intent. The ordinary orphan sweep stays stop-only; only the durable fence authorizes compute deletion.

### Product behavior

- Entering `failed` preserves `last_error`, history, checkout/session metadata, queued messages and the workspace. The orb stays failed and consumes no compute.
- While disposal is pending or blocked, `stateDetail` says failed compute is being discarded and shows the sanitized provider error; `last_error` is unchanged. For `host_spec_changed`, the view shows `replacing_stale_compute` ("Replacing compute for an updated host specification…") instead of a failure-shaped banner. Detail derives from durable columns, so it survives control-plane restart.
- Start may return `starting` immediately, but reconciliation completes disposal first. Stop, archive and delete outrank Start and wake.
- Replacement may fail again on clean compute for deterministic causes (repository, configuration, artifact); each such failure disposes its incarnation in turn, with no autonomous loop.
- Disposal trades away post-hoc host forensics; durable evidence (guest attributes, `pi-orb-boot` logs, discard evidence, `last_error`) replaces disk inspection.

### Deterministic coverage

Crash checkpoints: `compute-replacement.failure-intent-committed`, `.discard-before-provider`, `.discard-after-provider`, `.discard-before-finalize`, `.discard-finalized`, `.replacement-before-provision`, `.replacement-after-provision`, `.replacement-before-commit`, `.replacement-committed`; failpoints on discard, evidence persistence, finalization, provision and commit. Fence scenarios also run the real `GceOrbHostProvider` over the stateful deterministic GCE model behind `GceApiTransport` (instances, disks, labels/metadata, asynchronous zone operations, 409 on duplicate insert, label-filtered list, delayed deletion visibility). Invariants: workspace identity never changes, at most one live compute incarnation exists, and nothing at or below a cleared fence remains. Test seams and live validation: `docs/testing.md`.

Rejected: restarting failed VMs in place; in-place metadata/startup-script repair; re-running `docker pull` or `docker rmi`; wiping `/var/lib/docker` at boot; provisioning a replacement immediately on failure; using `destroy`; delete-by-name without incarnation; applying only to `runtime_never_answered`; keeping failed VMs for forensics; gating on a reconciler lease.

## Claude uncertain-worker recovery

An answered failed pull or delivery triggers a typed health inspection; reachability is not readiness. Only Claude's `failed` health with exact `error.code: "claude_child_recovery_required"` and a valid `recovery: {episode}` authorizes one automatic whole-compute replacement, and only on a provider advertising `verifiesWholeComputeDisposal` (Docker, GCE; never process). All other failed health stays terminal. Local disposition I/O failure grants no authority.

- A `state_version` CAS claims the episode, enters `starting`, revokes the old runtime bearer and creates the discard intent with reason `claude_recovery`. The `claude_recovery` JSON column stores claimed episode identities and the current disposed/replacement incarnations. Each episode can be claimed once across controller restarts; repeated ownership fails visibly with exhaustion.
- Sleep, any stopping reason and stale deployment generations decline automatic replacement. Stop, archive and delete win through the existing fences.
- Shared reconciliation verifies `discardCompute` before finalization marks the proof verified and advances the incarnation (this finalization does advance `state_version`). Provisioning carries only that episode's verified proof for its replacement incarnation (`docs/host-provider.md`). No Stop drain barrier or same-VM restart is used.
- The episode is an opaque 64-hex digest independent of replacement lifetime. I/O repair failures, missing receipts, generic health errors, PID/EOF evidence and inventory absence grant no authority.
- **Receipt barrier.** Verified replacement publishes idempotent interruption outcomes before releasing retained ownership; publication or save failure stays failed. Native session/result identities and inbox receipt UUIDs are preserved. Before dispatching any retained inbox batch, the controller pulls and commits canonical receipts; it never marks an unacknowledged head delivered to unblock the queue. A repeated UUID is acknowledged from its retained native receipt, not inferred from disposal; new messages may then start ordinary turns.
- Edges: `claude-recovery-claimed`, `claude-recovery-disposal-failed`, `claude-recovery-disposal-verified`, `claude-recovery-ready`, `claude-recovery-exhausted`, carrying reason, episode and incarnation only. Durable claim/error/proof columns reconstruct crash cuts. No automatic inference or tool replay and no new UI status.

## Interrupted work after restart

Central Pi uses native Durable task and receipt ownership rather than guest-tail continuation (`docs/pi.md`). Native Claude decides at boot from its full retained root history (`claude/turn-resume.ts`); compacted model context is not a recovery log, and the native history owner, not the public replica, decides.

- Retained root evidence selects baseline, interrupted-root continuation, passive settled restart context, or a non-triggering decline. Interrupted work and `sleep_wake` trigger continuation; settled restart starts no inference and queues its context ahead of legitimate input.
- A triggering continuation persists a boot claim before native submission and spends one of three attempts, even if no inference follows. Only genuine human input resets the budget; system input, peer messages, compaction and notices do not. Exhaustion produces a visible decline, never silent success.
- The root resumes its retained session; children are never replayed. Old child ownership needs fenced execution-lifetime loss; uncertain human receipts fail closed. Interrupted effects are not permission to replay.
- Wording is neutral about cause and reflects evidence: the execution-lifetime identity (`docs/host-provider.md`) distinguishes whole-compute restart from runtime-only restart. Known whole-compute loss may say old processes died; otherwise "Other processes may still be running; verify their state." Process hosts cannot prove detached descendants died. Identity-read failure is a typed initialization failure.
- Fresh boots keep a hidden baseline; existing-conversation decisions, declines and failures are durable visible records. A triggering continuation owns admission before readiness accepts competing input. Failure to persist required evidence blocks readiness. Readiness reports the decision as edge-only `turnResume.outcome` (`docs/runtime-protocol.md`).

Incidents: `docs/postmortems/2026-08-07-preemption-lost-turn.md`, `docs/postmortems/2026-09-27-preemption-delegated-cancellation.md`. Claude-specific receipts: `docs/claude.md`.

## Orphan-host sweep

Idle stop cannot reach a host with no orb row. `orphanSweepOnce` runs every 5 minutes beside the poller and reconciler, calls `listManagedHosts` (only pi-orb-labelled hosts), and joins each observation to the orbs table:

- Archived orb: destroy the resurrected host (`archived-host-resurrected`, `docs/teardown.md`).
- Observed incarnation below the durable `host_incarnation`: `discardCompute` through that incarnation (`retired-host-resurrected`). This removes compute a crash left behind; it never touches the current incarnation or the workspace.
- Running host with no orb row (lost provision commit, database reset): stop it and log `orphan-host reason=no_orb_row` on every sweep while it survives, as an integrity signal.
- Running host of a `stopped`/`failed` orb whose `host_ref` differs: stop it (`orphan-host reason=stale_host_ref`).
- Live orbs and matching refs are left to the reconciler.

Otherwise the sweep only stops; a misfire costs a restart, not data. It never infers destructive authority from a `failed` row. A listing failure logs `orphan-sweep-blind` once and `orphan-sweep-recovered` on recovery.

## Lifecycle event log

The control plane logs its lifecycle decisions and only those: one grep-friendly `key=value` line prefixed `lifecycle:`, naming the orb, written through `domain/log.ts` on the `determined` task logger to stdout and Cloud Logging. These lines are the durable, queryable record of autonomous decisions.

- **Transitions** from the reconciler and HTTP commands, with `from`, `to` and reason (`stop_reason`, failure `code` and message, `start_requested`, `idle_for_<n>s`, `unreachable_restart`, `drain_complete`, `host_observed_stopped`, `queued_message`, `archive_requested`/`delete_requested` with `source`).
- **Provider operations** the reconciler decides: `provision` (`outcome=created|adopted|replaced`), `host-start`, `host-stop`, `host-destroy`, with host ref, reason and error. `unreachable-restart` records the expired grace, whether it was `ordinary` or `post_restart`, and silence duration.
- **Compute replacement:** `compute-discard-requested host through_incarnation reason failure_code`, `compute-discard … outcome=ok|error evidence`, `compute-discard-recovered`, `replacement-provisioned host incarnation spec=<prefix>`, `spec-replacement-declined committed_generation configured_generation`, `superseded-provision-discard`.
- **Boot:** `boot-failed reason=runtime_never_answered` with probe count, host running time and diagnose evidence; `setup-failed`/`resume-failed` with incarnation, outcome, exit code and in-orb log path, never output, deduped once per orb per incarnation (`docs/orb-setup-hook.md`); `turn-resume`.
- **Drain:** `drain-blocked` (once per retrying episode), `drain-caught-up`, `drain-skipped`, `drain-integrity`, `drain-restart-deferred`, `drain-restart-cap`.
- **Inbox:** `message-queued`, `message-batch-dispatched`, `message-batch-failed` (IDs, counts, error codes, never content; `docs/inbox.md`).
- **Sleep, idle, recovery, auth, central agents:** the edges named in their sections.
- **Replication fate:** integrity failures and `session-rotated` (`docs/history.md`).
- **Loop failures:** first failing pull (`pull-failed`) and first typed retrying reconcile (`reconcile-retry`) of an episode, both with `invariant=true` when parked; `reconcile-task-crashed`; `poll-task-crashed` (only `lane=central|history|name` and `error=unexpected`); store outages that blind a loop (`poll-loop-blind`, `reconcile-loop-blind`, `project-deletion-loop-blind`, each with a `-recovered` partner); orphan-sweep decisions.
- **Code-mode resource failures:** `codemode.resource_failed` (`docs/pi.md`).

**Noise rule: a healthy fleet logs nothing.** Successful pulls, no-op passes, readiness probes and the idle countdown are levels and stay silent. Persisting conditions (blocked drain, store outage, pending device login) log once when they start; `ControlState.noteCondition` is the shared edge detector for conditions without their own status field. Per-tick logging made an incident unreadable (`docs/postmortems/2026-08-05-unreachable-restart-livelock.md`). Periodic diagnostic exceptions are `codemode.memory` (`docs/pi.md`) and `control-plane.http` (`docs/deployment.md`); neither is a `lifecycle:` line. Rejected: log levels and configurable verbosity; incidents must be diagnosable from the default deployment.

Outcomes that affect the user also appear in the product: `last_error`, `stateDetail` (discard, auth, setup, drain), `actionRequired`, and visible history records.
