# 2026-08-05 — control-plane egress blip triggers false unreachable-restart of a healthy runtime

Status: open. Follow-ups tracked in `TODO.md` ("Corroborate unreachability before restarting a running host", "Detect and resume a turn interrupted by a host restart"). No lifecycle rule has been decided yet.

**Field finding (2026-08-05, orb 1c806852, all times UTC): the unreachable-runtime restart fired against a demonstrably healthy runtime because the control plane's own outbound network was failing, killing an agent turn mid-flight.** Reconstructed from the reconciler event log (which worked exactly as designed — this reconstruction took minutes, not hours) and GCE operation audit logs.

Timeline:

- 22:40:56 — user submits a prompt; the agent starts a turn (reads, then a series of file edits).
- ~22:40–22:43 — the single Cloud Run instance suffers an outbound-connectivity blip. Evidence that the problem was the control plane's egress, not the orb: at 22:41:03 a GCE `observe host` call for a *different, long-terminated* orb timed out after 60 s, and the later `stop host` GCE call also timed out after 60 s even though the GCE audit log shows the stop executed immediately.
- 22:41:53 — last successful history pull (the liveness baseline).
- 22:42:42 — the runtime completes its last tool call of the turn, returning results in milliseconds; the records persisted to the session file and survived. The runtime was healthy throughout.
- 22:42:44 — `unreachable-restart` fires: `silent_ms=50975` > the 30 s ordinary grace. The reconciler issues a hard `stop` two seconds after the agent's last completed tool call.
- 22:43:46 → 22:44:40 — `running → starting → running` (`runtime_ready`). The interrupted records drained after the restart; the in-flight turn was lost and the agent came back idle.

Root defects:

- (a) **`silent_ms` measures "time since last pull success", which is not "time the runtime failed to answer".** Each pull attempt is serialized behind an `observe host for pull` call under the 60 s `providerOperationTimeoutMs` (`replication.ts`). During the blip the observe starting ~22:42:03 hung ~44 s (slow, but under its deadline; it eventually returned `RUNNING` at ~22:42:47, after which the pull request itself timed out at 10 s, producing the single 22:42:57 `pull-failed` line — one line because only the first failure of an episode logs, correctly per the noise rule). Consequence: between the last success at 22:41:53 and the restart decision at 22:42:44, **the control plane never sent the runtime a single request** — the entire 51 s "silence" was time the poller spent waiting on the GCE API, plus its own broken egress. The reconciler declared a runtime unreachable during a window in which nothing had asked it anything.
- (b) **Liveness silence is uncorroborated.** Even where silence does reflect failed pull requests, it cannot distinguish a dead runtime from broken control-plane egress. In this incident concurrent GCE calls were timing out — a strong "it's me, not them" signal the reconciler had in hand and ignored. (Tension with the 2026-08-05 livelock incident: a VM observing `RUNNING` can still hide a dead runtime during an ACPI-off window, so a successful observe does not prove the runtime is alive — but *failing* provider calls are good evidence the control plane should not trust its own silence measurement.)
- (c) **A restart discards an in-flight agent turn without detection or recovery.** The runtime's `activity` flag is in-memory and dies with the process; on boot the session file is loaded and the runtime sits idle. The evidence of interruption survives in the persisted session tail (a trailing tool result, or an assistant message with tool calls and no closing text), and the control plane had observed `activity: busy` on the last successful pulls (persisted as `last_busy_at`), but nothing inspects either. The user sees the orb silently stop working mid-task.

What went right: the reconciler event log (added 2026-08-06 after the livelock incident) made the control-plane side of this reconstruction trivial, and the post-restart recovery path — re-entering `starting` with the patient readiness machinery — worked exactly as redesigned, with no livelock against the ~54 s boot.
