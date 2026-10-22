# Rollout: recovered central agent-open cancellation

## Release qualification — 2026-10-21

All times below are PDT (PM). [Deploy 39696133025](https://github.com/schani/pi-orb/actions/runs/39696133025)
succeeded on attempt 1, both jobs. Exact-main CI, E2E and Durable qualification
also passed on attempt 1. Source `b264a7cb93b337beaea4258ecdca265699e565ab`
includes PRs [155](https://github.com/schani/pi-orb/pull/155) and [156](https://github.com/schani/pi-orb/pull/156).
Release `r-1792627923-d2f4d720-8985-4c57-aea5-401c0fb35ed5` finished
at 5:47:30: all 12 gates passed, `validated`, exit 0.

Serving revision `pi-orb-issuer-00069-hxp`, generation `1792628769`, digest:
`sha256:d386526a5837568ce0c95e110d1b5c0201613765f7e8c8819d7ed33c861d4228`.
Independent read-only checks confirmed exact serving/active release identity,
no release lock, four fixture 404s, four native-cleanup resource 404s,
migration-job 404 and both accepted images `READY`.

The separate 5:47:37–6:06:04 monitor reported `observed`: 1,106 seconds,
13 samples, 180-second metric lag. No errors, HTTP 429/5xx or lifecycle
anomalies occurred **inside that window**. Central inference was unobserved;
the observer had no live PostHog binding. This is not live feature-call qualification.

## Earlier postactivation edges

The wider 5:29:31–6:07:48 serving-revision query returned all 189 matching
rows: no errors or HTTP 429/5xx, but two flagged lifecycle edges. Its recorded
outcome remains `blocked`, not an anomaly-free whole-interval result.
Pagination completeness does not exclude delayed log ingestion.

- **5:36:04.751388:** release activation granted.
- **5:36:05.539911:** orb `dbe40ba4-6860-4d70-b119-31be81985fcd`
  rejected with `legacy_backend`, admission 1, disposition `create_new_orb`.
  This is intentional legacy policy, not activation rejection.
- **5:36:18.136847:** original PostHog orb `377b20ee-849f-404d-ad76-eb57596a6b66`
  emitted `central-agent-unavailable`: static `agent open cancelled`, mapped
  to `history_unavailable`, `retryable=false`; owner fence 21.
- **5:36:25.945820:** ordinary reconciliation recovered at fence 23,
  `harness.opened recovered=true`, 7.809 seconds after the unavailable edge.
  No repeat appeared through 6:07:48. Read-only orb GET at 6:11:52 showed
  running/busy, central placement and no `lastError`.

## Attribution and disposition

Source inspection establishes successful final admission but an aborted combined
`openSignal`. The operation deadline and admission/opening canceller share that
signal; no durable field identifies its sender. The 10-second central-health
deadline fits the timing but is **not proven**. `stage=projection` also spans
the opened edge and final admission: it does not prove projection took too long.

Cancellation code predates PRs 155/156; no introduced-regression cause is established.
The same-orb old-revision query (4:30–5:36) found no matching failure;
no previous observed occurrence is established.

No flaky test, failed release gate or persistent degradation was found.
The recovered edge alone did not justify rollback. No operator retry/restart,
timeout increase, behavior change or telemetry implementation followed.
Generic cancellation cannot establish abort origin. Existing admission guards,
monitor policy, thresholds and exceptions remain unchanged. The diagnostics
proposal is tracked only in `TODO.md`.

## Retained evidence

Under `.context/pr156-rollout/`: `release-artifact/release.json`,
`monitor-artifact/rollout-monitor.json`, `independent-verification.json`,
`final-verification.json` and `early-lifecycle-events.json`.
