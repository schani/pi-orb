# Boot-context cold starts failed two orb boots

**Date:** 2026-09-18  
**Status:** investigated; bounded retry implemented locally; no deployment or restart performed

## Impact

The mandatory pre-inference boot-context read failed two boots after deployment with `boot_context_unavailable: boot context is unavailable: The operation was aborted due to timeout`. The affected orbs were `16873f74-2b77-4eb6-9336-aa0a2916da51` and `ff705f88-f70b-458d-84d0-c781773b48f0`. Runtime failed health then drove the existing terminal `runtime_failed` transition and fenced compute discard.

## Evidence

Commit `90924acc2e97cdb6f82185fb01d0c43728b24155` added the mandatory read. The observed Cloud Run revisions were runtime API `pi-orb-runtime-api-00063-49b` and browser/lifecycle owner `pi-orb-00061-wwd`.

At the incident revision, `apps/orb-runtime/src/pi/boot-context.ts` gave the whole fetch, including response-body parsing, one 10,000 ms `AbortSignal` deadline and no retry. `apps/orb-runtime/src/pi/agent.ts` turned any resulting error into failed health before session attachment or inference. `apps/control-plane/src/domain/lifecycle.ts` treated returned failed health as terminal regardless of the nested retryable label. In contrast, the following project-secret boot read used 10-second attempts within a bounded 180-second recovery window.

Cloud Logging contained exactly two guest `boot_context_unavailable` records in the inspected seven-day window:

- First incident: request timestamp `2026-09-18T04:17:47.441940Z`, reported request latency `10.855910150s`, HTTP status `200`; Cloud Run logged `Starting new instance` at `04:17:47.493961Z` and startup TCP readiness at `04:17:59.104262Z`. The guest published failed health at `04:17:57.951521Z`; lifecycle transitioned orb `16873f74-2b77-4eb6-9336-aa0a2916da51` to failed at `04:18:02.772082Z`.
- Second incident: request timestamp `2026-09-18T12:52:18.495244Z`, reported request latency `10.982489075s`, HTTP status `401`; Cloud Run logged `Starting new instance` at `12:52:18.524640Z` and startup TCP readiness at `12:52:42.052584Z`. The guest published failed health at `12:52:28.436912Z`; lifecycle transitioned orb `ff705f88-f70b-458d-84d0-c781773b48f0` to failed at `12:52:33.321818Z`.

Request latency is not the startup-ready clock. In the second incident, for example, the request log reports 10.982 seconds while the separate Cloud Run start and readiness records are 23.528 seconds apart. The guest had already recorded an `AbortSignal` timeout, so the request log's 401 is not evidence that an initial fast authentication rejection caused the failure; these logs do not establish why Cloud Run ultimately recorded 401.

The runtime API configuration in `infra/run.tf` has `min_instance_count = 0` and `max_instance_count = 1`. Both incident request instances carried Cloud Run's `AUTOSCALING` new-instance record. These records establish cold-start delay for both observed failures. No evidence from these incidents supports row-lock contention, database failure, DNS failure, or malformed response as their initiating cause.

## Queries

These read-only queries produced the evidence above:

```sh
gcloud logging read \
'resource.type="gce_instance"
 AND logName:"pi-orb-boot"
 AND jsonPayload.code="boot_context_unavailable"' \
--project=playground-dev-6ae7 --freshness=7d --limit=100 \
--order=asc --format=json
```

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND textPayload:"boot_context_unavailable"' \
--project=playground-dev-6ae7 --freshness=7d --limit=100 \
--order=asc \
--format='table(timestamp,resource.labels.service_name,resource.labels.revision_name,textPayload)'
```

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND httpRequest.requestUrl:"boot-context"
 AND httpRequest.latency>="10s"' \
--project=playground-dev-6ae7 --freshness=7d --limit=100 \
--order=asc --format=json
```

The two exact instance queries distinguished request latency from process readiness:

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND labels.instanceId="00a41e8c1df960842ec41c3e574548418cd7d53ab66204b8a467b026a38e0522c17cc2341cc14aefe71df0e561d1edd6b3ff242034c748640fcefe45680bbef54d0ecc9fede856f6bc846b48d883efd8d8c208dfd80b060f48d651"
 AND timestamp>="2026-09-18T04:17:35Z"
 AND timestamp<="2026-09-18T04:18:05Z"' \
--project=playground-dev-6ae7 --limit=200 --order=asc --format=json
```

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND labels.instanceId="00a41e8c1d324503e2344ec55b04a572872448c08d714a4a1195b779a4b5175d61464faff3cc97a5ef4f7ac16085f54c232213fb2eb5db55e7d22dad692dc7a41a111c9ff4b24a0508965f44fdfa2472a1a83d66ae9fc8f7b49bf0"
 AND timestamp>="2026-09-18T12:52:05Z"
 AND timestamp<="2026-09-18T12:52:50Z"' \
--project=playground-dev-6ae7 --limit=200 --order=asc --format=json
```

Orb-specific lifecycle reconstruction used:

```sh
gcloud logging read \
'resource.type="cloud_run_revision"
 AND textPayload:"lifecycle: orb=ff705f88-f70b-458d-84d0-c781773b48f0"' \
--project=playground-dev-6ae7 --freshness=7d --limit=200 \
--order=asc \
--format='table(timestamp,resource.labels.service_name,resource.labels.revision_name,textPayload)'
```

## Resolution and remaining work

The boot-context prerequisite remains fail-closed: no session attachment, readiness, or inference proceeds without a successful typed answer. The local fix keeps the 10-second deadline on every request and retries only typed retryable failures within the existing 180-second boot recovery window used by project-secret loading. Delays are exponential and capped: 1, 2, 4, 4… seconds. No attempt starts at or after the retry deadline; an attempt admitted just before it retains its full 10-second timeout, so maximum completion is the retry window plus one request timeout. Authorization and malformed JSON/schema responses remain terminal; exhaustion returns the last typed failure. Injected clock and sleep boundaries deterministically cover service, timeout, and network recovery; permanent failure; exact and overshot exhaustion; and the unchanged per-request timeout. No timeout increase, minimum-instance change, deployment, or restart was performed.

Durable retry diagnostics remain tracked in `TODO.md`. Current diagnosis requires joining a generic request URL, Cloud Run instance records, guest failed health, and lifecycle edges by time; request logs contain no orb identity and guest boot records retain the code but not the detailed timeout.
