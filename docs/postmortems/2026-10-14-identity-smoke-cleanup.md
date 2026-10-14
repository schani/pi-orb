# Identity assertions passed; fixture cleanup failed

## Evidence (2026-10-14, PDT)

[Deploy 38596107385](https://github.com/schani/pi-orb/actions/runs/38596107385)
ran source/runner `310def9658c2fe58125494b2ca57b6e0fdf41974`.
Its release artifact records
`r-1791994953-bf23941b-9113-42c7-851d-a9f60281de8f` as
**applied-but-unvalidated**, phase `identity`, exit 1, finished 10:26:52.
Lifecycle fixtures were deleted. Both identity fixtures were `cleanup-failed`:

- `37b222a3-7aef-45df-9ff3-a93739c940b4`
- `f1a2dfaa-922c-4673-af5d-381571961c28`

Identity assertions, including STS federation, succeeded. At 10:26:28 the
script printed `WORKLOAD-IDENTITY SMOKE PASSED` before its EXIT cleanup.
The run contains no `Fixture cleanup not confirmed` diagnostic.

Parent read-only evidence: the scoped Cloud Run DELETE query for
10:26:25–10:27:05 returned zero rows; both fixtures were stopped with no
deletion intent. Those observations were not independently re-queried during
this correction. Zero rows in that scope do not establish why requests failed.

Preserved locally under `.context/identity-smoke-cleanup/`:
`deploy-38596107385.log`, `deploy-run.json`,
`release-artifact/release.json`, `parent-evidence.md`, and red/green/check logs.
The GitHub release artifact is a copy of the authoritative record at
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1791994953-bf23941b-9113-42c7-851d-a9f60281de8f.json`;
this task did not read or mutate cloud state.

## Established defect and limits

`infra/api.sh` discarded identity-token stderr, suppressed curl transport
diagnostics and dropped HTTP status. `fixture_delete` silently recorded its
first two failure branches. The success banner preceded cleanup.

These defects explain missing diagnostics and the misleading banner, not the
historical cleanup failure. Authentication failure, transport failure and
application/ingress rejection remain unproved. No root-cause fix or historical
investigation waiver is claimed.

## Correction (2026-10-14)

- API failures report fixed phase/error categories, actual adapter exit codes,
  and HTTP status when available. Raw stderr, tokens and error bodies stay out
  of output; the bearer still travels through stdin.
- Only HTTP 404 with the application's `not_found` response produces a
  canonical absence envelope (`httpStatus: 404`). Other HTTP/application
  failures return nonzero without their bodies.
- Every fixture cleanup failure reports owned kind/ID, phase, exit and a fixed
  error category, while retaining the existing `cleanup-failed` outcome.
- Complete identity `PASSED` is emitted only after all required deletions are
  verified absent and recorded. Assertion success is not cleanup success.

Failure retention, project ownership, polling budgets, retries, release
allowlists and persisted schemas are unchanged. Offline fake-gcloud/curl tests
exercise the real API script; cleanup tests exercise every failure branch and
the final verdict. These checks do not establish live recovery or qualify a
deployment. No local heavy E2E or cloud mutation was performed; mutation
remains Actions-only pending a new explicit parent directive.
