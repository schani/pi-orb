# Orb lifecycle

Orb states, reconciliation rules, idle auto-stop, and the orphan-host sweep. The host operations these rules drive are specified in `docs/host-provider.md`.

## Decisions

- We will implement stop/start and full restart recovery.
- We will not implement suspend/resume initially.
- The runtime should report health and busy/idle activity to the control plane.
- The control plane distinguishes an idle but healthy runtime from an unhealthy runtime. Failed health checks can lead to restart. The first vertical slice stopped only on explicit requests; idle auto-stop is now a decided design (below).
- Initial lifecycle constants are a 5-second readiness health poll during create/start, a 30-second unreachable-runtime grace period, and a 15-minute create/start deadline; all use injectable clocks and may be tuned later. While an orb is `running`, the ~10-second history pull doubles as the liveness signal, so no separate health poll runs.
- Pi's `agent_settled` lifecycle state is a useful agent-idle signal because it means no retry, compaction retry, or queued continuation remains.
- Pi SDK 0.83.0 does not expose a Claude Code-style shell registry or a reliable “agent-started processes remain” query. `AgentSession.isBashRunning` covers only currently awaited user `!`/`executeBash()` commands; model-invoked bash is observable only while its generic tool lifecycle is active. Pi internally tracks each built-in local shell PID while that invocation is awaited so it can kill the process group on abort/shutdown, but exposes neither the PID set nor a status getter and stops tracking when the shell invocation returns. Arbitrary detached descendants and processes spawned by extension/custom tools are therefore invisible to Pi after their launching tool returns. Whether OS process/cgroup inspection can provide a reliable idle signal remains unresolved.

**Decided — idle auto-stop and orphan-host sweep (proposed 2026-08-01, decided and implemented 2026-08-03 with the visible-tab refinement):**

Idle auto-stop reuses existing machinery rather than adding a new lifecycle path:

