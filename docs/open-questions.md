# Open questions

Undecided design questions. Numbering is frozen: never renumber or delete, because code and docs cite questions by number. A resolved question is one line naming its owning doc. Some numbers were allocated twice by parallel branches (62–64, 72–78); cite those with their topic qualifier, e.g. "question 64 (transcript navigation)". New questions continue after the highest number.

## Immediate architecture

1. Finalize the remaining HTTP/WebSocket payload details, capability negotiation and versioning rules.
2. Cloud Run WebSocket behavior — Resolved → `docs/deployment.md`

## Replication and history

3. Define stable adapter-generated IDs for harnesses that do not provide native record IDs.
4. Compare real Claude Code and Codex persisted history before freezing the normalized schema. Open obligations for Claude (`docs/claude.md`): pre-compaction retention and ingestion, UUID/ancestry stability, durable inbox-consumption correlation across crash and compaction, and immutable replication. Post-compaction `getSessionMessages` and best-effort session mirroring do not settle them.
5. Decide which additional record variants deserve static types beyond message, compaction and generic event.
6. Decide how to replicate and store images, large outputs, truncated outputs, patches and artifacts.
7. Define what the UI indicates, if anything, when live history is newer than the replica.

## Lifecycle and background work

8. Observability of agent-started background processes — Resolved → `docs/lifecycle.md`
9. Determine whether ordinary OS process/cgroup inspection is reliable enough to keep detached processes from being idle-stopped, without a custom background-job tool.
10. Browser presence and idle stop — Resolved → `docs/lifecycle.md`

## Project and environment

11. Repository checkout policy (any `failed` runtime health is terminal for that boot, and empty repositories boot with `checkoutCommit: null`: `docs/lifecycle.md`, `docs/host-provider.md`). Still decide: repository-access preflight; whether the runtime retries a clone a bounded number of times before failing; whether users can choose a branch or revision for the first checkout (today the default branch only; `CreateProjectRequest` has no field); and which repository metadata to record.
12. Decide the toolchain release/update cadence. Current pins: `docs/stack.md`.
13. Adopt Amp-style setup/resume hooks — Resolved → `docs/orb-setup-hook.md`
14. Decide how setup caching or prebuilt snapshots work.
15. Decide which further tools and services the prescribed base image installs. Current image: `docs/host-provider.md`.
16. Decide if and when an Orbfile is introduced and what it may configure.
17. Decide how orb services and logs are exposed to the agent and the user. Previews: `docs/http-exposure.md`; browser automation: `docs/host-provider.md`.

## Control plane, database, and deployment

18. Define the abstract history repository/database interface.
19. Infrastructure-as-code boundary — Resolved → `docs/deployment.md`
20. Decide how to partition polling if redundant all-orb polling becomes inefficient at scale; no leader or partitioning is needed now.
21. Credential broker and orb networking — Resolved → `docs/credentials.md`
22. Define observability, audit logging, metrics and cost attribution beyond the model usage ledger (`docs/model-usage.md`).
23. Orphan-host sweep — Resolved → `docs/lifecycle.md`

## Product and security

24. Multi-user scope — Resolved → `docs/auth.md`
25. Decide whether workload-identity tokens carry user-level claims. Per-user credentials: `docs/credentials.md`.
26. Coworker trust and network topology — Resolved → `docs/auth.md`
27. Decide whether to offer export before permanent orb deletion. Deletion contract: `docs/teardown.md`.
28. Define whether stopped hosts have an expiration/garbage-collection policy.
29. Define the eventual suborb orchestration and filesystem handoff model.

## Testing

30. Define CI iteration budgets and storage/replay conventions for failing entropy traces.

## Cloud slice follow-ups

