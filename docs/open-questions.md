# Open questions

Genuinely undecided design questions. Numbering is frozen and append-only — resolved questions are marked in place, never renumbered or deleted, because code and docs reference questions by number. Actionable work items (bugs, hardening, agreed follow-ups) live in `TODO.md`, not here; when a question is decided and the decision implies work, it is marked resolved here and the work moves there in the same edit.

## Immediate architecture

1. Finalize the remaining HTTP/WebSocket payload details, capability negotiation, and versioning rules.
2. Fully resolved by the Cloud Run WebSocket validation exercise (2026-07-30; its throwaway runbook and code lived under `experiments/cloudrun-ws-validation/` and were removed after the exercise — see git history): the request timeout must be raised from the 300-second default (measured forced close at 301 s) to the 60-minute maximum (measured forced close at 3601 s, code 1006, clean ~1 s reconnect — the ordinary resynchronization path handles it); Direct VPC egress carries a WebSocket from Cloud Run to an internal-IP COS VM with no external addresses involved, and such outbound connections are exempt from the request timeout (measured 11.4 h, zero drops, ended only by instance replacement); direct IAP-on-Cloud-Run is available, gates unauthenticated traffic, and passes browser WebSockets after sign-in; billable instance time is a flat one instance regardless of open sockets under instance-based billing (measured over 12+ hours). The load-balancer fallback is unnecessary.

## Replication and history

3. Define stable adapter-generated IDs for harnesses that do not provide native record IDs.
4. Compare real Claude Code and Codex persisted history examples before freezing the normalized schema.
5. Decide which additional record variants deserve static types beyond message, compaction, and generic event.
6. Decide how to replicate and store images, large outputs, truncated outputs, patches, and artifacts.
7. Define what the UI indicates, if anything, when live history is newer than the replica.

## Lifecycle and background work

8. Resolved: Pi SDK 0.83.0 has no shell registry or reliable query for surviving agent-started processes; only active awaited execution/tool lifecycle is observable (docs/lifecycle.md).
9. Determine whether ordinary OS process/cgroup inspection is reliable enough to avoid a custom background-job tool.
10. Resolved: a browser connection prevents automatic idle shutdown only while its tab reports `visible`; hidden or non-reporting connections do not count (docs/lifecycle.md).

## Project and environment

11. Define clone failure handling, default-branch behavior, and recorded repository metadata.
12. Choose the runtime container base-image pin and Node 24 release/update policy. (The VM host-OS half of this question dissolved: cloud hosts boot Container-Optimized OS and only run the runtime container, docs/host-provider.md.)
13. Decide whether to adopt `.agents/setup` and a restart hook inspired by Amp.
14. Decide how setup caching/prebuilt snapshots work after the unoptimized first slice.
15. Decide which tools and services are installed in the prescribed base image. (Resolved for `gh`: installed in the runtime image with brokered auth, docs/credentials.md; the broader tool list remains open.)
16. Decide if/when an Orbfile is introduced and what it is allowed to configure.
17. Decide how services, ports, logs, browser automation, and preview URLs work.

## Control plane, database, and deployment

18. Define the abstract history repository/database interface.
19. Resolved: OpenTofu manages the static infrastructure plane; per-orb VMs stay dynamic provider resources outside IaC (docs/deployment.md).
20. Decide how to partition polling later if redundant all-orb polling becomes inefficient at scale; no leader or partitioning is needed initially.
21. Resolved: credential-broker and per-orb-token design written (docs/credentials.md); networking decided: Direct VPC egress to internal instance IPs (docs/host-provider.md). Remaining: implement it, and validate direct IAP-on-Cloud-Run during the WebSocket validation exercise.
22. Define observability, audit logging, metrics, and cost attribution.
23. Resolved: the orphan-host sweep in docs/lifecycle.md is the decided design — a periodic idempotent loop over `listManagedHosts` that only ever stops pi-orb-labeled hosts, never starts or deletes.

## Product and security

24. Define the future user/project/orb identity and authorization model before public deployment.
25. Define future per-user/project model credentials and private-Git credentials/workload identity. (A proposal for brokered GitHub credentials exists in docs/credentials.md.)
26. Define project trust and the security boundary for repository-controlled code.
27. Define orb deletion/export behavior and retention of replicated history.
28. Define whether stopped hosts have an expiration/garbage-collection policy.
29. Define the eventual suborb orchestration and filesystem handoff model.

## Testing

30. Define CI iteration budgets and storage/replay conventions for failing entropy traces.
## Cloud slice follow-ups

31. Moved to `TODO.md` (agreed follow-up, not an open question): a standalone re-login action for mid-run credential revocation.
32. Resolved (2026-08-01): the script-version stamp is implemented in `GceOrbHostProvider` — see the docs/host-provider.md rollout-caveat entry for the mechanism, the upgrade-delivery side effect, and the accepted drain-window residual.
33. Moved to `TODO.md` (hardening work, not an open question): closing the served-vs-durable persistence gap (incident: `docs/postmortems/2026-08-03-cursor-not-found.md`).
34. Moved to `TODO.md` (bug, not an open question): the full-slice E2E cannot run on macOS Docker Desktop.
35. Decide whether to build the exe.dev host provider evaluated in docs/host-provider.md (2026-08-05). Prerequisites before deciding: empirically verify WebSocket forwarding through the exe.dev HTTPS proxy, `ls --json` observability fields, duplicate-name create behavior, and in-VM halt semantics; choose an emulation strategy for `stop` (or accept always-on with idle-stop disabled for this provider); choose an image-upgrade story for existing VMs (the rootfs is the persistent disk, so re-imaging destroys `/workspace`); and accept flipping the runtime broker Cloud Run service to public ingress.
36. Moved to `TODO.md` (bug, not an open question): the unreachable-restart livelock (forensics: `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`).
37. Decide whether to build the AWS Lambda MicroVMs host provider evaluated in docs/host-provider.md (2026-08-05). The 8 h `maximumDurationInSeconds` cap (running + suspended combined; terminated VMs are unrecoverable) is survivable only by externalizing durable orb state — per-orb EFS over a VPC egress connector is the proposed mechanism — plus proactive VM rotation in the lifecycle machine. Prerequisites before deciding: empirically verify EFS/NFS mounting from inside a MicroVM through a VPC egress connector, NFS mount survival across suspend/resume, git performance on EFS, the `/terminate` hook timeout, auth-token maximum expiry, and per-VM tagging/enumeration; decide the rotation design (drain window, age tracking, successor handoff); accept the cross-cloud operational surface (AWS account, IAM, VPC, EFS alongside GCP); accept ARM64-only runtime images and public-egress runtime broker with JWE token refresh.
