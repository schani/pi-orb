# 2026-09-04 · Stale `openai-codex` credential pointer on the local process-host deployment

## Symptom

Every orb on the local `PI_ORB_HOST_PROVIDER=process` / PGlite deployment failed during `creating` with `runtime_failed: credential_unavailable: broker token fetch failed: unavailable`. The control-plane log showed only the lifecycle transition plus dozens of one-second `broker pause` sleeps in the `http` task; nothing named the broker's reason.

## Cause

`credential_pointers` for `openai-codex` referenced secret version `v-84bf584c78f67532` (written 2026-08-09, access token expired 2026-08-14) at generation 1 with `row_version` 157. A newer version `v-f20b344bde9c6f08` (written 2026-08-25, access token valid until 2026-09-04 evening, rotated refresh token) existed on disk under `~/.pi-orb/auth/broker-secrets/` but was never committed to the pointer. Every token request therefore saw an expired credential, took the refresh lease, attempted an upstream refresh with the superseded refresh token, got a transient-class error rather than `invalid_grant`, released the lease, paused, and looped until `requestDeadlineMs`, returning `token_retryable`; the runtime retried through its boot window and surfaced `unavailable`. The 157 row versions are that lease churn.

How the pointer fell behind is not recoverable from the evidence: the secret write succeeded and the pointer commit did not land, which is the acknowledged loss window in `docs/credentials.md`, or the refresh ran under a different `PI_ORB_PGLITE_PATH` against the same auth directory. No log line distinguishes these.

## Repair

With the control plane stopped, the pointer row was moved to `v-f20b344bde9c6f08` at generation 2 (`update credential_pointers … where provider = 'openai-codex' and secret_version = 'v-84bf584c78f67532'`). After restart the failed orb started, reached `running`, and answered its queued message.

## Follow-ups

- Broker observability is insufficient: an upstream refresh failure, a deadline-exhausted token request, and the reason class must be logged by the `http` task and carried into the lifecycle failure text, so the next occurrence is diagnosable from the log alone (`TODO.md`).
- The superseded secret version was not destroyed and the newer one was orphaned; a startup reconciliation that reports pointer/secret-version disagreement would have caught this at boot (`TODO.md`).
