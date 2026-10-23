# Replacement-smoke fixture wall budget (2026-10-22 PDT)

## First failure

`final-batch-infra-correct-env.log` records a 90s `TimeoutExpired` in the
large-metadata Stage-2 replacement smoke. The Python suite failed; native-VM
qualification did not run. The original fixture was removed by unittest before
diagnostics could inspect it. Only its traceback survived. Log SHA-256:
`7e88c17f4d016c6d763470770645047a57efab5201658702fa086297414be016`.
The earlier 69.402s receipt covers **two** cases, not this case alone.

Aggregate infrastructure-test/control-plane-image intervals overlapped, but
neither the failing case's interval nor its resource schedule is known.
Concurrent building is not an established historical cause. No waiver applies.
Private evidence: `.context/test-audit-remediation/smoke-timeout-analysis.md`.

## Controlled mechanism and correction

The successful path starts 1,217 Python interpreters, including 130 stateless
fake sleeps. Every fake command imported pathlib/subprocess even when unused.
Two 65-observation windows account for 1,040 starts; these do not actually sleep.

Dedicated transient systemd services constrained only the owned fixture subtree,
including detached SSH/deploy sessions. Tests/builds were otherwise serialized.
The 90s deadline, 65,536-character padding, authenticated adapters and raw-input
jq guard stayed unchanged. Source snapshots, process receipts, quota settings
and sampled cgroup throttle counters are in `.context/test-audit-remediation/`.

- At 40% of one CPU, the original dispatcher timed out after 80 observations
  (36.138s service CPU). The first corrected candidate also timed out, after
  103 observations (36.104s CPU). Both failures/safe snapshots remain; this
  quota was insufficient for either implementation.
- A second pair was declared at 55%, from the first pair's observed progress.
  Original: 90s timeout, 121 observations, Stage 2 reached, 49.635s CPU.
  Corrected: all assertions pass in 81.996s, 45.173s CPU, same 55% quota.
  These are controlled resource limits, not an arbitrary overlapping build.

The fixture now uses a stateless shell sleep adapter with the same command
record and no state mutation. Its Python dispatcher uses stdlib-only `-S`,
loads subprocess/stat only for jq and time only for date, and loads pathlib
only for the two ownership-record checks. No production flag or adapter changed.
The successful case additionally pins all 130 observations, 323 jq invocations,
17 sensitive raw inputs, 151 curl calls, 305 gcloud calls and Stage 2.
The disk-backed-input mutant still fails with exit42; exact shell/helper bytes
were restored before the full successful case (40.387s without the quota).

This establishes avoidable interpreter/import cost as a causal contributor to
**controlled** timeouts and corrects that environmental performance assumption.
It does not reconstruct the original case's cause. Historical attribution remains
unresolved and blocking under the no-waiver instruction; passing qualification
must not silently close it.

## Failure ownership and evidence

A test-only child owner isolates the shell group. On Linux it is a dedicated
subreaper, kills the shell group, adopts/kills detached descendants and reaps them
before returning. Normal Linux success requires its joined receipt. Other POSIX
systems get group cleanup, not a claim of detached-descendant reaping.

Before temporary-directory cleanup, timeouts retain a fresh 0700 directory and
0600 summary under `.context/smoke-replacement-failures/`. The bounded allowlist
contains mode/stage, elapsed/budget, owner PID/PGID, joined status, lifecycle
scalars and command-category counts/last-started category. It never copies argv,
stdout/stderr, headers, tokens, hashes of secrets or full fixtures; symlinks and
oversized/nonregular files are refused. Capture/cleanup errors cannot replace
the original timeout failure. Directory cleanup remains independently owned.

Controlled tests inject a timeout only after a real detached descendant is ready,
then require both owned PIDs gone while an unrelated sentinel remains alive.
They also test reporter failure, cleanup failure, bounded/private snapshots and
stateless sleep logging. All first-failure evidence remains intact.
