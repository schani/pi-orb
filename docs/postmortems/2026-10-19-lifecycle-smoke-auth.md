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
transport failure and IAM denial are not established. Historical waivers do not
cover this failure. No release/validation rerun, production mutation, cleanup,
IAM change or release-record change was performed by this investigation.

## Diagnostic correction — local, undeployed

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
or production recovery. Remaining investigation is tracked in `TODO.md`.

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
