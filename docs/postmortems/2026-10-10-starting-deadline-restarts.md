# Restarting control plane renewed the create/start deadline hold — 2026-10-10

Orb `e8836220-358d-4480-84aa-ae07068a7864` (GCE Spot VM) stayed `starting` from 00:02:20Z to 06:19:36Z, 6h17m past a 15-minute `createStartDeadlineMs`.

## Timeline (UTC)

- 00:02:07 GCE preempted the VM; 00:02:20 `running` → `starting` (`host_observed_stopped`); 00:02:30 `host-start outcome=ok`.
- The runtime never answered. Discard evidence at 06:19:59: `boot-status: bootstrap failed: bootstrap_exit_code execMainStatus=1`. Guest cause: `docs/postmortems/2026-10-10-bootstrap-metadata-network-race.md`.
- `pi-orb-issuer` OOM-restarted 85 times between 23:53 and 06:24 (`docs/postmortems/2026-10-09-central-durable-oom-recovery.md`). Until 06:03:52 no process lived longer than 10m17s.
- The 06:03:52 replacement process lived 20.5 minutes and failed the orb at 06:19:36: `deadline_exceeded … 120 probes; runtime never answered; last probe error: fetch failed (ECONNREFUSED)`.
- The reconciler logged nothing for the orb between 00:02:30 and 06:19:36.

## Defect

The deadline is measured from the durable `state_changed_at`, but it fires only when neither in-memory hold applies. `awaitingBootEvidence` holds it until the runtime has answered *this process*, bounded by `unreachableBootDeadlineMs` (12 minutes on GCE) from the process's first pass. `holdingForSetupHook` is anchored likewise. Both are process memory, so every restart renewed them; with restarts faster than 12 minutes the deadline could never fire.

## Correction and invariant

Both holds end once the episode is `createStartDeadlineMs + setupHookHoldMs` old by `state_changed_at` (37 minutes in production); no legitimate setup hold extends a boot past that. DST scenario "a never-answering boot fails although the control plane keeps restarting" (`apps/control-plane/src/domain/lifecycle.dst.test.ts`) restarts the control plane every 100 simulated seconds; before the fix the orb was still `starting` 870 s after a 300 s deadline. Three tests that seeded `creating`/`starting` orbs with `stateChangedAt: 0` relied on the unbounded hold and now seed a current timestamp.

## Evidence

Read-only queries against project `playground-dev-6ae7`:

```
gcloud logging read 'textPayload:"lifecycle: orb=e8836220" AND timestamp>="2026-10-09T23:50:00Z" AND timestamp<"2026-10-10T06:30:00Z"' --project=playground-dev-6ae7 --order=asc --format='value(timestamp,textPayload)'
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="pi-orb-issuer" AND textPayload:"Memory limit" AND timestamp>="2026-10-09T23:50:00Z" AND timestamp<="2026-10-10T06:30:00Z"' --project=playground-dev-6ae7 --order=asc --format='value(timestamp,resource.labels.revision_name,labels.instanceId)'
gcloud compute operations list --project=playground-dev-6ae7 --filter='targetLink~pi-orb-e8836220'
```
