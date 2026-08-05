# TODO

Actionable work items: bugs, hardening, and agreed follow-ups (see `AGENTS.md`):

- An item lives in exactly one place — here or in `docs/open-questions.md` (undecided design questions), never both.
- This file is the only backlog: no TODO/FIXME comments in code, no TODOs buried in design prose. Design docs link here.
- When an item is done, delete it here and record the outcome in the relevant design doc.

## Bugs

- **Unreachable-restart livelock** (2026-08-05, was open question 36; forensics: `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`). The inline stop+start recovery grants only `unreachableGraceMs` (30 s) for the runtime to return, but a real GCE VM needs ~60–70 s to boot to a serving container, so the path can never observe success and hard-stops a booting VM every ~60 s indefinitely (`running` has no deadline). Candidate fix: after the inline restart, CAS the orb back to `starting` so the patient readiness path (5 s health polls, create/start deadline) drives recovery, plus a cap on consecutive inline restarts as defense in depth. Required regardless of fix shape: model host boot latency in `FakeWorld` as a schedule-controlled delay (instant boots are why DST missed this) with a preemption-during-`running` scenario, and add app-level reconciler logging (transitions, restarts, drain outcomes) — the incident was invisible without disk forensics. Orb 104600b7 remains `failed` pending this fix (a plain restart would work but would re-livelock on the next mid-`running` preemption).
- **E2E cannot pass on macOS Docker Desktop** (2026-08-04, was open question 34). The Docker provider hands the control plane the container's bridge IP, which is unreachable from the host on Docker Desktop (verified empirically — connections hang, readiness always times out). Candidate fixes: publish the runtime port to a host loopback port and use it in the observation when the control plane is host-run, or run the E2E control plane inside the Docker network. Until then the E2E only passes where container IPs are host-routable (Linux, OrbStack).

## Hardening

- **Close the served-vs-durable persistence gap** (was open question 33; incident: `docs/postmortems/2026-08-03-cursor-not-found.md`). The runtime answers history pulls from in-memory session entries while the SDK persists with `appendFileSync` and no fsync, and the SDK loader silently drops a truncated tail line on reload. A hard host stop can therefore lose a record the control plane already replicated and committed as its cursor, stranding the orb in a `cursor_not_found` integrity failure. Candidate fixes: serve only durably-persisted entries (fsync barrier or persisted-watermark cursor), fsync at drain time, and/or make the loader surface a truncated tail as a load error instead of silence.
- **Abort the GCE startup script when the data-disk mount fails** rather than bind-mounting an empty directory as `/workspace` (from the same incident).
- **Refuse to silently create a fresh session when the control plane already holds replicated history** (from the same incident).
- **Operator replication-reset escape hatch** — recovery from an integrity-`failed` orb today is a new orb (from the same incident).

## Follow-ups

- **Standalone re-login action** (was open question 31): repair a mid-run credential revocation without stopping and starting the orb (`docs/credentials.md`; today recovery is stop/start).
- **exe.dev verification spike** (prerequisite for open question 35; `docs/EXE-DEV.md`): a $20 account and a half-day — boot the runtime image with `new`, hit port 8080 through the proxy with an HTTP and a WS client using a locally minted VM token, halt the VM from inside and watch what `ls` reports, then `restart` and confirm `/workspace` survived.
