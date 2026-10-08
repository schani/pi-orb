# E2E device approval lost before response headers — 2026-10-08

PR 66 [run 37714610355](https://github.com/schani/pi-orb/actions/runs/37714610355),
shard 2, failed the unknown-profile/model case in `e2e/subagents.e2e.test.ts:640`.
The hosted mock approval POST exceeded its 15-second deadline before returning
headers. No runtime assertion ran. The other 145 shard tests passed.

## Evidence and limits

The first failure names `POST /api/__mock__/sessions/sess_975d6665c1e03ea4ae4e3d38/deviceauth/approve`,
one attempt, and `TimeoutError`. The retained `subagent-profiles/failure.json`
shows an orb waiting for login with empty history. Approval is not recorded by
the mock's inference/auth ledger; teardown deleted the session. These records
cannot distinguish an unaccepted request from an accepted request with a lost
response, or identify a network, edge, worker, or database stall. No Cloudflare
logs or credentials were available during this investigation. The historical
stall initiator remains unproven; a passing rerun does not establish it.

The harness deliberately disabled approval retries because replay safety had
not been established. Inspection of [fake-openai at `eaa274c`](https://github.com/glideapps/fake-openai/tree/eaa274c562ea7b1ec6dce496a1442cfbb55b4106)
now establishes the contract: `routes-control.ts` looks up the device row by
session and user code, then `store.ts` sets its status to `approved`. Repeating
that write creates no device, token, or grant. `routes-oauth.ts` retains the row
through polling and token exchange. The test owns the session and does not
concurrently reset, expire, or delete it.

A live contract probe confirmed HTTP 200 for first approval, repeat approval,
and approval after successful token exchange, with one device row and one issued
token. This verifies deployed behavior, not deployed binary identity.

## Correction and validation

Two tests-first unit regressions inject a lost response before and after simulated
acceptance. Both deterministically failed with the original one-attempt error.
`fakeControl` now opts only the exact `/deviceauth/approve` write into the existing
three-attempt transport policy. Other writes remain non-replayable. HTTP errors
remain terminal. The 15-second deadline and 250/500 ms backoffs are unchanged.

Retry warnings identify method, session path, timeout versus other transport
failure, and next/max attempt in retained CI logs; request bodies, user codes,
tokens, and raw transport messages are not logged. Final failure still retains
the original cause.

`e2e/fake-approval.e2e.test.ts` pins the hosted replay contract. It injects loss
before forwarding and after a real successful approval, then verifies recovery,
polling, token exchange, and replay after exchange without duplicate device/token
rows. This prevents treating an arbitrary write as replay-safe by assumption.

Validation: 15/15 harness unit tests; 2/2 hosted contract E2Es; the original
unknown-profile/model case passed on the process backend. Docker was unavailable
in this orb; these results do not claim full Docker-shard qualification. Evidence:
`.context/pr66-e2e-approval/` (first CI log, red/green unit logs, live contract
summary, contract and profile E2E logs). The fix addresses the reproducible
harness recovery defect, not the unobserved initiating infrastructure stall.
