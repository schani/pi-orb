# Central agent open deadline

2026-11-19; all times PT. Revision `pi-orb-issuer-00105-hms`.
Evidence: [trusted Actions run](https://github.com/schani/pi-orb/actions/runs/44604643602)
and [full monitor artifact](https://github.com/schani/pi-orb/actions/runs/44604643602/artifacts/14573417665).
The monitor flagged both the failed open and the blocked delivery; the release record remains validated.

## Timeline

These events are from one instance and one orb lifecycle.

| Time (PT) | Event |
| --- | --- |
| 12:48:49.281 | Sleep wake queued. |
| 12:48:50.560 | Orb transitioned from stopped to starting. |
| 12:48:52.073 | `resources.ready`. |
| 12:48:58.520 | Owner acquired fence 1277, admission 602. |
| 12:49:03.414 | `harness.opened` with `recovered=false`, before the final admission check, resume, and publication. |
| 12:49:03.519 | After orderly drain and release and `harness.open_failed` (`stage=projection`), `central-agent-unavailable` reported “agent open cancelled”. |
| 12:49:05.238 | Same lane: `central-delivery-blocked`, “central agent is not open”. |
| 12:49:07.949 | New owner acquired fence 1279, still at admission 602. |
| 12:49:13.479 | Harness reopened with `recovered=false`. |
| 12:49:14.005 | Original Sleep wake batch dispatched as a new turn. |

The tool ran after host readiness at 12:49:43. The turn later completed and queued its
summary around 12:50:26. There is no evidence of message loss.

## Cause and limits

The 10-second central activity deadline expired before open reached its post-projection
gate, which ran at least 11.34 s after `resources.ready`. The health budget already included
resource preparation via `prepare` in `main.ts`, before lease acquisition. The budget covers
resource preparation, lease acquisition, agent build, and projection. The recorded edges
do not identify the exact moment the deadline fired or which inner operation ran slowly.

“Agent open cancelled” at that gate means the final authority check cleared but the open
signal was aborted. There is no evidence of lease loss, shutdown, or admission advance. This
was not a native code-mode replay refusal: the attempt did not recover and never resumed.

The same instance's 12:49:19 HTTP diagnostic window recorded a 3.8195 s maximum main
event-loop sampling gap and ~96.6% peak main-thread CPU in a delayed sample. Concurrent
otherwise-fast requests took ~2.6–3.5 s. Main-thread stalls likely contributed, but without
a profile we cannot say what code consumed the time or why.

A query starting November 17 found seven identical open-cancelled events on two earlier
revisions before cutover. This rollout did not introduce this class of failure.

## Durable shard 2 Stop fixture

The [first shard attempt on `79246c64`](https://github.com/schani/pi-orb/actions/runs/44652529197/job/136010667588)
and its [fixture artifact](https://github.com/schani/pi-orb/actions/runs/44652529197/artifacts/14591866713)
show Stop cancelling the waiting `bash` callback and settling while setup was held.
On authorized reopen, the Durable harness recovered the unfinished `VM_EFFECT` turn.
Activation resumes native work before the central poll can dispatch fresh inbox input.
The first recovered request (#33) contained the outer codemode result reporting
`Tool bash was interrupted and may have partially run`. The ordered mock matched only
`Tool codemode …`, so it returned 400 `no_matching_rule`. The actual `RESUME_STREAM` turn
(#34) still streamed and read the pinned snapshot on the original subscription; the final
non-200 request assertion caught the earlier failure.

The fixture now explicitly Starts, scripts a text-only acknowledgement of the
interruption, and waits for the recovered operation and its summary before submitting
`RESUME_STREAM`. The fresh turn still exercises the held stream and pinned snapshot
on the original subscription while replacement setup is held. No startup or Stop
behavior changed.
