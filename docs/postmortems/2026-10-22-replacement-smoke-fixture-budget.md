# Replacement-smoke fixture wall budget (2026-10-22 PDT)

## Evidence and limits

`final-batch-infra-correct-env.log` records a 90s `TimeoutExpired` in the
large-metadata Stage-2 smoke. The suite failed; native-VM qualification did not
run. Unittest removed the fixture before inspection; only the traceback survived.
Log SHA-256: `7e88c17f4d016c6d763470770645047a57efab5201658702fa086297414be016`.
The earlier 69.402s receipt covers two cases, not this case alone. Aggregate
infra/image intervals overlapped, but the failing case's interval/resource
schedule is unknown. Concurrent building is not an established cause.
Private evidence: `.context/test-audit-remediation/smoke-timeout-analysis.md`.

## Controlled mechanism

The original success path starts 1,217 Python interpreters, including 130 fake
sleeps; unused imports add cost. Two 65-observation windows account for 1,040
starts. Owned transient systemd services constrained the fixture subtree,
including detached sessions; other tests/builds were serialized. Deadline (90s),
padding (65,536 characters), authenticated adapters and raw-input jq guard stayed
unchanged. Snapshots, receipts, quotas and throttle counters remain private.

- At 40% CPU, original/candidate timed out after 80/103 observations
  (36.138/36.104s CPU). Both failures and safe snapshots remain.
- The declared second pair used 55%, based on that progress: original timed out
  after 121 observations with Stage 2 reached (49.635s CPU); corrected passed
  in 81.996s (45.173s CPU).

Stateless shell sleep and conditional stdlib imports reduced startup cost.
The success oracle pins 130 observations, 323 jq calls, 17 sensitive raw inputs,
151 curl calls, 305 gcloud calls and Stage 2. A disk-backed-input mutant fails
with exit42; restored bytes pass in 40.387s without quota. This demonstrates a
controlled startup-cost mechanism, not the original failure's cause or fix.

## Exception and ownership

**User-approved 2026-10-23 PDT:** attribution of only the original local 90s
`TimeoutExpired` in `final-batch-infra-correct-env.log` is waived as a
merge/deployment prerequisite. Preserve its first evidence; cause remains unknown
and no original fix is claimed. Controlled 40%-CPU failures, new failures,
exact-head gates, assertions, production rules, fixture cleanup and DST
replay/root-cause requirements are not waived.

The offline fixture used a Linux subreaper and bounded private timeout summaries.
Controlled witnesses checked owned descendants gone, a foreign sentinel alive,
primary-timeout preservation and capture before independent directory cleanup.
These historical receipts remain private; they are not current operational-probe
or fixture-owner qualification.
