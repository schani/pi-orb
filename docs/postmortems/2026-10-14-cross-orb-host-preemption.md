# Cross-orb task host preemption — 2026-10-14

Status: infrastructure cause confirmed; no product fix or deployment.

GCE preempted Spot host `pi-orb-8d9db27e-ba25-44c6-b48e-25edf2b2bc43-i0` in `playground-dev-6ae7/us-central1-a` during cross-orb work. The interruption reportedly lost /tmp services/testing evidence; pre-interruption test outcomes cannot be reconstructed from the collected logs.

## Evidence

Times are PDT (America/Los_Angeles).

- 12:08:06.439: previous-boot logind records “Power key pressed short.” and initiates shutdown.
- 12:08:09.630: systemd reaches poweroff.target; the workspace unmounted cleanly.
- 12:08:14.028640: Compute system audit records `compute.instances.preempted`, principal `system@google.com`, status “Instance was preempted.”, insertId `q56ueme1k5oe`.
- 12:08:27.904512: deployed lifecycle records `running → starting reason=host_observed_stopped`.
- 12:08:29.176847–12:08:42.640248: `pi-orb-control-plane@playground-dev-6ae7.iam.gserviceaccount.com` starts the same instance.
- 12:09:29.721377: lifecycle records `starting → running reason=runtime_ready`, incarnation 0.

Instance scheduling is `SPOT`, `preemptible=true`, termination action `STOP`. Bounded 12:07–12:09:59 queries returned three Compute audit rows and 48 orb-specific lifecycle rows, below their caps; neither contains a stop/reset API call or manual/idle/sleep stop decision. The infrastructure audit establishes preemption rather than a user stop, idle auto-stop or accidental test shutdown. Autonomous restart was recovery, not the initiating cause. Google's internal capacity trigger is unknown.

Sanitized evidence and query scope: `.context/cross-orb/host-interruption/` (`compute-audit.json`, `lifecycle.json`, `guest-journal.json`, `boots.txt`, `instance.json`, `queries.md`). Guest journal alone establishes a power-key shutdown, not its infrastructure attribution.

## Scope

This confirms the existing restart-in-place behavior in `docs/host-provider.md`: persistent workspace survives; processes and /tmp evidence do not. Keep interruption evidence on the workspace, not /tmp. No test rerun or qualification is implied. Product changes remain deferred to the parent task.
