# 2026-09-27 — Preemption coincides with delegated-work cancellation

**Finding (orb `e67b1120-393c-41c6-94ed-b354d82c526d`; all times UTC):** A resumed child was recorded as stopped during guest shutdown, before GCE recorded a Spot preemption. The shutdown path invokes the same `abortOperation()` as a user abort, so the persisted cancellation marker does not identify who initiated cancellation. The timing and code path strongly support shutdown-triggered cancellation; the available evidence has no browser-abort telemetry to rule out a concurrent human click.

Evidence: `/tmp/orb-e67-transcript.json` (replicated records) and `/tmp/orb-e67-stop-logs.json` (guest, lifecycle and GCE logs).

- 04:46:34.349 — visible `pi-orb.subagents-cancelling` record `21be3167` says “Cancelling delegated work.” Its details name operation `267f26aa-1876-4037-bd09-b83f3e55644f` and child `8795cf3c-3489-48f` (“Remediate dependency advisories”). This child had completed an earlier run and was resumed at 04:45:49.661.
- 04:46:34.356 — resumed child persisted `status: stopped`; 04:46:34.357 — its terminal run record `8b1e4954` was appended.
- 04:46:34.383 — guest shutdown script runner started (reported no scripts to run); 04:46:35.012 — guest agent received SIGTERM. GCE audit recorded `compute.instances.preempted` by `system@google.com` at 04:46:41.950528.
- 04:46:55.387 — lifecycle transitioned `running → starting`, reason `host_observed_stopped`; the control plane requested host start at 04:46:57 and logged success at 04:47:12.
- 04:47:59.752 — boot appended `pi-orb.host-restarted`, head `8b1e4954`, telling the agent to reassess processes and not resume aborted work; lifecycle reported `turn-resume outcome=notified_restart`, not an interrupted-turn resume.

`apps/orb-runtime/src/pi/extensions/subagents.ts` handles `session_shutdown` by calling `host.abortOperation()` before awaiting child drain. `apps/orb-runtime/src/pi/agent.ts` uses that same operation method for explicit abort, appending `pi-orb.subagents-cancelling` and latching the aborted outcome. This preserves cleanup safety but makes shutdown interruption look like user intent to the boot decision. The cancellation record alone cannot distinguish either initiator. The resulting lifecycle rule is in `docs/lifecycle.md`. The 2026-09-27 repair passes shutdown provenance to abort and suppresses its conversational cancellation notice without changing child terminal bookkeeping or the aborted outcome. Full interrupted-child classification and graceful-preemption coverage remain in `TODO.md`.
