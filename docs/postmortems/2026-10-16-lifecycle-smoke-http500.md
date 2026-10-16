# Lifecycle restart poll received HTTP 500

## Outcome — 2026-10-16, PDT

[Deploy 38961777202](https://github.com/schani/pi-orb/actions/runs/38961777202) selected `e6710059313ceb8b90ad363acc61ca62297717ec`. Exact-source CI, all four Docker E2E shards and Durable qualification passed on attempt 1. Release `r-1792183306-b4162f18-2c6b-434f-b31c-c956a08da999` passed preflight, checks, build, plan, schema, apply, repair, retirement and activation. Lifecycle failed; identity and the independent rollout monitor were skipped. Final outcome at 2:04:26 PM: **applied-but-unvalidated**, exit 1. No retry, bypass, rollback or manual cloud mutation occurred.

The authoritative GCS record and GitHub artifact `release-38961777202-1` contain equal JSON (different whitespace). No rollout-monitor artifact exists; the upload step succeeding does not establish observation.

## Direct failure evidence

- 2:03:02 PM: first boot reached `running`.
- 2:03:31 PM: first stop reached `stopped`.
- 2:03:34 PM: restart reported `starting`.
- 2:04:19 PM: `jq: parse error: Invalid numeric literal at line 3, column 0`, then `SMOKE FAILED: restart: no orb state`.

Cloud Logging records HTTP **500** at `2026-10-16T21:04:19.004801Z` for the exact smoke GET `/api/v1/orbs/a589d6ce-fa69-42c9-9a6e-07484934a05f`, user agent `curl/8.5.0`, latency `0s`. Trace: `projects/playground-dev-6ae7/traces/d81fb43135035a2626663e45038dda9c`. The request row names **old revision `pi-orb-issuer-00060-kfk`**, not newly serving `00061-m4d`. Its direct trace query returns only that request row: no application exception or response body. An unrelated browser GET received another old-revision HTTP 500 ten seconds earlier.

The old revision's system log reports `Shutting down user disabled instance` at 1:57:49 PM; Actions records revision deletion completing at 1:58:04 PM. Retirement recorded active/idle zeroes at 2:00 PM and activation completed at 2:01:39 PM. These observations do not establish why a later request was attributed to the old revision. **Root cause remains unknown; stale routing is not proven.**

At the failure, `infra/api.sh` did not fail on HTTP error status or preserve response status/content type; `infra/smoke.sh` parses its body as JSON. This explains the reported assertion path, not the origin of the HTTP 500. The failed response body was not retained. Later successful reads do not clear the gate.

## Read-only verification

At approximately 2:05–2:07 PM:

- Issuer `pi-orb-issuer-00061-m4d` was Ready at 100% traffic. Its image matched `sha256:598a2cecfc41f2b3e2cc0c247a250c3bf333906d2b8dd2047c0e6dbeaf6e4686`; serving and active-pointer generation matched `1792184072` and the release ID. `/health` returned `{"status":"ok"}`.
- Release lock returned 404; the exact migration job was absent.
- Native builder/validator instances and temporary build disks were absent; both retained production images were Ready with recorded IDs `5679152185271595859` and `5374392296768746371`.
- Project `e37f5fdb-06b2-4b70-8e93-fd401f48463d` and orb `a589d6ce-fa69-42c9-9a6e-07484934a05f` were intentionally retained at that point. The orb API reported `running`, `lastError:null`; its GCE instance was RUNNING with 20 GiB boot and 50 GiB workspace disks. Cleanup had not yet been authorized.

## Authorized fixture cleanup — 2026-10-16, PDT

Fresh API reads verified the project in smoke owner `53da7ad4-6c53-4223-868e-0641bb4bcdd9`'s project listing, its expected smoke name/repository, and exactly one child: the authorized running orb. Compute reads verified the orb label, incarnation `0`, attached disk URLs and IDs in `playground-dev-6ae7/us-central1-a`:

- Instance `pi-orb-a589d6ce-fa69-42c9-9a6e-07484934a05f-i0`: ID `210690005985603107`.
- Same-name 20 GiB boot disk: ID `2190022566200946211`.
- 50 GiB workspace disk `pi-orb-data-a589d6ce-fa69-42c9-9a6e-07484934a05f`: ID `1480689377028812327`.

The user explicitly authorized deletion of these failed fixtures. One ordinary application API DELETE per resource returned **202**: orb at 2:14:55 PM, project at 2:14:59 PM. Bounded polling first observed orb **404** `not_found` at 2:16:08 PM and project **404** at 2:16:25 PM. Exact Compute describes confirmed the instance and both disks absent at 2:16:26–28 PM; independent final API reads again returned 404 at 2:16:31/35 PM. No direct database/Compute deletion, deployment/gate retry or product change occurred.

Before cleanup and again at 2:16:36 PM, the authoritative GCS release matched the original bytes: SHA-256 `34501cdcba5a7d062429a9cbea4d4b9ff7bc842a08176c1edb86f1c697f114c3`. Its retained-fixture history, failed lifecycle gate and **applied-but-unvalidated** outcome remain unchanged. Cleanup establishes current absence, not a cause or validation success.

Evidence: `.context/deploy-monitor-e671005/cleanup/` (`preflight.json`, ownership/API responses and HTTP metadata, exact Compute descriptions/not-found results, `release-before-proof.json`, `release-after-proof.json`, `execution.log`, `summary.json`).

## Smoke retry correction — 2026-10-16 (local, undeployed)

Shared smoke curl/fetch boundaries now retry bounded, replay-safe transient failures, preserve status/content-type-class/attempt/outcome diagnostics and reject explicit nonretryable errors. Fixed-ID creates and deletion are replay-safe; Start/Stop are never replayed after ambiguous responses. Lifecycle/identity smoke may instead confirm acceptance through a read-only state observation; a failed boot remains a failure. Federation and negative token probes use the same policy; exhausted 429s cannot count as authorization rejection. Policy and local qualification: `docs/deployment.md`, `docs/testing.md`.

This corrects the smoke failure boundary, not the origin of the recorded HTTP 500. No deployment or validation retry occurred, and the original applied-but-unvalidated record is unchanged.

## Evidence and invariant

Authoritative record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1792183306-b4162f18-2c6b-434f-b31c-c956a08da999.json`. First Actions logs, qualification snapshots, release artifact, direct trace/system logs and read-only inventory: `.context/deploy-monitor-e671005/`, especially `deploy-failed.log`, `artifacts/`, `verification/` and timestamped `progress.jsonl`.

Serving health and process-retirement proof do not replace the lifecycle gate or prove ingress routing convergence. Preserve the failed transaction independently of later fixture cleanup. Follow-up work is in `TODO.md`.
