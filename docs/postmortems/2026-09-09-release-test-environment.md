# Release tests inherited the real evidence directory

## Evidence (2026-09-09)

The first full Deploy workflow, run `34404803408` at `e408829`, passed keyless
preflight and entered checks. While monitoring it, review found that the shell
contract fixtures copied `process.env`, including the workflow's
`PI_ORB_RELEASE_RESULT_DIR`. Their mocked release commands therefore wrote mock
records to the real transaction's local `release.json` instead of fixture-owned
storage. The production script also exported `PI_ORB_RELEASE_RECORD` before tests.

Before fixing code, a local reproduction supplied a sentinel parent result file.
All 15 contract tests passed, but the sentinel was overwritten with mock commit
`abc123`. After the fix the same explicit-parent-directory experiment passed all
15 tests and preserved the sentinel. Original and corrected evidence are separate
under `.context/workflow-release/isolation-repro*` and `isolation-fixed*`.

The workflow was deliberately cancelled in checks. Its durable record still had
`artifacts: null`, `migrationJob: null`, and `applyAttempted: false`; all four
serving revisions remained unchanged. No image build, migration or application
apply was started. The reporter rejected the corrupted local record rather than
uploading it or reporting success.

GitHub cancellation terminated the launcher and later reaped `release.sh` as an
orphan; its cleanup trap did not release the global lock. The completed cancelled
job, exact commit/release/lock identities, checks-only record and absence of
migration jobs and pending compute operations were independently verified. The
original durable snapshot was preserved, then its exact object generation was
finalized as `failed-before-apply` with the GitHub completion time. `exitCode`
remains null because no actual process exit code was observed. Only that lock's
exact generation was removed. This was an explicit evidence-backed repair, not
an automatic stale-lock expiry or a release retry.

## Correction and rule

Checks run without either `PI_ORB_RELEASE_RESULT_DIR` or `PI_ORB_RELEASE_RECORD`.
Only the smoke phase receives the real fixture recorder. Contract tests also clear
both inherited variables and restore their parent environment afterwards; their
mock npm asserts neither variable reaches checks. One transaction test supplies
explicit owned result paths to exercise the production environment boundary.

The workflow uses `exec` to make the release command the signal recipient rather
than an orphanable launcher child. This improves normal cancellation, but hard
runner termination can still leave remote work and locks. Never infer safe unlock
from process death alone.

A test's subprocess environment is part of fixture ownership. Passing assertions
are not evidence of isolation: tests must not be able to rewrite the invoking
release's result, publish its fixtures, or inherit its transaction context.
