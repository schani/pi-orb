# Lifecycle restart poll received HTTP 500

## Failure — 2026-10-16, PDT

[Deploy 38961777202](https://github.com/schani/pi-orb/actions/runs/38961777202) selected `e6710059313ceb8b90ad363acc61ca62297717ec`. Exact-source CI, four Docker E2E shards and Durable passed on attempt 1. Release `r-1792183306-b4162f18-2c6b-434f-b31c-c956a08da999` reached activation, then failed lifecycle; identity and rollout monitor were skipped. Outcome at 2:04:26 PM: **applied-but-unvalidated**. No gate retry or bypass occurred.

First boot reached running at 2:03:02 PM, first stop reached stopped at 2:03:31 PM, and restart reported starting at 2:03:34 PM. At 2:04:19 PM, jq reported `Invalid numeric literal at line 3, column 0`; smoke failed with `restart: no orb state`.

Cloud Logging records HTTP **500** at `2026-10-16T21:04:19.004801Z` for GET `/api/v1/orbs/a589d6ce-fa69-42c9-9a6e-07484934a05f`, user agent `curl/8.5.0`, latency `0s`, attributed to **old revision `pi-orb-issuer-00060-kfk`**. Trace `projects/playground-dev-6ae7/traces/d81fb43135035a2626663e45038dda9c` contains only that request row; no application exception or response body was retained. An unrelated browser GET received another old-revision 500 ten seconds earlier.

The old revision logged shutdown at 1:57:49 PM; deletion completed at 1:58:04 PM. Retirement recorded active/idle zeroes at 2:00 PM; activation completed at 2:01:39 PM. **Cause unknown; stale routing is not proven.** The API helper passed an unchecked response body to jq, explaining the assertion path, not the HTTP 500.

Independent reads at approximately 2:05–2:07 PM found new issuer `00061-m4d` Ready at 100%, health `ok`, expected image digest `sha256:598a2cecfc41f2b3e2cc0c247a250c3bf333906d2b8dd2047c0e6dbeaf6e4686` and generation `1792184072`. Lock, migration job and native builders were absent. The retained smoke orb was running with `lastError:null`. These reads do not clear the failed gate.

## Authorized cleanup — 2026-10-16, PDT

Fresh reads verified owner `53da7ad4-6c53-4223-868e-0641bb4bcdd9`, project `e37f5fdb-06b2-4b70-8e93-fd401f48463d`, its expected smoke name/repository, and exactly one child: orb `a589d6ce-fa69-42c9-9a6e-07484934a05f`. Compute labels, incarnation and attachments matched these exact resources in `playground-dev-6ae7/us-central1-a`:

- Instance `pi-orb-a589d6ce-fa69-42c9-9a6e-07484934a05f-i0`, ID `210690005985603107`.
- Same-name 20 GiB boot disk, ID `2190022566200946211`.
- 50 GiB disk `pi-orb-data-a589d6ce-fa69-42c9-9a6e-07484934a05f`, ID `1480689377028812327`.

The user authorized deleting these fixtures. One application API DELETE each returned **202**: orb at 2:14:55 PM, project at 2:14:59 PM. Polling observed **404** at 2:16:08 PM and 2:16:25 PM respectively. Exact Compute describes confirmed the instance/disks absent at 2:16:26–28 PM; independent API reads again returned 404 at 2:16:31/35 PM. No direct database/Compute deletion occurred.

At 2:16:36 PM the authoritative release still matched its original bytes, SHA-256 `34501cdcba5a7d062429a9cbea4d4b9ff7bc842a08176c1edb86f1c697f114c3`. Cleanup establishes absence, not validation success.

## Evidence and invariant

Authoritative record: `gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1792183306-b4162f18-2c6b-434f-b31c-c956a08da999.json`. Actions artifact `release-38961777202-1` contains equal JSON. First logs, trace/system rows, qualification and inventory: `.context/deploy-monitor-e671005/`. Cleanup ownership, HTTP metadata, Compute absence and unchanged-record proofs: its `cleanup/` directory.

Serving health and process-retirement proof do not replace lifecycle smoke or prove ingress convergence. Preserve the failed transaction independently of cleanup. Retry policy: `docs/deployment.md`. Diagnosis: `TODO.md`.