- The ~10-second history pull already returns `activity: idle | busy`. Add a `last_busy_at` column on the orb row (restart-stable, like `state_changed_at`; the wall clock is already injected). A pull observing `busy` — or any accepted mutating request, or an open live browser connection whose tab currently reports itself visible — refreshes it.
- When a `running` orb's reconciler observes `wallNow() - last_busy_at > idleStopAfterMs` (initial value: 15 minutes, matching Amp's pause window), it CAS-enters `stopping` with a persisted `stop_reason = 'idle'` so the UI can say "stopped (idle)" rather than presenting an unexplained stop; explicit stop/start commands clear the reason. From there the ordinary controlled-stop drain barrier applies unchanged. The effective idle anchor is `max(last_busy_at, state_changed_at, lastVisibleAt)`, so a freshly started orb always gets a full idle window. Two guards close timing holes: the reconciler also refuses to stop while the *most recent pull* observed `busy` (wall time can leap past the deadline — a clock jump or paused process — faster than pulls can refresh the persisted timestamp; found by DST), and `last_busy_at` writes go through a dedicated monotone `touchLastBusy` store operation with no `state_version` bump, so activity refreshes never conflict with lifecycle CAS or replication cursor writes.
- A browser connection counts as activity only while its tab is actually visible (decided answer to open question 10). Watching an agent work — or thinking about what to type next — should not power off the machine under the user, but a long-forgotten background tab must not keep a VM alive for days. The web client reports `document.visibilityState` over the live WebSocket: a presence frame on connect and on every `visibilitychange`. The control plane tracks the latest report per connection and treats the orb as browser-active only while at least one open connection has affirmatively reported `visible` — a connection that has not reported visibility counts as hidden, so the failure mode of a lost presence frame is an earlier stop, never a leak. A killed tab or slept laptop closes the socket, which removes the connection either way.
- Accepted limitation (open question 8 is resolved by the Pi SDK finding above; open question 9 stays open): detached background processes the agent started are invisible to `agent_settled` and would not prevent an idle stop. Amp ships the same trade-off with its 15-minute pause. If this bites, the answer is an OS-level signal (process/cgroup inspection in the runtime's health report), not a special background-job tool.
- DST coverage (implemented in `lifecycle.dst.test.ts` "idle auto-stop" and `orphan-sweep.dst.test.ts`): the idle deadline racing a just-accepted message burst (replica completeness holds whichever side wins); a busy runtime never idle-stopping even across simulated time jumps; a visible tab blocking the stop and a hide restarting the full countdown; and idle stop resuming correctly from persisted state alone after a control-plane restart with downtime.

Idle auto-stop cannot, by construction, handle a host the database has no row for — no row means no reconciler, no history pull, and no idle signal. That is the separate **orphan-host sweep** (open question 23), and the two should ship together:

- A periodic control-plane loop (`orphanSweepLoop`, every 5 minutes, running as a third background task beside the poller and reconciler; one instance is enough since the operation is idempotent) calls `listManagedHosts` — already on the provider port for exactly this purpose; the GCE implementation lists by the `pi-orb-orb-id` label, Docker by its managed-container naming.
- Each observation is joined against the orbs table. A running host whose orb row says `stopped`/`failed` is already covered by the lifecycle-transition reconciliation below when `host_ref` matches; the sweep additionally catches rows whose `host_ref` was lost. A running host with *no* orb row at all — a provision whose commit was lost, or a database reset — is stopped (never deleted: the filesystem is authoritative and deletion does not exist in the first slice) and logged loudly as an integrity signal.
- The sweep only ever moves hosts toward "stopped"; it never starts or deletes anything, so a misfire costs a restart, not data.

## Lifecycle transitions

The database state is desired/reconciliation intent as well as user-visible state. Every transition uses `state_version` compare-and-swap; provider operations remain idempotent, so competing reconcilers are harmless.

| Database state | Reconciler behavior                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `creating`     | Ensure Codex auth, provision by orb ID, then wait for runtime ready.                                                                                                                                                                         |
| `starting`     | Ensure Codex auth, observe/start or reprovision the retained host/filesystem, then wait for runtime ready.                                                                                                                                   |
| `running`      | Observe the provider and derive runtime liveness from the ~10-second history pull; broadcast/replicate normally.                                                                                                                             |
| `stopping`     | Reject new live connections, close existing proxies, perform the final history-pull barrier, stop the provider host, then mark stopped. A non-retryable drain failure stops the host and marks the orb `failed` instead of retrying forever. |
| `stopped`      | Perform no runtime work; reconcile any unexpectedly running host back to stopped.                                                                                                                                                            |
| `failed`       | Preserve filesystem and error; wait for an explicit start request.                                                                                                                                                                           |

Commands:

- create inserts `creating` and wakes reconciliation;
- start is idempotent for `creating`, `starting`, or `running`; from `stopped` or `failed` it clears `last_error`, enters `starting`, and wakes reconciliation;
- stop is idempotent for `stopping` or `stopped`; from `creating`, `starting`, `running`, or `failed` it enters `stopping`;
- start while `stopping` returns `409 conflict`; the caller retries after stopped;
- runtime message requests are rejected once the database enters `stopping` because the control plane closes and refuses live proxy connections for that orb.

Reconciliation rules:

- retryable provider/network failures leave the current transitional state unchanged and retry with deterministic-clock exponential backoff capped at 10 seconds;
- a non-retryable provider error or runtime `failed` response transitions to `failed`;
- provider absence during `creating`/`starting` calls idempotent `provision(orbId, ...)` rather than assuming Docker/GCE semantics;
- provider absence or unexpected stop while the database says `running` transitions to `starting` and restores the host around the retained filesystem;
- a running provider whose runtime remains unreachable for a grace period is restarted with provider `stop`/`start`, without the controlled-stop drain because the runtime is already unhealthy; this rule applies in both `running` and `stopping`, so a pending drain is never stranded behind a dead runtime process inside a live host. What happens after the restart differs by state (decided 2026-08-06, below): `running` re-enters `starting`, while `stopping` stays put under a boot-sized grace and a one-restart cap;
- after OAuth completion, each blocked `creating`/`starting` row is CAS-reentered with a fresh `state_changed_at` before host work, so user login time does not consume the host startup deadline;
- an orb becomes `running` only after ready identity/session/commit data have been persisted;
- when an orb has been `creating` or `starting` longer than the create/start deadline (measured from `state_changed_at` with the injected wall clock), the reconciler cancels in-flight provider operations, stops the host if one is observable (tolerating absence), and transitions to `failed` with a typed `deadline_exceeded` error; a later start begins a fresh deadline, and OAuth device-login wait time never counts because completion re-enters the state with a fresh `state_changed_at`;
- a retryable controlled-stop pull/commit failure leaves the orb in `stopping` and the host running, as specified by the shutdown barrier;
- a non-retryable replication-integrity failure (unknown cursor, session-header mismatch, mapping/validation failure) — whether during `running` polling or a `stopping` drain — transitions to `failed` with a typed error and then stops the host (that order matters, see `docs/history-replication.md`); the same applies when a runtime cannot be restored to ready within the create/start deadline while a drain is pending;
- when stopping an orb that has never reached ready and has no `harness_session_id`, no user request could have been accepted, so the control plane may skip the history drain and stop the provider directly;
- if the provider host is definitively absent or already stopped during `stopping`, there is no running runtime to drain; mark `stopped` directly — complete records left on the persistent filesystem are found on the next start.

Use initial constants of a 5-second readiness health interval during create/start, a 30-second unreachable-runtime grace period, a 3-minute post-restart grace (below), and a 15-minute create/start deadline; while `running`, liveness is derived from the ~10-second history pull instead of a separate health poll. These use injectable deterministic clocks. Time spent waiting for the user to complete a displayed OAuth device challenge ends when that challenge expires rather than consuming a separate hidden timeout.

Add `state_changed_at` to the orb row for transition deadlines; ordinary replication writes must not alter it. `updated_at` remains a general row-update timestamp.

Idle auto-stop (above) enters `stopping` through the same transitions; it required no new lifecycle states — only the persisted `last_busy_at`/`stop_reason` columns and the reconciler's idle check.

**Decided — what follows an unreachable-runtime restart (2026-08-06, from `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`):**

A restarted host is a booting host, and any liveness grace shorter than a boot concludes "unreachable" against it forever. The 2026-08-05 field incident did exactly that: 38 stop/start cycles in 38 minutes against a ~65 s COS boot under the 30 s unreachable grace, each cycle hard-stopping a VM roughly 2 s short of serving. The rules that replace "restart inline and keep waiting in place" are:

- **From `running` the restart hands recovery over instead of repeating it.** After the `stop`/`start` the reconciler CAS-transitions the orb to `starting` with a fresh `state_changed_at`, so the patient readiness path owns the rest: 5-second health polls, the `runtime_never_answered` boot sub-deadline, and the create/start deadline as the outer bound. The fresh `state_changed_at` also gives the new host incarnation a fresh boot-detection window. No code path restarts a host twice from `running`.
- **From `stopping` the restart stays put but is bounded twice over.** A pending drain cannot be handed to the readiness path — the orb must remain `stopping` — so the inline restart survives there under two bounds. The liveness baseline it seeds is granted `postRestartGraceMs` (3 minutes, comfortably above a ~60–70 s boot) rather than the ordinary 30-second grace, and at most one restart is attempted per `stopping` episode: if that baseline expires again with no pull success in between, the restarted runtime has demonstrably not returned and the drain fails at once with `drain_runtime_unrecoverable`. That outcome is now evidence-based; the stopping deadline remains only as the outer bound.
- A liveness baseline therefore carries the grace it is entitled to. A baseline seeded by a pull success, or by entering `running` (where the runtime has just answered a health check and is serving), gets the ordinary grace; only a baseline seeded by a host restart gets the boot-sized one.

Rejected: keeping the restart inline everywhere and merely enlarging the grace past a boot. That fixes the livelock's period, not its shape — a `running` orb still has no deadline of its own, so an unrecoverable host would cycle forever at a slower rate, and every cycle hard-stops a host that may still be flushing (the durability gap in `docs/history-replication.md`). Re-entering `starting` instead reuses machinery that already has a deadline, a boot-failure sub-deadline, and host-side diagnostic evidence.

DST coverage in `lifecycle.dst.test.ts`, all with the modeled 65 s host boot of `docs/testing.md`: `preemption-while-running` (a hypervisor soft-off mid-`running` recovers within a bounded number of provider stops), `runtime-dies-during-stopping-drain` (a drain whose runtime dies still completes on the rebooted runtime), and `stopping-restart-cap` (a restarted runtime that never answers fails the drain on evidence, well inside the stopping deadline).
