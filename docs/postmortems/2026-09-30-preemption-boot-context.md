# Preemption followed by boot-context failure

Investigated 2026-09-30. Orb `56e257bf-2145-4451-a43f-7d83c0a30d8a` (Check Native MCP Support in the API).

## Evidence

All times UTC, 2026-09-30:

- **13:39:43.568:** GCE audit event `compute.instances.preempted`, principal `system@google.com`, message `Instance was preempted.` Instance `pi-orb-56e257bf-2145-4451-a43f-7d83c0a30d8a-i0`, numeric ID `862313815538251522`.
- **13:40:04.377:** lifecycle `running → starting`, reason `host_observed_stopped`.
- **13:40:23.338:** lifecycle `host-start`, outcome `ok`; GCE audit confirms the start completed.
- **13:45:17.472:** lifecycle `starting → failed`, code `runtime_failed`, error `boot_context_unavailable: boot context is unavailable: fetch failed`.
- **13:45:39.102:** lifecycle `compute-discard`, outcome `ok`. Boot evidence retained about 15 GB boot and 39 GB workspace free; this was not disk exhaustion.

Inspection found retained disk `pi-orb-data-56e257bf-2145-4451-a43f-7d83c0a30d8a` READY and unattached. Replicated conversation remained readable with `pi-orb transcript`.

## Diagnosis and limits

Google preemption interrupted the running orb. Its automatic restart failed the mandatory control-plane boot-context read; failed health then triggered terminal failure and compute disposal. The workspace was retained.

The surviving error is only `fetch failed`. Queries for this instance's guest logs and boot-context/error logs in 13:40–13:46 did not identify the underlying DNS, connection, or TLS failure. No boot-context request log appeared in that query window; absence is not proof that no request reached the service. Current source retries network failures within a 180-second window, but these records do not prove the failed guest's attempt count or deployed implementation. Do not attribute this incident to the cold-start timeout diagnosed in `docs/postmortems/2026-09-18-boot-context-cold-start.md` without further evidence.

## Outcome

No restart, deployment, or resource mutation was performed during diagnosis. Explicit Start can provision replacement compute against the retained workspace; successful recovery has not been tested. Boot-context diagnostic work remains in the existing `TODO.md` item.

## Reproduction queries

```sh
gcloud logging read \
  'textPayload:"lifecycle: orb=56e257bf-2145-4451-a43f-7d83c0a30d8a" AND timestamp>="2026-09-30T13:39:00Z" AND timestamp<="2026-09-30T13:46:00Z"' \
  --project=playground-dev-6ae7 --order=asc --limit=100 --format=json

gcloud logging read \
  'resource.type="gce_instance" AND resource.labels.instance_id="862313815538251522" AND timestamp>="2026-09-30T13:39:00Z" AND timestamp<="2026-09-30T13:46:00Z"' \
  --project=playground-dev-6ae7 --order=asc --limit=400 --format=json
```
