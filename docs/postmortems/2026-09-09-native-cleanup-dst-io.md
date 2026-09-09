# Native cleanup DST mixed virtual scheduling and real log IO

## Evidence (2026-09-09)

CI run `34391520018`, commit `07d20c5`, failed
`native-image-late-create-cleanup` at iteration 1: the simulator exceeded 200,000
scheduling steps at virtual time zero. Its automatic replay did not reproduce.
The downloaded trace was replayed against the unchanged target scenario before
any fix; it also passed. Running the trace against the whole test file additionally
produced an unrelated scenario-name divergence, so the target-only replay is the
relevant result. Neither passing replay cleared the original failure.

The test replaced command execution and cleanup time, but
`GcloudImageBuildEffects.execute` still awaited real `mkdir`/`writeFile` calls for
command logs. Their completion was outside the recorded schedule. The fake cloud
task also remained runnable in a checkpoint-only loop after materializing its
resource, waiting for cleanup to finish. That unnecessary observer could consume
the step budget while real IO was pending and could prevent virtual time from
advancing when cleanup awaited a timer.

## Correction

Command-log persistence is now an injected, typed `ResultAsync` boundary. Normal
builds retain owner-only filesystem logs. DST replaces that boundary with
checkpointed in-memory persistence, including an explicit 25 ms virtual delay.
The fake cloud task ends after materialization: the modeled resource remains
observable without an active observer task. Non-timeout scenarios disable late
timer injection; the separate bounded-timeout scenario remains.

Coverage requires successful owned-resource cleanup with immediate and delayed
log persistence, foreign-operation exclusion, bounded operation timeout, and
visible log-write failure without proceeding to deletion. The scheduling-step
limit and production cleanup budget are unchanged.

## Rule

A deterministic adapter test must replace every effect reachable on its tested
path, including diagnostics. Recording entropy cannot reproduce OS filesystem
completion. Do not keep an artificial task runnable merely to preserve a model
value; use persistent model state and explicit simulated waits.

Original evidence is retained in `.context/one-button/ci-traces-34391520018/`,
`github-ci-34391520018.log`, and the two pre-fix replay logs. The GitHub failure
artifact retains the original trace as well.
