# Native bootstrap lost a boot-time network race — 2026-10-10

After a Spot preemption, orb `e8836220-358d-4480-84aa-ae07068a7864` (GCE instance `2184400015922084113`) restarted, `pi-orb-bootstrap.service` failed its single metadata request, and the runtime never started. The orb stayed `starting` for 6h17m; the deadline half is `docs/postmortems/2026-10-10-starting-deadline-restarts.md`.

## Timeline (UTC)

- 00:02:07 GCE preempted the VM; 00:02:30 control-plane `host-start outcome=ok`.
- 00:02:56.716 guest agent manager: `Initializing Google Guest Agent...`.
- 00:02:57.276 `GuestAgentCorePlugin` started (`vm_extension_policies`).
- 00:02:57.533 `pi-orb-boot` bootstrap `starting` edge.
- 00:02:57 journal: `pi-orb-bootstrap[749]: <urlopen error [Errno 101] Network is unreachable>`, `status=1/FAILURE`; `pi-orb-runtime.service`: `Dependency failed`.
- 00:02:58.145 failed edge `bootstrap_exit_code` reached Cloud Logging, so the network was back within about 0.6 s.
- 00:02:59 core plugin logs (flushed): `Rolling back changes for systemd-networkd with reload [true]`, `Setting up netplan interfaces`.
- 06:19:36 control plane failed the orb `deadline_exceeded`; 06:19:59 discard diagnosis first read the boot status.

## Defect

`infra/native-vm/bootstrap.py` made one `urlopen` to the metadata server; any `OSError` exited 1. The unit has no `Restart=` and the runtime `Requires=` it, so a sub-second outage failed the boot permanently.

## Evidence

- All six boots of the instance log the core plugin's network rollback/netplan setup at agent start. Boots 1–5 finished bootstrap before the core plugin started; boot 6 started bootstrap 0.26 s after it.
- 30 days: 1,517 bootstrap starts, 2 `ENETUNREACH` failures, both about 1 s after guest-agent manager init (0.82 s here; 1.13 s for instance `3734170545848514851`, orb `f8ec0335`, 2026-10-02T04:23:36Z, identical journal). The other three bootstrap failures (2026-09-30, validator probe VMs) were `HTTP Error 404: Not Found`.
- The mechanism (guest-agent network reload briefly removing the route) is strongly indicated, not proven: no kernel or `systemd-networkd` logs exist. Serial console logging is not configured, and only the failed unit's journal tail is exported.

Read-only queries, project `playground-dev-6ae7`:

```
gcloud logging read 'resource.type="gce_instance" AND resource.labels.instance_id="2184400015922084113"' --freshness=3d --format=json
gcloud logging read 'logName="projects/playground-dev-6ae7/logs/pi-orb-boot" AND jsonPayload.phase="bootstrap" AND NOT jsonPayload.kind="journal"' --freshness=30d --format=json
gcloud logging read 'resource.type="gce_instance" AND (jsonPayload.message="Initializing Google Guest Agent..." OR jsonPayload.message:"Rolling back changes for systemd-networkd" OR jsonPayload.eventMessage="Extension Health: Successfully started the plugin.")' --freshness=30d --format=json
gcloud logging read 'logName="projects/playground-dev-6ae7/logs/pi-orb-boot" AND jsonPayload.status="failed"' --freshness=30d --format=json
gcloud logging read 'resource.type="gce_instance" AND resource.labels.instance_id="3734170545848514851" AND timestamp>="2026-10-02T04:15:00Z" AND timestamp<="2026-10-02T04:30:00Z"' --format=json
gcloud logging read 'protoPayload.methodName="compute.instances.preempted"' --freshness=7d
gcloud compute project-info describe   # no serial-port-logging-enable
```

Bootstrap starts were joined to agent edges by instance ID and nearest timestamp.

## Correction and invariant

Boot-path metadata reads retry transient failures (`OSError`, including `URLError` and timeouts, and HTTP 5xx) with 0.5–8 s backoff within a 60 s budget; HTTP 4xx, such as a missing `pi-orb-config`, fails immediately. Each retry writes `metadata_retry N: <error>` to the journal, which the unit-failure record exports; a recovered boot publishes one `bootstrap starting metadata_retried` edge with `metadataRetries`, so the race frequency is queryable. Tests in `infra/native-vm/test_guest.py` use an injected clock and sleep.

Invariant: one transient network failure during guest boot must not fail the boot.

## Secondary gaps

- The failed boot status was published at 00:02:58 but read only at 06:19:59, during discard diagnosis.
- `infra/native-vm/boot_diagnostic.py` labels a runtime dependency failure `runtime_success` (systemd reports `Result=success` for a unit that never ran).

Both are tracked in `TODO.md`.
