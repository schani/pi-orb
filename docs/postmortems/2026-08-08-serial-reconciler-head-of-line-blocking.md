# 2026-08-08 — serial archival reconciliation delays a new orb by six minutes

Status: root-caused and fixed; orb recovered without intervention.

**Field finding: the single reconciler snapshots every active orb and awaits each orb's complete pass serially. A wave of archival work occupied that sweep with history sealing and destructive provider cleanup, so a newly created orb was not even observed for 5m52s. The UI showed `creating`, but there was no VM, Tailscale device, `stateDetail`, or error because creation had not started.**

Affected orb: `a75e103d-af9d-47fd-804d-f5bf7fa14209`. All times UTC on 2026-08-08.

## Timeline and evidence

- 21:02:33–21:08:31 — the reconciler processed a backlog of unrelated `archiving` orbs. Lifecycle events show serial history seals, host starts, roughly minute-spaced host destroys, and archive finalizations.
- 21:02:51.442 — HTTP created the affected orb in durable state `creating`.
- Until 21:08:43 — the orb row remained at `state_version=0` and its original `updated_at`; exact-match GCE instance/disk and Tailscale device queries returned no resources; exact-match lifecycle logs contained only `created`.
- 21:08:43.881 — after the archive sweep drained, the next reconcile opportunity provisioned the GCE host. The row advanced to `state_version=1`.
- 21:09:32 — guest attributes reported `startup=container-started` and `container=status=running restartCount=0`.
- 21:09:45.703 — normal readiness completed and the orb transitioned `creating -> running` at checkout `1a3d8b4`.

## Root cause

`reconcileAllOnce` calls `listOrbsInStates` once, then iterates that snapshot with `for ... of` and `await reconcileOrbOnce(...)`. A new row created after the snapshot cannot be considered until the entire sweep finishes. Archival makes this visible because one pass may wait on runtime restoration/history sealing or minute-scale Tailscale/GCE cleanup. Several such orbs in one snapshot add their latency together.

This is cross-orb head-of-line blocking, not a GCE, Tailscale, authentication, or runtime boot failure. The affected orb's actual provision and boot were healthy once scheduled.

The persisted 15-minute create/start deadline begins at row creation, so the queue delay consumed the same deadline intended to bound the orb's own provider and boot work. A larger archive backlog could therefore have failed a never-attempted create as `deadline_exceeded`.

## Why the UI had no explanation

Creating `stateDetail` is synthesized from process-local boot probes. No reconcile visit means no probe exists, so the API can only return bare `state: creating`. Existing edge-only lifecycle logs reconstruct the cause for operators, but there was no durable or user-visible queue status. The scheduler fix removes the fleet-wide queue rather than adding a normal queue state.

## Remedy applied

`ReconcileDispatcher` now rescans due rows every tick while previously dispatched work remains in flight. It launches each orb reconciliation on an independent task and holds a process-local map from orb ID to completion promise, which prevents duplicate local work and provides a shutdown drain. Cross-orb concurrency is intentionally unlimited for the current POC scale. The one fleet-global Codex→GitHub login ceremony is separately protected by a simulation-safe singleflight so concurrent create/start workers share both pending and failed-flow resolutions instead of racing device-flow creation or replacement; brief overlap between Cloud Run revisions remains safe through the existing database CAS and idempotent provider contracts. Unexpected worker rejection is captured and surfaced as a fatal loop failure.

`determined` permits only one sequential coroutine per `SimulationTask`, so production creates a fresh `ControlPlaneTask` for every dispatched orb while DST injects statically declared worker tasks through the same runner boundary. `reconcile-concurrency.dst.test.ts` blocks several orb operations, performs another scheduler scan, proves a newly inserted orb dispatches before those operations are released, proves repeated scans never overlap work for one orb, runs two real create lifecycles concurrently through one shared auth flow, covers retry timing, verifies abort-during-list and shutdown draining, and verifies fatal worker rejection is not detached.