31. Standalone re-login action — Moved → `TODO.md`
32. GCE script-version stamp — Resolved → `docs/lifecycle.md`
33. Served-vs-durable persistence gap — Resolved → `docs/history.md`
34. Full-slice E2E on macOS Docker Desktop — Resolved → `docs/testing.md`
35. Decide whether to build an exe.dev host provider. Mismatches: no stop/start (emulate it, or accept always-on with idle stop disabled), the rootfs is the persistent disk so re-imaging destroys `/workspace`, and runtime connectivity would invert through exe.dev's HTTPS proxy, requiring public runtime-broker ingress. Verify first: WebSocket forwarding through the proxy, `ls --json` observability fields, duplicate-name create behavior and in-VM halt semantics.
36. Unreachable-restart livelock — Resolved → `docs/lifecycle.md`
37. Decide whether to build an AWS Lambda MicroVMs host provider. The 8-hour `maximumDurationInSeconds` cap (running plus suspended; terminated VMs are unrecoverable) is survivable only by externalizing durable orb state (per-orb EFS through a VPC egress connector) and rotating VMs proactively in the lifecycle machine. Verify first: EFS/NFS mounting from a MicroVM through the connector, mount survival across suspend/resume, git performance on EFS, the `/terminate` hook timeout, auth-token maximum expiry and per-VM tagging/enumeration. Also decide the rotation design (drain window, age tracking, successor handoff) and accept a second cloud (AWS account, IAM, VPC, EFS), ARM64-only images and a public-egress runtime broker with JWE token refresh.
38. Decide whether to show control-plane lifecycle events (host restarts, unreachable restarts, idle stops, transitions with reasons) as display-only notices in the transcript (motivated by `docs/postmortems/2026-08-05-egress-blip-false-unreachable-restart.md`). Proposal: persist the existing lifecycle edges (`docs/lifecycle.md`) into a per-orb `orb_events` table in the same transaction as the transition CAS, expose them read-only and interleave them by timestamp. Rejected: synthesizing replicated history records (puts UI copy into model context and cannot be written while the runtime is down) and injecting frames into the live socket. Harness restart notices that the model must see are separate (`docs/lifecycle.md`). Related: question 7.
39. Interactive terminal — Resolved → `docs/terminal.md`
40. Decide automatic deployment on push (the manual workflow is `docs/deployment.md`): whether "every push" means latest-eligible coalescing, GitHub's bounded `queue: max` (not chronological) or a durable FIFO; whether the production environment needs approval; and where rollback stops being automatic when a release includes migrations or static-plane changes. The migration branch must define change detection, approval or maintenance policy, a verified recovery point and a rehearsed forward-fix/rollback runbook. Every variant keeps the serialized non-cancellable release transaction, shared generation selection, forward-only host-spec fencing, WIF authentication and rollback by advancing the generation.

## Orb boot hooks

