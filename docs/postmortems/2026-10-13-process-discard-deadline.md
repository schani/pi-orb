# Process discard qualification deadline — 2026-10-13

## First failure

PR [92](https://github.com/schani/pi-orb/pull/92), head `2e1d692ce95717b4868b738fd5b6c617747abdc1`, first-attempt [CI 38483080314](https://github.com/schani/pi-orb/actions/runs/38483080314) failed at 16:30 PDT:

`apps/control-plane/src/adapters/process/provider.test.ts:709`, “discard kills group members that outlive the leader”, expected success but received retryable `unavailable`: `execution supervisor loss: descendant cleanup is unknown`.

4,654 tests passed; one failed. [E2E 38483080232](https://github.com/schani/pi-orb/actions/runs/38483080232) and [Durable 38483080198](https://github.com/schani/pi-orb/actions/runs/38483080198) passed all four shards on attempt 1. Nothing was rerun.

Evidence is preserved in `.context/pr92-first-attempt/`: original/full CI logs, run/job metadata, the downloaded CI trace artifact, and `delayed-supervisor-red.log`. GitHub artifact `ci-dst-failure-traces-38483080314-1` (11859060750) retains the uploaded traces for 14 days. The failing test is an OS-process test, not a DST scenario; the artifact contains existing replay fixtures, not a trace of this failure.

## Diagnosis

The test configured `terminateGraceMs: 150` but required unconditional success. Linux termination signals the Python subreaper, which must kill/reap descendants, fsync a matching drain receipt, and exit. The provider requires both receipt and supervisor absence before disposal. OS scheduling and fsync are not bounded by the test's 150 ms deadline.

The original error alone cannot distinguish deadline expiry from a supervisor disappearing without its receipt: both paths use the same message. CI did not preserve this host's receipt, process state or supervisor log. **The exact historical cause remains unproven.**

A controlled reproduction stops the supervisor with SIGSTOP, confirms `/proc/<pid>/stat` state `T`, and advances the test clock from 0 to 151 after the deadline is established. The original success assertion then fails with the identical error. This proves the timing assumption is invalid, not that the original runner followed that precise schedule.

## Correction and invariant

**Decision 2026-10-13:** separate successful drain from deadline expiry in the test. Freeze the success-path deadline clock while the real subreaper drains; the test runner still bounds hangs. For expiry, pause the supervisor and advance the clock explicitly. Assert retryable uncertainty retains metadata and live descendants. Resume, wait for the matching receipt and supervisor absence, then require a successful recovery discard.

Both cases assert matching receipts, supervisor/descendant absence and metadata removal. Failed assertions include the recorded birth identity, current supervisor stat, receipt and stderr. No production deadline, receipt gate or persisted schema changes.

Invariant: elapsed time never proves cleanup; disposal requires launch-matched drain evidence and supervisor absence. See `docs/host-provider.md`.

## Scoped release exception

**User decision 2026-10-14 (PDT):** historical root-cause investigation of PR 92's first CI process-discard failure is not a merge/deployment requirement. Preserve the evidence above; neither the historical cause nor its repair is claimed proven. Fresh first-attempt exact-head CI, E2E and Durable qualification, new-failure correction and DST replay remain mandatory.
