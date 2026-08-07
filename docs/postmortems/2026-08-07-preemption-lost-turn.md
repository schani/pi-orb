# 2026-08-07 — Spot preemption kills a turn mid-tool-loop; runtime returns idle; idle reaper collects the orb

Status: root cause is the known defect (c) of `docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`, now triggered by a genuine preemption rather than a false restart. The resume design was decided the same day (`docs/lifecycle.md`, "interrupted-turn resume at runtime boot"); implementation tracked in `TODO.md`.

**Field finding (2026-08-07, orb 7ecfd0e0, all times UTC): a Spot preemption killed an agent turn ~2.5 minutes into implementation work; recovery restarted the host correctly in 96 s, but the runtime came back idle with the truncated turn, and 15 minutes later the idle auto-stop — working exactly as designed against a genuinely idle orb — stopped it. The user experienced "my orb stopped mid-work".** Reconstructed from the reconciler event log, guest serial logs, and GCE audit logs.

Timeline:

- 16:02:31 — user approves a plan and asks the agent to implement it; the agent works continuously (~30 tool calls).
- 16:04:52 — guest OS logs the ACPI soft-off (`Power key pressed short`); docker daemon shuts down. The instance is `SPOT, preemptible=True`; no API stop precedes the power-off, and the first control-plane GCE call comes 30 s later — a preemption, not a control-plane action.
- 16:05:22 — the GCE API *still reports the instance `RUNNING`* (status lags the guest power-off by 30 s+), so the reconciler falls through to the silence path: `unreachable-restart silent_ms=30477 grace_kind=ordinary` — indistinguishable in the log from the 2026-08-05 egress-blip false positive, though this time the runtime really was dead.
- 16:05:39–16:06:28 — stop/start, `running → starting → running` (`runtime_ready`). Recovery per the 2026-08-06 rules: hand-off to `starting`, no restart storm, serving again 96 s after the power-off.
- Last session record: a tool result (`finishReason=toolUse` on its parent assistant message) that no assistant message ever consumed. The runtime loaded the session and sat `idle` — defect (c), verbatim.
- ~16:07:44 — idle anchor set (browser tab went to background); 16:22:44 — `idle_for_900s`, drain (`records=0` pending), stopped at 16:23:38.

What this adds beyond the 2026-08-05 incident:

- **The trigger class for defect (c) is broader than false restarts.** On Spot VMs preemption is expected background attrition, not a rare fault; every preemption during a turn silently kills the user's task until resume exists.
- **The idle auto-stop compounds the defect**: an interrupted-and-not-resumed orb is genuinely idle, so the reaper stops it, converting "turn lost" into "orb stopped" from the user's perspective. With resume, the post-restart runtime is busy again and the reaper never fires.
- **A preemption can surface through the silence path, not the observed-stopped path**, because GCE instance status lags the guest power-off. Diagnosis labels (`unreachable_restart`) are therefore unreliable as cause records; the resume design deliberately keys off the session tail, not the restart cause.
- **`system_event` audit logs are not captured in the project** — `compute.instances.preempted` was not queryable and the preemption had to be proven from guest serial logs. (A `zoneOperations.list` check remains available to a future `diagnose()`-based labeling improvement; see `docs/host-provider.md`.)

What went right: host recovery (96 s, no storm), the drain barrier (nothing unreplicated), and the filesystem (the agent's two written test files survived for the next start). The event log again made reconstruction fast.