41. Boot setup hook contract — Resolved → `docs/orb-setup-hook.md`
42. Native GCE runtime user — Resolved → `docs/host-provider.md`
43. Decide whether pi-orb needs a repository-declared services manifest and supervisor (Amp's `.amp/services.yaml`) for long-running processes an orb keeps alive across turns and restarts. Boot hooks forbid long-running processes (`docs/orb-setup-hook.md`); interacts with previews (`docs/http-exposure.md`).
44. Project secrets as the first environment surface — Resolved → `docs/credentials.md`
45. Project secrets UI — Resolved → `docs/web-ui.md`
46. Project secrets entry point — Resolved → `docs/web-ui.md`
47. Self-archive CLI — Resolved → `docs/teardown.md`

## Docker inside GCP orbs

48. Native Debian GCE image and optional Docker — Resolved → `docs/host-provider.md`

## Orb-hosted files

49. Hosted-file access policy — Resolved → `docs/http-exposure.md`
50. Hosted files on delete and archive — Resolved → `docs/teardown.md`
51. Decide whether to support atomic folder/site publication. Today each operation publishes one file, so a sequence of replacements can expose a mixed site; a site manifest or release pointer could switch a folder atomically but adds a second identity and cleanup unit. Contract: `docs/http-exposure.md`.
52. Decide per-orb total bytes and file-count limits, configurable limits, media-type restrictions and version restoration for hosted files. Current limits: `docs/http-exposure.md`.
53. Hosted-file origin — Resolved → `docs/http-exposure.md`
54. Hosted-file publication request IDs — Resolved → `docs/http-exposure.md`
55. Hosted-file upload sessions and read snapshots — Resolved → `docs/http-exposure.md`
56. Decide whether hosted bytes move from GCS/filesystem storage into bounded PostgreSQL `bytea` chunks. Staged chunks and atomic catalog publication could remove the distributed publication, resumable-session and cleanup-claim machinery while keeping streaming, replay, shared storage and deletion; the cost is file traffic, WAL, storage and backups on PostgreSQL. Validation must cover binary behavior on PostgreSQL and PGlite, bounded one-chunk reads, concurrent publication and a stable download snapshot; holding a connection per download may limit concurrency.
57. Native runtime supervisor — Resolved → `docs/host-provider.md`

## Remote MCP

58. Remote MCP scope, auth and tools — Resolved → `docs/mcp.md`

## Workspace uploads

59. Decide per-file and per-orb upload storage quotas; the safe-integer size bound is representation validation, not a quota. Transfer contract: `docs/workspace-uploads.md`.
60. Upload notification after stop — Resolved → `docs/workspace-uploads.md`
61. Upload destination and notification — Resolved → `docs/workspace-uploads.md`

## Local leaf subagents

62. (local leaf subagents) Children edit the shared checkout — Resolved → `docs/pi.md`
63. (local leaf subagents) No child transcripts — Resolved → `docs/pi.md`
64. (local leaf subagents) Cancellation and recovery scope — Resolved → `docs/pi.md`
65. Subagent receipts and live rail — Resolved → `docs/web-ui.md`
66. Subagent rail above the terminal shade — Resolved → `docs/terminal.md`

## Agent settings

62. (agent settings) Model and thinking settings — Resolved → `docs/agent-context.md`

## Personal instructions

63. (personal instructions) Account-wide instructions — Resolved → `docs/agent-context.md`

## Transcript navigation performance

64. (transcript navigation) Browser transcript caching — Resolved → `docs/history.md`

## Additional project instructions

67. Per-project instructions — Resolved → `docs/agent-context.md`

## Scheduled orb sleep

68. Scheduled sleep — Resolved → `docs/lifecycle.md`

## Transcript tool images

69. Inline tool images — Resolved → `docs/web-ui.md`

## Orb self-deletion

70. Self-delete CLI — Resolved → `docs/teardown.md`

## Orb alerts

71. Alert presentation — Resolved → `docs/orb-alerts.md`

## Control-plane service consolidation — 72–75

72. (control-plane consolidation) One application service with application authentication — Resolved → `docs/auth.md`
73. (control-plane consolidation) Reuse the issuer service as the application — Resolved → `docs/deployment.md`
74. (control-plane consolidation) Sealed fixed-expiry session cookies — Resolved → `docs/auth.md`
75. (application URL) `pi-orb-issuer` as the sole service and address — Resolved → `docs/deployment.md`

## Claude Agent SDK subscription authorization — 72 (Claude SDK)

72. (Claude SDK) Placement and owner-level subscription auth are decided (`docs/claude.md`, `docs/credentials.md`). Still open: whether a credential-injecting gateway could replace the guest-readable long-lived token (official gateway credentials and `apiKeyHelper` replace subscription login; a base-URL-only gateway would need OAuth beta forwarding, and mode, routing and accounting need live validation first); whether Anthropic's third-party-offering terms permit subscription use for users other than the owner; and proof of native flags, auth-source headers and billing precedence without `--bare` or ambient API keys. API billing needs separate opt-in, never fallback.

## Claude SDK idle admission and drain — 73 (Claude SDK)

73. (Claude SDK) Can the public SDK fence SDK-originated starts and automatic continuations before inference, and prove that root, tool and child cleanup, durable terminal publication and continuation handoff have drained, so that one permanently open query could replace query-process rotation (`docs/claude.md`)? Root completion, replacement inventories, Stop hooks and interrupt/`stopTask` acceptance are insufficient. Proof needs real-SDK and composed DST evidence for root-result/blocked-child, terminal/wake, queued-input/interrupt, hook error/continuation, inventory ordering/ambient work, native tool cleanup and prepare/archive races.

## Pi Durable — 72–74 (Pi Durable)

72. (Pi Durable) Central Pi on Durable — Resolved → `docs/pi.md`
73. (Pi Durable) Central Git acquisition and pinned initial resources — Resolved → `docs/pi.md`
74. (Pi Durable) Separate public transcript and private agent state — Resolved → `docs/history.md`

## Spot preemption frequency — 76

76. What to do when Spot preemption is frequent enough to stall work (`docs/postmortems/2026-10-06-spot-preemption-burst.md`: six preemptions of one orb in 72 minutes). The fleet is single-zone Spot (`docs/host-provider.md`). Options: accept it; spread new orbs across zones (disks are zonal, so existing orbs stay); fall back to on-demand after N preemptions in a window; let the user pin an orb to on-demand. Also: should the user see a preemption count?

## Token usage display — 77

77. (token usage) Usage page — Resolved → `docs/model-usage.md`

## Lossless history storage — 77

77. (lossless history) History payloads as `json` — Resolved → `docs/history.md`

## Spawned-orb pad nesting — 78

78. (pad nesting) Inline spawn tree — Resolved → `docs/web-ui.md`

## Expandable child-to-parent alerts — 78

78. (child-to-parent alerts) Inline preview — Resolved → `docs/orb-alerts.md`

## Orb messaging — 78

78. (orb messaging) Same-owner peer messages — Resolved → `docs/inbox.md`

## Spawn model intent — 79

79. Spawn model intent — Resolved → `docs/inbox.md`

## Claude model usage forwarding — 80

80. Claude usage through replicated history — Resolved → `docs/model-usage.md`

## Code-mode store cutover — 81

81. No legacy code-mode store carryover — Resolved → `docs/pi.md`

## Pi 1.4 persisted state — 82

82. Pi 1.4 persisted-state changes — Resolved → `docs/pi.md`

## Owner skills and secrets surface — 83

83. Owner skills and secrets in Settings tabs — Resolved → `docs/agent-context.md`

## Current-URL share access placement — 84

84. Share sits in the orb identity cell ([docs/web-ui.md](web-ui.md#app-shell-routing-and-navigation)). Still open: whether and where Share is reachable on other pages, including the dashboard.

## Native history search prerequisites — 85

85. `pg_textsearch` version and rollout order — Resolved → `docs/history.md`

## GitHub owner-skill folders — 86

86. Commit-pinned GitHub skill bundles — Resolved → `docs/agent-context.md`

## Dependency-update state conversions — 87

87. Upstream-managed state conversions on dependency updates — Resolved → `docs/deployment.md`

## Browser-preview ingress — 72–77 (browser preview)

72. (browser preview) Authenticated separate-origin preview proxy — Resolved → `docs/http-exposure.md`
73. (browser preview) Remove built-in Tailscale — Resolved → `docs/http-exposure.md`
74. (browser preview) Preview domain, ingress and login — Resolved → `docs/http-exposure.md`
75. (browser preview) Preview activity and idle stop — Resolved → `docs/http-exposure.md`
76. (browser preview) Explicit port registration — Resolved → `docs/http-exposure.md`
77. (browser preview) Plain HTTP proxying limits — Resolved → `docs/http-exposure.md`

## Claude queued-input proof order — 88

88. Queued-input receipt proof order — Resolved → `docs/claude.md`

## Pi 1.5 native persisted state and recovery — 89

89. Pi 1.5 lazy upgrades and memory-first progress — Resolved → `docs/pi.md`

## Live orb-file links — 90

90. Live orb-file links — Resolved → `docs/http-exposure.md`

## Shared files-origin live links — 91

91. Live links on the shared files origin — Resolved → `docs/http-exposure.md`

## Canonical-path prompt guidance — 92

92. Canonical-path prompt sentence — Resolved → `docs/http-exposure.md`

## Compact orb-file Markdown URIs — 93

93. Compact `orb:` Markdown links — Resolved → `docs/http-exposure.md`

## Release speed — 94

94. Which release-speed changes to adopt (`docs/deployment.md`): (a) overlap the remote native build with qualification (no publication before all checks; cancellation must await remote cleanup; speculative builds cost money); (b) reuse an accepted runtime image for frontend/control-only changes, keyed by artifact-input identity (runtime source, lockfile, patches, recipe, OS/tool inputs) rather than exact commit; (c) separate immutable frontend publication with atomic index/assets; (d) per-stage timing, cache and reuse instrumentation in the release record.

## E2E runtime — 95–96

95. Should E2E advance a test clock through deletion-quarantine deadlines? Full-slice spends over 260 s in four real 65 s quarantine windows. Proposal: reuse acknowledged test-clock control scoped to deletion/quarantine deadlines only; before advancing, observe the fenced cleanup intent, the `deletion_quarantine` outcome, no durable blocker and completion of prior provider work, then advance, request reconciliation and assert finalization. Never shorten the production bound, auto-advance through live I/O, or add persisted state or provider-drain machinery for test speed. Open: does existing completion/fencing evidence suffice for these fixtures?
96. Should ordinary lifecycle E2E coverage run on process hosts with real PostgreSQL, keeping narrow Docker image/volume/network gates and native-image/GCE acceptance for packaging? Prerequisite: port the provider-independent workload-identity and interrupted-process assertions off Docker first (`docs/testing.md`).
