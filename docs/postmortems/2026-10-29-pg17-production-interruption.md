# PostgreSQL upgrade interrupted production

Read-only investigation on 2026-10-29 after the user reported “rate exceeded”
during [Deploy 40928556779](https://github.com/schani/pi-orb/actions/runs/40928556779).
The original incident chronology uses UTC (subtract seven hours for PDT);
the corrective-deployment follow-up is labeled PDT.

## Observed sequence

- At 18:56:15.768, Cloud Audit Logs record `cloudsql.instances.update` for
  `pi-orb`, requesting `databaseVersion: POSTGRES_17`. The principal is
  `pi-orb-amp-deployer`; delegation identifies the GitHub main-branch workload
  identity, not this diagnostic Amp orb. Operation:
  `c6eb1026-15f3-4d1e-895a-efb200000032`.
- At 19:03:27.063, PostgreSQL received a fast shutdown request and terminated
  application connections. The serving control plane logged storage failures
  and `the database system is shutting down`.
- At 19:03:27.530, Node exited with an unhandled `error` event on a `pg` Client:
  `Error: read ECONNRESET`. Cloud Run started a replacement instance at
  19:03:27.684. The first queried ingress 429 since 18:00 is at 19:03:27.674;
  Cloud Run's payload is `The request was aborted because there was no available
  instance.` These are not model-provider rate limits.
- The replacement passed its TCP startup probe at 19:06:09.796, then logged
  `connect ECONNREFUSED` to PostgreSQL. API and JWKS requests returned 503.
- PostgreSQL 17.11 started during the upgrade; another fast shutdown occurred
  at 19:08:42.577. It was ready for connections again at 19:08:49.361.
- At 19:09:52–19:09:54, the five latest queried `/api/v1/projects` requests
  returned 200 in approximately 3–11 ms. An independent public JWKS read
  returned 200 in 80 ms. These establish sampled recovery, not completed release
  qualification.

## Attribution and limits

The deployment's database upgrade interrupted the old application before any
new application cutover. The unchanged serving revision is
`pi-orb-issuer-00076-26g`, created October 26, with 100% traffic, min=max=1,
2 vCPU and 4 GiB. Database disconnection caused an unhandled driver error;
the resulting sole-instance outage explains the ingress refusals.

At the final operation read around 19:10, the SQL update remained `RUNNING`
and the instance reported `MAINTENANCE` / `POSTGRES_17`. GitHub's release
transaction remained in progress. No completed-upgrade, successful-release,
continuous-recovery or crash-fix claim is made. No production mutation,
restart, workflow cancellation or retry was performed by this investigation.

## Follow-up: HTTP recovery did not restore every agent

At 19:12–19:14 the user reported messages stuck in `delivering`. The ordinary
project-orb API identifies screenshot orb “Keep Archive Folder Closed After
Archiving” as `bad3e051-da6a-4dad-a322-5acadff10923`. Its lifecycle evidence:

- It reopened at 19:08:24.646, before the second database restart.
- At 19:08:43.351–19:08:43.353 it lost ownership with `cause_code=unavailable`,
  failed drain and release, and logged `harness.resources_close_failed` with
  `failed_stage=drain`.
- At 19:08:49.964 it reported `central-agent-unavailable` with
  `Agent drain ownership unavailable`, after PostgreSQL accepted connections.
- Message `59df4f88-1bfd-47fb-8419-d78be327683a` queued at 19:11:55.399;
  delivery reported the same blockage at 19:11:56.315.
- A read-only inbox poll at approximately 19:14 returned that exact message
  as `delivering`, with no operation ID. It is persisted but has not been
  assigned an agent operation; refreshing the page cannot repair that state.

Source at serving commit `c812b034f0ba6ba75292737205658850bf8e0310` confirms
`DurableAgent.close()` caches `closeResult`, including the failed `beginDrain`
result. `OrbAgentManager.ensure()` refuses to replace an inactive agent until
its close succeeds. Consequently this instance keeps returning its cached drain
failure rather than reacquiring the agent. The same lifecycle blockage appeared
for orb `34a3caf5-08ba-452e-9720-3069dc840036`; it is not a fleet-wide delivery
failure (another orb dispatched at 19:12:40).

At 19:14 the old application revision still served 100%, and the database
upgrade and GitHub deployment remained in progress. A fresh application process
would discard this in-memory cached result, but safe eventual message delivery
has not been demonstrated. No resend, cancellation, restart or product fix was
performed. HTTP recovery is not evidence of agent/inbox recovery.

## Monitoring sample at 19:24 UTC

The SQL operation completed at 19:14:07.888 without a reported error; the
instance now reports `RUNNABLE` / `POSTGRES_17`. New revision
`pi-orb-issuer-00077-v6l` is Ready and receives 100% of traffic, but its logs
still show the release activation wait at 19:24:43. The previous revision
emitted a background cleanup log at 19:23:17. Traffic cutover therefore does
not prove old-process retirement or new-agent activation. GitHub's authoritative
release transaction remains in progress.

The exact tracked inbox message remains `delivering` with no operation ID.
The bounded query since 19:19 returned no ingress 429, HTTP 5xx or ERROR logs;
this does not establish agent recovery. Monitoring remains read-only.

## Monitoring sample at 19:29 UTC

The database remains runnable and the same new revision serves 100%, but
activation is still waiting at 19:29:38 and the old revision continues polling
at 19:29:44. The exact message still reports `delivering` with no operation ID;
the bounded error query since 19:24 is empty. GitHub release remains in progress.
The old reconciler transitioned the screenshot orb from running to stopping at
19:29:31 with `reason=idle_for_901s`, followed by `drain-caught-up` at 19:29:32.
This is not message-delivery evidence; no operator stop was requested here.

## Monitoring and retirement diagnosis at 19:34–19:36 UTC

The screenshot orb finished its automatic idle stop at 19:29:50; at 19:34 its
API reports stopped/idle while the tracked message remains `delivering` without
an operation ID. The bounded error query since 19:29 is empty.

The authoritative GCS release record
`static-plane/releases/r-1793298872-f7f0988e-06a2-4d7a-b074-ee6ae72a1d8f.json`
reports `applied-but-unvalidated`, with preflight/checks/build/plan/schema/apply/
repair passed and `retire` running. Old revision resource deletion is complete,
but `retirement.zeroes` is empty. Independent Monitoring samples through 19:35
show one active old-revision instance and zero idle instances. This is actual
continued process activity, not merely delayed zero-count ingestion. The release
code permits up to 75 minutes for retirement before failing with activation gated.

Cloud Run logged `Shutting down user disabled instance` at 19:16:38.512;
the same instance ID continued emitting memory samples afterward, and background
polling continued through 19:34. No application `shutting down` log was found
in the bounded old-revision query. The configured request timeout is 3,600 seconds.
Google's container contract gives in-flight requests time to finish before normal
shutdown; its WebSocket contract treats open sockets as active requests attached
to the same instance until close/timeout. Long-lived sockets are consequently a
plausible explanation for this drain, not an identified specific active connection.
The documented ten-second SIGTERM-to-SIGKILL interval is distinct from this
pre-termination request drain. No force-stop or rollout bypass was performed.

Sources: https://docs.cloud.google.com/run/docs/container-contract and
https://docs.cloud.google.com/run/docs/triggering/websockets.

## Final monitoring sample at 19:49 UTC

The requested 30-minute read-only window ended with a sample beginning at
19:49:35. The SQL operation remains successfully DONE. Revision
`pi-orb-issuer-00077-v6l` serves 100%, but its activation wait continued at
19:49:31, and the old revision still polled at 19:49:36. The authoritative
release record remains `applied-but-unvalidated` in `retire`, with old resource
deletion complete, no recorded zero-instance proof, and no pending Compute
operations. GitHub's authoritative release step remains in progress.

The exact screenshot message remains `delivering`, updated at 19:11:56, with
no operation ID or delivery receipt. The bounded query since 19:44 returns no
ingress 429/5xx or ERROR entries; this is not agent recovery. No production
mutation or message replay was performed. Scheduled monitoring ended and was
cleared, not extended.

The user also approved a simple PR for cooperative retirement via the
existing activation object. The decision and unchanged independent retirement
proof are recorded in `docs/deployment.md`. That approval did not authorize
deployment or claim to fix the separate database-client crash / cached agent-drain
failure; later deployment approval is recorded below.

## Renewed monitoring at 20:22–20:29 UTC

The user requested continued monitoring. The old revision's active and idle
counts both have explicit zeroes at 20:12:00; activation was published at
20:12:45 for generation `1793299990`. New-revision polling is observed at
20:22:06, the database remains runnable, and authenticated health returns 200.
The bounded error query since 20:18 returns no ingress 429/5xx or ERROR entries.

The release record finishes `validated` at 20:23:47, with all twelve gates passed
and all four smoke fixtures recorded deleted. GitHub subsequently enters its
separate fifteen-minute independent rollout observation; this is not yet a
completed-workflow claim.

The screenshot orb now returns resource-specific API 404 and is absent from
its project's orb list. Its lifecycle records `deleted outcome=all_resources_removed`
at 20:16:42.239854. Deletion does not establish delivery of the original message;
no completed receipt was demonstrated. This monitoring performed no production
mutation, replay or deletion. Periodic read-only monitoring resumes until the
workflow's terminal outcome.

## Final workflow outcome: post-rollout monitor failed

The separate observation ends at 20:42:45 with `outcome=regression`; GitHub
marks Deploy failed. The release transaction remains `validated`, not rolled
back. All fourteen samples report health `ok`, the intended serving generation
and SQL `RUNNABLE`, and no ingress 429. The monitor's cumulative log window
contains one ERROR / HTTP 503 event, not fourteen separate failures.

That request began at 20:30:30.931765 on revision `00077-v6l`: POST to the
conversation-headline route for orb `1ccfa9fe-52cd-4ad8-ab3f-289b4b965864`,
latency 1.554454158 seconds, trace `145b7c3c947bc29ce99c3b40f5067aba`.
Nearby lifecycle evidence records `delete_requested` at 20:30:32.482494 and
`stale_owner` at 20:30:32.490548; this timing does not prove the 503's cause.
The monitor does not establish central inference or original-message delivery.
No failed gate was waived, rerun, or treated as healthy release qualification.

Retained evidence: [rollout-monitor artifact](https://github.com/schani/pi-orb/actions/runs/40928556779/artifacts/12930269149),
`/tmp/pi-orb-prod-diag/rollout-final/rollout-monitor.json`,
`rollout-observed-errors.json`, `headline-503-context.json`, and
`deploy-final-failure.log` in that same private diagnostic directory. Monitoring
stops at this terminal workflow outcome; no production mutation was performed.

## Evidence

Authoritative evidence is Cloud SQL operation metadata, Cloud Audit Logs,
Cloud SQL PostgreSQL logs and Cloud Run request/container/system logs for the
timestamps above. Query `resource.type="cloud_run_revision"` with service
`pi-orb-issuer`; query `resource.type="cloudsql_database"` with database ID
`playground-dev-6ae7:pi-orb`. The audit request contains only the database
version change. The failed process reports Node v24.22.1 and
`/app/node_modules/pg/lib/client.js:422` as the Client error emission site;
the owning first-party client was not identified in this investigation.

## Corrective deployment and first handover (October 29, 2026, PDT)

The user later explicitly approved inclusion of PR 228 in combined corrective
[Deploy 40986634860](https://github.com/schani/pi-orb/actions/runs/40986634860)
and authorized deployment. Dispatch at 18:34:20 respected the 15:35 not-before.
The existing activation object now retains cutoff `1793324911` with successor
generation `1793324912`. The predecessor `00077-v6l` lacked the watcher, so this
first deployment could not accelerate its retirement. Independent active and
idle zeroes were both recorded at **18:59:00** (October 30, 01:59:00Z), before
activation at **19:00:00**. No early activation or relaxed retirement proof was
used; this does not measure future cooperative-retirement latency.

The observer Spot VM was preempted at **18:38:50.934**; parent-retained audit,
operation and boot evidence confirms preemption. Automatic recovery was verified
by a successful current-date command at **18:41:52**. GitHub Actions continued
independently and was unaffected. Private evidence remains under
`$HOME/deploy-monitor-backup/`.
A second short guest-tool interruption recovered at **19:11**; attribution is
unknown and no crash is claimed.

All 12 corrective release gates passed at 19:11:07; independent full rollout
observation ended **observed** for 19:11:11–19:30:02, with workflow **success** on
attempt 1. Read-only diagnostics classify the still-visible parent setup-hook
warning as experimental lab APT prerequisites, absent from selected production
source; why prerequisites were unavailable remains unknown, with no fix claimed.
Release, cleanup and classification evidence:
`docs/postmortems/2026-10-29-pg17-production.md`.
No fix for the historical PostgreSQL Client crash or cached agent-drain failure,
original-message delivery, or clearance of the original failed monitor is claimed.
