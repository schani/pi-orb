# Spot preemption burst restarted a working orb six times (2026-10-06)

## Finding

Orb `16b24827-0927-431e-ba1d-8ae138985db8` (Claude harness, Spot `n2d-highmem-2`, `us-central1-a`) was preempted by GCE six times in 72 minutes while the agent was running tests. Each preemption is a `compute.instances.preempted` operation by `system`, followed 16–22 s later by the control plane's `start`. The seventh power-off was the control plane's idle `stop`. No pi-orb code initiated the preemption restarts.

The burst was zone-wide: the fleet logged 9, 11 and 7 preemptions in the 13Z, 16Z and 17Z hours, against roughly one per hour from October 4 to 6.

## Timeline (UTC)

| Guest power key | GCE operation | Control-plane `start` |
| --- | --- | --- |
| 16:33:18 | preempted 16:33:28 | 16:33:45 |
| 16:39:56 | preempted 16:40:07 | 16:40:23 |
| 17:12:46 | preempted 17:12:54 | 17:13:16 |
| (boot never reached ready) | preempted 17:14:00 | 17:14:16 |
| 17:20:45 | preempted 17:21:02 | 17:21:21 |
| 17:45:42 | preempted 17:45:50 | 17:46:06 |
| 18:10:14 | `stop` by control plane (idle) 18:10:13 | 18:29:26 (user message) |
| 18:45:32 | **none recorded** | 18:46:36, after `unreachable-restart` |

**Unattributed power-off at 18:45:32.** The guest received a power key and shut down cleanly, but neither the GCE operation list nor any audit log (`activity` or `system_event`) records an operation for it. The six preemptions each logged `system_event` `compute.instances.preempted` 8–16 s after the guest power key. At 18:46:18 the control plane logged `unreachable-restart` (`silent_ms=31543`, `corroboration=health_no_answer`), then stopped and started the instance; the orb was `running` at 18:47:43. The candidate explanation is a preemption whose record was never written because the control-plane stop overtook it. It is unproven.

Every guest journal ends with `systemd-logind: Power key pressed short` followed by an orderly poweroff. There was no OOM, panic, or ENOSPC signature, and memory use was about 2 GB of 16 GB during the interrupted runs.

## Impact

- Systemd killed in-flight tool processes, and the agent saw `Exit code 137`. Two full-slice E2E runs and one typecheck were lost.
- The Claude harness records `claude.operation_interrupted` ("Previous operation was interrupted. Send a message to continue.") and does not auto-resume. Each preemption therefore stalled work until the user wrote "Continue!".
- The agent first attributed the restarts to the E2E inheriting the orb's `PI_ORB_*` environment, because two restarts coincided with E2E runs. A third restart while idle disproved that. The retracted claim was never committed.

## Rule

This repeats the incident rule in `docs/lifecycle.md` (2026-10-04): attribute a restart only after correlating guest shutdown evidence with the provider audit. From inside an orb, `sudo journalctl --list-boots` plus `gcloud compute operations list --filter="targetLink~<instance>"` answers this in one step. Preemption frequency is open question 76 in `docs/open-questions.md`.

Evidence: `.context/preemption-storm/{orb-operations.json,fleet-preemptions.tsv,guest-shutdowns.txt}` in the investigating orb.
