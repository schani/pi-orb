# 2026-08-12 — Spot preemption during first image pull leaves a crash-looping image

Status: best-supported diagnosis established from lifecycle events, GCE system-event audit logs, startup-script logs, COS container logs, the published image manifest, and a healthy local run of the same digest. Direct inspection of the stopped host's extracted layer and an eviction/re-pull recovery were not performed. Recovery automation remains in `TODO.md`.

## Impact

Orb `6ceb79c1-cfc9-4a85-93ef-7e46b8dbe285` never reached runtime readiness. Its container crash-looped eleven times; the control plane made 36 readiness probes, the last of which reached the host but found nothing listening on port 8080 (`ECONNREFUSED`). The orb entered `failed` after 186 seconds with `runtime_never_answered`, and the control plane stopped the VM. No runtime history was created or replicated.

The `pi update --extensions` output reported alongside the incident was not causal. The failing process never executed Node or Pi: COS logged `exec /usr/local/bin/docker-entrypoint.sh: exec format error` at container entry, and this newly created orb had no history or prior runtime boot in which an extension update could have run.

## Timeline (UTC)

- 02:26:26 — the orb row is created.
- 02:26:28–02:26:36 — the Spot GCE host and fresh data disk are inserted.
- 02:26:59 — the first startup script formats and mounts the data disk, configures Artifact Registry credentials, and begins pulling runtime digest `sha256:bb215abd…`.
- 02:27:03–02:27:07 — the first five image layers report download/pull completion.
- 02:27:18 — GCE records `compute.instances.preempted`: the VM is hard-stopped while the first image pull/extraction is still in progress.
- 02:27:32–02:27:40 — lifecycle recovery starts the same VM and therefore reuses its COS boot disk and Docker cache.
- 02:28:06–02:28:07 — the second pull reports the first five layers as `Already exists`; the remaining layers are fetched.
- 02:28:35 — Docker reports the exact digest downloaded successfully.
- 02:28:52 — the startup script creates the container and reports `container-started`. The container immediately begins crash-looping with `exec /usr/local/bin/docker-entrypoint.sh: exec format error`.
- 02:30:36 — the eleventh failed container start is logged; the reporter records exit code 255.
- 02:30:47 — after 36 probes over 186 seconds, the last failing with `ECONNREFUSED`, the reconciler logs `boot-failed`.
- 02:31:04 — the control plane stops the host and transitions the orb from `creating` to `failed`.

## Best-supported diagnosis

A Spot preemption interrupted the first runtime-image pull on the disposable COS boot disk. On the second boot, dockerd trusted five layers left in its cache as complete instead of re-fetching them. The resulting image could be created but its configured entrypoint could not be executed. Together with the healthy published artifact, this strongly supports corrupted extracted cache state, although the stopped host's extracted entrypoint was not inspected directly.

The evidence rules out a wrong-architecture or bad published image:

- the registry manifest declares `linux/amd64`;
- the same digest runs locally as `linux/amd64`, where `/usr/local/bin/docker-entrypoint.sh` is a valid 388-byte `#!/bin/sh` script and Node reports v24.19.0;
- the registry's 448-byte compressed layer `sha256:9899b563…` contains exactly that 388-byte entrypoint script;
- that layer was among the five completed before preemption and reported `Already exists` after restart;
- every host-side container attempt failed before Node with the same entrypoint `exec format error`.

This matches the independently predicted path from `docs/postmortems/2026-08-06-rollover-repair-war-corrupt-image.md`: that incident established that a hard stop during pull/extraction can leave truncated files in layers dockerd considers complete and explicitly noted that Spot preemption during a first pull could reproduce it. The 2026-08-12 evidence has the same shape without a deploy rollover or competing reconcilers.

## What worked and what remains

The observability added after the earlier incident made this failure root-causable without starting or SSHing into the failed host: GCE system-event logs identified the preemption, startup logs exposed layer reuse, COS container logs preserved the exact pre-Node error, guest attributes exposed the crash loop, and lifecycle logs recorded the terminal decision. The `ECONNREFUSED` classification correctly localized the failure inside the container rather than to routing.

The retryable/non-destructive image replacement implemented after `docs/postmortems/2026-08-11-release-smoke-restart-registry-timeout.md` does not by itself repair this class. A normal `docker pull` still accepts the corrupted layers as already present. Recovery must remove/re-fetch the suspect image or replace the disposable VM boot disk after crash-loop evidence, while preserving the separate `/workspace` data disk. That work is specified in `docs/compute-replacement.md` and tracked in `TODO.md` under **Implement immutable compute replacement**.
