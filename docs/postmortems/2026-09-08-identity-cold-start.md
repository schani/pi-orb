# Identity refresh self-throttles behind a cold runtime API

## Decision and correction (2026-09-08)

The identity CLI gives each HTTP attempt the **remaining portion of its existing ten-second invocation budget**, including both headers and body. It no longer imposes an independent three-second attempt cap. Fast failures still retry with bounded backoff and `Retry-After`; a late wake cannot start a request after the budget is exhausted. The two-second mint floor, token lifetimes, trust policy, credential helper, and Cloud Run scaling configuration are unchanged. No shared credential lock or token cache was introduced.

`PI_ORB_ID_TOKEN_DIAGNOSTICS=1` optionally emits a strictly allowlisted attempt/result/retry/budget-exhaustion schedule on stderr. It includes attempt numbers, elapsed/remaining milliseconds, outcome kinds and retry hints, never request fields, tokens, bearer headers or arbitrary error text. Stdout remains the token and one newline; the default successful CLI is silent on stderr.

## Original incident evidence

The earlier deployment errors were initially attributed to independent gcloud/OpenTofu credential refreshes. Original Cloud Run logs instead place **both failures at cold starts** of `pi-orb-runtime-api-00050-r5q` (the runtime service has minimum instances zero):

| UTC on 2026-09-08 | Event |
| --- | --- |
| 16:07:13.739 | Runtime API instance starting |
| 16:07:22.990 | Startup TCP probe succeeds (~9.25 seconds later) |
| 16:07:13.721 / 16.902 / 20.404 | Mint request timestamps; eventual statuses 200 / 429 / 429 |
| 16:07:23.384 | This orb's deduplicated `identity-mint-denied code=rate_limited` edge |
| 17:30:33.043 | Runtime API instance starting |
| 17:30:41.104 | Startup TCP probe succeeds (~8.06 seconds later) |
| 17:30:33.040 / 36.233 / 39.736 | Mint request timestamps; eventual statuses 200 / 429 / 429 |
| 17:30:41.498 | This orb's deduplicated rate-limited edge |

The installed CLI/endpoint/loop source hashes matched the checkout. The credential helper configuration used the reviewed `/usr/local/bin/pi-orb-gcp-identity`, with a 30-second executable timeout. The actual runtime CLI had a ten-second retry budget but cancelled each HTTP attempt after three seconds.

Cloud ingress retains requests behind startup even after a client abandons them. When the server finally starts, an earlier request can claim the mint slot and produce a token for a disconnected caller. The queued retries then get valid rate-limit replies. The CLI has already spent most of its invocation budget on transport timeouts, so it cannot wait out the remaining mint floor. The final exit code names throttling, obscuring the earlier transport delays.

## Token-free live and controlled captures

Evidence is under `.context/credential-diagnosis/`. No HTTP debugging or shell tracing was enabled. The temporary preload recorded only timestamps, PID/caller labels, HTTP status, numeric retry hints and sleep timing. Successful token response bodies were not inspected by the observer. SDK stdout was discarded; raw SDK stderr was inspected in memory only for fixed failure classifications, never persisted. Credential/state scratch directories were removed.

- `sequential.jsonl`: a fresh gcloud read followed by OpenTofu GCS-backend initialization. OpenTofu received 429 with a 1,030 ms body hint, slept 1,030.6 ms, then received 200. Both tools exited zero.
- `concurrent.jsonl`: simultaneous fresh tools. Gcloud received 429 with a 1,560 ms hint, slept 1,561.2 ms, then received 200. Both tools exited zero.
- `original-http-schedule.json` and `original-startup-events.json`: the historical Cloud Run evidence above, projected to request status/timing and startup messages.
- `controlled-cold-schedule.jsonl`: a test-owned loopback ingress held requests for 8.5 seconds before forwarding them to the warmed real mint API. It intentionally preserved accepted requests after caller disconnect, matching cold ingress. Real Google federation and read-only gcloud/OpenTofu operations were used, not fake Google tokens.

The controlled comparison reproduced the defect and verified the correction:

| Consumer | Original installed CLI | Corrected checkout CLI |
| --- | --- | --- |
| gcloud project describe | Three requests; 200 for disconnected caller, then 429/429; helper exit 5, tool exit 1 | One request; connected 200; tool exit 0 |
| OpenTofu GCS init | Three requests; 200 for disconnected caller, then 429/429; helper exit 5, tool exit 1 | One request; connected 200; tool exit 0 |

Only the corrected trials shadowed the `pi-orb` executable in that child's PATH to run the checkout CLI. They retained the installed reviewed credential helper. No installed runtime source, global credential configuration, production service or rate limit was changed. SDK exchange/API work is outside the CLI's ten-second budget; the whole OpenTofu command can legitimately take longer.

## Deterministic reproduction and validation

`id-token/cold-start.dst.test.ts` models FIFO processing after 8.5 seconds, including successful server minting for abandoned requests. The original code failed; its trace is retained at `test-failures/id-token-cold-ingress-1788893049597-0.json`. Explicit replay reproduced the failure before the fix. The test's historical-cap variant replays that same trace and asserts the three arrivals at 0, 3,250 and 6,750 ms and the final rate-limit error.

Strict replay against the corrected path reports the expected timer-contract divergence (first deadline 8,500 instead of 3,000 ms), not an intermittent failure; that log is retained as `cold-start-after-replay.log`. Fresh corrected schedules pass with exactly one request. Other tests pin a server unavailable beyond ten seconds, reduced remaining budget after a fast failure/backoff, no post-deadline request after a late wake, a stalled response body, diagnostic redaction and actual CLI stdout/stderr separation.

Repository typecheck, lint and unit/infrastructure tests passed after correction. The subsequent fixed-workspace validation also passed all 65 Docker/PostgreSQL/browser E2E tests and a native image build using the corrected CLI for the scoped deployer's normal credential refresh. Full release gates remain mandatory before deploying the changed runtime; this investigation did not deploy it.

## Rejected or deferred responses

- **Shared mint admission:** not needed to fix the observed failure. Independent consumers recovered normally in the captured warm schedules.
- **One-shot/stage-scoped access-token injection:** bypassed the symptom during investigation but is not needed for this root cause and introduces child-process token-expiry constraints.
- **Longer total retry window or weaker mint floor:** unnecessary. The first response fits inside the existing budget when we stop abandoning it prematurely.
- **Keeping a runtime API instance permanently warm:** could reduce cold starts, but adds serving cost and does not correct the client contract for a slow/restarting endpoint.

Cold starts or outages longer than ten seconds can still return a bounded unavailable error. This correction does not promise universal mint success or exactly-once server processing after cancellation.
