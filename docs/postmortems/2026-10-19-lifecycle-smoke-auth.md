# Lifecycle smoke failed before its first API request

## Failure — 2026-10-19, PDT

[Deploy 39269276700](https://github.com/schani/pi-orb/actions/runs/39269276700)
deployed `5b9653bd776836286db707d036d147de1f5ef906`, generation `1792422251`,
revision `pi-orb-issuer-00065-p5z`. Exact-source CI, E2E and Durable qualification
passed on attempt 1. Build, schema, apply, retirement and activation passed.
Release `r-1792421403-e3052fc2-613a-4009-b597-8ae96ba77713` remains
**applied-but-unvalidated**; identity and rollout monitor were skipped.

At 8:16:12 AM, the first lifecycle API invocation reported:

```text
smoke-http: phase=auth exit=1 outcome=failed
SMOKE FAILED: create-project unavailable
```

`gcloud auth print-identity-token` exited 1 before curl ran. It impersonates
`pi-orb-debug@playground-dev-6ae7.iam.gserviceaccount.com` for the application
origin. `infra/smoke_http.py` captured but discarded stderr. The roughly
10.6-second interval from the smoke-start log includes helper startup; it is
not an instrumented auth duration. This was neither an application HTTP
rejection nor the helper's subprocess-timeout branch.

## Read-only findings and limits

- GitHub auth initialized at 7:49:23 AM: provider `pi-orb-github/deploy` →
  `pi-orb-amp-deployer`. Monitor preflight passed at 7:50:00 AM using
  `infra/api.sh` and the same debug-service-account impersonation/audience.
  Cloud Run also recorded the release's `/api/v1/system` GET as HTTP 200 at
  7:50:23 AM. A permanently missing grant does not explain that sequence.
- The applied plan changed only the issuer's image/environment: zero additions,
  one change, zero destructions. No IAM changes were planned. The bounded
  7:48–8:17 AM policy/account/provider-mutation audit query returned no entries.
  Neither establishes the effective impersonation policy at the failure.
- IAM Credentials/STS audit queries for 8:14–8:17 AM returned no entries.
  Service-account/project IAM-policy reads were denied to the local deployer;
  audit configuration could not be established. Empty queries do not prove
  that credential requests were absent.
- Pinned `google-github-actions/auth` source writes a refreshable GitHub OIDC
  credential-source URL, not a static five-minute JWT. Twenty-seven minutes
  since setup is not evidence of token expiry. Successful durable GCS publication
  after the failure also does not prove that fresh debug impersonation worked.
- The local orb federates through `pi-orb-orbs/pi-orb-oidc`, not GitHub's provider,
  despite sharing the deployer service account. At 8:21:03 AM, an independent
  read-only verification successfully minted local debug-SA credentials and
  received HTTP 404 / typed `not_found` for project
  `828575c2-aa06-47be-af70-4736b52edf06` and orb
  `c1fe13a4-829c-492c-a1ed-ba6e7f2b3f2a`. Both requested fixtures are absent;
  no cleanup was needed. This proves local auth at that later time, not recovery
  of GitHub's historical failure. No GitHub-identity reproduction mint was attempted.
- Independent serving verification at 8:21:19 AM confirmed `00065-p5z` at 100%,
  generation `1792422251` and the release artifact's image digest. This does not
  clear the failed lifecycle gate.

**Underlying auth cause remains unknown.** Credential refresh/expiry, a terminal
transport failure and IAM denial are not established. No release/validation rerun,
production mutation, cleanup, IAM change or release-record change was performed
by this investigation.

## Historical-cause waiver — 2026-10-19, PDT (America/Los_Angeles)

The user explicitly waived explaining only Deploy `39269276700`'s recorded
historical debug-token mint failure: “You can waive that mint’s cause.” Missing
stderr leaves its cause unknown; no root-cause fix is claimed. Preserve the
first-failure evidence and failed gate. Both fixtures are verified absent;
deployed `5b9653bd` remains **applied-but-unvalidated**. No gate or future error is
waived: ordinary exact-head qualification, release validation and new-failure
handling remain mandatory. The telemetry/retry feature is implemented locally; hosted qualification and
release validation remain tracked in `TODO.md`.

## Initial diagnostic correction — local, undeployed

Auth failures retain the subprocess exit code, monotonic elapsed seconds and
only fixed allowlisted RPC/OAuth/transport categories. Unrecognized or conflicting
markers report `unknown`; raw stderr, stdout, URLs and credentials are never
printed. Execution failure and subprocess timeout are distinguished. No retry,
cache, deadline or gate policy changes.

Tests first reproduced missing diagnostics (17 expected failed assertions), then
all 11 focused tests passed with fake clocks and secret-bearing subprocess
results/exceptions. After `npm ci`, full infrastructure qualification passed:
92 Node, 186 Python and 32 native-VM tests, zero failures. Original first-failure
evidence is unchanged. These tests qualify diagnostics, not the historical auth cause
or production recovery. Hosted qualification and release validation remain tracked in `TODO.md`.

## Classified retry correction — local, undeployed (2026-10-19, PDT)

The user approved bounded classified retries for all external operations in the
normal lifecycle/identity smokes, not arbitrary command/stage retries. The smoke
adapter now covers authentication, GCE/SSH, preview, issuer verification,
federation and fixture-publication IO. Unknown failures fail closed; terminal
credentials, certificates, host keys, headers and typed bodies take precedence.
Assertions, malformed JSON, remote CLI failures and CAS conflicts do not retry.
Auth, response bodies and backoff share fixed deadlines. Publication retries the
same generation-fenced request only; it never refreshes the generation or retries
the whole transaction. No release schema or fixture-state changes were made.

Retained CI diagnostics contain only fixed operations/categories and numeric
attempt/status/budget fields. Remote mint diagnostics use the existing allowlist;
claim/body/error values are not printed. Cleanup distinguishes deletion, absence
confirmation and recording; PASS follows verified cleanup. Proven API absence
remains recorded as deleted even if publication fails: internal cleanup exit 2
clears that ID while keeping the gate failed. Shared projects alone never cause
an owned-fixture cost warning. Failed owned fixtures
retain IDs and a cost warning; credential scratch is removed on either verdict.

Tests were written before each correction; red/green receipts are retained under
`/workspace/smoke-retry-evidence/`. The first full infrastructure run exposed five
existing publication-diagnostic assertions: an overbroad wrapper suppressed
already-sanitized Result messages. Preserving those messages corrected the
wrapper; assertions remain unchanged. The initial full unit run was cut off by
an agent-imposed 200-second command boundary. Its retained output also exposed
two stale source contracts expecting raw SSH/describe commands in shell. Updated
contracts assert the same IAP/project/zone/metadata invariants at the new adapter
boundary, plus sanitized remote diagnostics. Their focused 28-test suite passes.
A prematurely launched second full unit process was explicitly stopped; all owned
descendants were verified absent. Neither incomplete run is claimed passed.
Final frozen-source local checks passed: 104 Node infrastructure tests, 217 Python
tests, 32 native-VM checks, workspace/E2E typechecks and repository lint (411
warnings, 83 informational findings, zero errors). Shell syntax and diff checks
passed. `infra-bookkeeping-qualified.log`, `typecheck-bookkeeping-qualified.log`,
`lint-bookkeeping-qualified.log` and
`infra-release-contract.log` retain those receipts. This infra-only runner change
did not run full E2E. Hosted exact-head CI must run the full unit suite. These
corrections establish runner behavior, not the historical auth cause or production
recovery; no deployment, validation-only run or release-record mutation occurred.

## Evidence

Original logs/record: `/workspace/deploy-39269276700-evidence/`
(`first-failure.txt`, `release-job.log`, `summary.json`,
`release-39269276700-1/release.json`, `current-serving.json`). Read-only additions:
`auth-audit-expanded.json`, `iam-changes-audit.json`, `policy-changes-audit.json`,
`preflight-http-audit.json`, denied `project-iam-readonly.stderr`, and pinned
`auth-action-wif.ts`. Independent checks: `read-only-fixture-verification.json`
and `read-only-serving-verification.json`. Local red/green/install/infrastructure
receipts and original-evidence hashes: `diagnostic-correction/`.

Authoritative record:
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1792421403-e3052fc2-613a-4009-b597-8ae96ba77713.json`.
