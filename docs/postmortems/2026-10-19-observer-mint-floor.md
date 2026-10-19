# Observer credential refresh hits the mint floor

## First window — 2026-10-19, PDT

After validated recovery `39283648895`, manual observation ran
9:37:29–9:55:35 AM PDT (16:37:29–16:55:35 UTC), 1,085 seconds,
12 samples. Raw outcome: **regression**, with 123 observed HTTP 429s;
ERROR, HTTP 5xx and lifecycle regression counters were zero. Health, metrics
and placement were covered; central inference was **unobserved**.
This is not a clean monitor receipt.

Retained `/workspace/validation-recovery-evidence/rollout-monitor.json` is
unchanged, SHA-256
`81ad978f8251b6b3b997aa8a776be6e451e6418534e1ee0db95e038ed904304f`.
The subsequent query found 124 HTTP 429s and 124 typed
`identity-mint-denied incarnation=1 code=rate_limited` edges for operator orb
`b8400610-13aa-4ab2-968d-f99ad5fed3ae`. Unique one-to-one pairs share revision
and instance within 50 ms (maximum 46.997 ms). Corrected correlation:
`/workspace/validation-recovery-evidence/first-window-429-correlation-corrected.json`.
Request `statusDetails` and denial stdout traces are absent; pairing uses
instance and timestamps, not a shared trace. The later query does not rewrite
the original sample count or verdict.

## Cause and limits

SDK 589's IAM impersonation helper unconditionally refreshes source credentials.
The observer calls `gcloud auth print-identity-token` six times per sample;
its external-account executable reaches `pi-orb id-token`. This orb's
parallel cloud-read credential flows share the same per-orb two-second mint
floor. Typed denials establish application mint-floor responses, not ingress
capacity refusals. Evidence attributes them to this orb's observer/parallel
credential flows, not an individual caller. It does not explain the earlier
GitHub runner mint failure in
`docs/postmortems/2026-10-19-lifecycle-smoke-auth.md`.

Offline actual SDK `_Load`/IAM paths with fake transport select
`AccessTokenCredentials` under `CLOUDSDK_AUTH_ACCESS_TOKEN`: external-source
refresh calls fall from one to zero. Six operator-launcher tests pass,
including typed failure propagation. Original diagnostic/launcher test failures
and corrections remain in
`/workspace/validation-recovery-evidence/observer-isolation/README.md`.
These tests prove the isolation mechanism, not live permissions, expiry or a
clean observation window.

## Operator isolation decision — approved 2026-10-19, PDT

The read-only harness acquires one Google access token **before** a separate
window, then supplies it only to its private child environment through
`CLOUDSDK_AUTH_ACCESS_TOKEN`, with
`GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES=0`. File/HTTP logging is disabled;
there is no new persisted JWT, cache or application-state contract and no
mid-window reacquisition. Initial acquisition may touch existing SDK cache or
config state; no universal zero-write guarantee is claimed. The environment
is not a same-UID/root security boundary.

Actual token expiry is unverified. The SDK's default 3,600-second lifetime and
an 1,800-second wall cap are bounds, not expiry introspection; shorter expiry
or API/CLI failure fails closed. IAM impersonated-token requests still occur.
The observer implementation, assertions, thresholds and 429 filters are
unchanged: no reset or exemption. The original release/monitor records remain
unchanged, as do product revision `00065-p5z` and generation `1792422251`.
Global 429 classification remains unresolved in `TODO.md`; this operator-only
isolation does not change normal-monitor policy or add source hooks.

## Separate isolated observation — 2026-10-19, PDT

The later 9:58:56–10:17:51 AM PDT window recorded **observed**:
16 samples, recorded duration 1,134 seconds. Every sample was available with
healthy service, unchanged placement, fleet and all required metrics covered.
ERROR, HTTP 429/5xx and lifecycle regression counters were zero throughout;
central inference remains **unobserved**. This qualifies the separate isolated
window, not the original rollout window; the first regression is not overwritten.
No mid-window reauthentication, new cache or application state was introduced.

Receipt: `/workspace/validation-recovery-evidence/rollout-monitor-isolated.json`,
SHA-256 `37663d263e3f9f7f5dd5df7a9c59c701bb2f775bae1e5fd8dc727526da4337b6`.
Launcher outcome and live pre-window provenance checks are retained in
`/workspace/validation-recovery-evidence/observer-isolation/launcher-status.json`
and `isolated-provenance.json`. Provenance pins previously downloaded evidence;
it does not recompute the artifact archive digest or verify a signature.
Validation receipt:
`/workspace/validation-recovery-evidence/release-39283648895-1/release.json`,
SHA-256 `b22d058e871db5950dd62f051a6784284464e9e7e452db49d519e7a3afe44091`.
`/workspace/validation-recovery-evidence/observer-isolation-owned-cleanup.json`
confirms launcher PID 13930, observer PID 13963 and its process group absent;
the launcher log was empty and status recorded **observed**. Direct `nohup`
launch retained no raw OS exit-code receipt; captured exit 0 is not claimed.
Summary: `/workspace/validation-recovery-evidence/FINAL-MONITOR-SUMMARY.txt`.
The SDK-cache, actual-expiry and credential-environment limits above still apply.
