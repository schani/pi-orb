# pi-orb Design

> **Status:** Living design documentation. This file is the entry point — purpose, scope, product decisions, and the architecture overview — plus an index of the topical design docs under `docs/`. Each doc records decisions, current proposals, rejected approaches, evidence, and open questions for its subsystem.

## Purpose

pi-orb runs an AI coding agent in an isolated, remotely managed environment called an **orb**. A user should eventually be able to invoke `pi-orb` from a project, get a web-based agent experience backed by an orb, disconnect, and later reconnect from another machine without tying the orb's lifetime to a local process.

Pi is the first agent harness, embedded through the Pi SDK. The host lifecycle, runtime protocol, history model, and replica storage should remain harness-agnostic enough to support another harness, such as Claude Code or Codex, later.

## Current vertical-slice scope

The first target is deliberately narrow:

- Run locally using Docker; container-restricted trusted test environments may use the unsandboxed process-host + embedded PGlite composition.
- Drive lifecycle and conversation input through the web UI; a local checkout is not required. The in-orb `pi-orb` CLI may read sibling-orb metadata and replicated transcripts, launch independent same-project orbs with prompts, and request self-archival when the user asks.
- Let users register a project with a name and public Git repository URL.
- Clone the repository into a fresh orb without caching or synchronization optimizations.
- Use a fixed orb runtime image and prescribed base environment; projects may add write-only environment secrets fetched by each orb runtime at boot (`docs/credentials.md`).
- Embed Pi through its TypeScript SDK.
- Provide a web UI; no terminal TUI and no tmux-based interaction.
- Run exactly one Pi session/conversation per orb.
- Support a linear conversation and compaction. Do not expose branching, session switching, cloning, or forking initially. Durable send-anytime input is implemented: a message steers when delivered to a busy agent and otherwise starts a turn, while submission to a stopped or failed orb durably queues the message and requests startup (`docs/runtime-protocol.md`).
- Persist the orb itself only through its filesystem.
- Replicate the complete conversation history to the control plane database.
- Make stopped-orb history viewable immediately from the database without starting the orb.
- Put Docker behind an infrastructure abstraction that can later gain a GCE implementation.
- Build deterministic simulation testing into concurrency-critical code from the start using [`determined`](https://www.npmjs.com/package/determined).
- Do not focus on multiplayer yet.

The first version is not intended to be a generic VM configurator or a generic remote development platform.

## Product and interaction decisions

- The user-facing interface is web-based. The runtime image also provides a narrow `pi-orb` CLI for agents to discover sibling orbs, inspect replicated transcripts, launch independent same-project work (`docs/orb-spawning.md`), mint workload-identity tokens, and archive themselves on user request (`docs/orb-archival.md`).
- The browser communicates only with the control plane, never directly with an orb runtime.
- The first slice has no authentication or authorization: anybody who can reach the control plane can perform every operation.
- The unauthenticated first slice must be treated as local/trusted-development software and must not be exposed publicly. Authentication is required before a public deployment.
- After routing and runtime connection, the control plane proxies one live WebSocket between browser and runtime without interpreting agent content.
- That WebSocket carries browser commands, transient streaming events, committed history-record notifications, runtime status, acknowledgements, and errors.
- The control plane never uses WebSocket traffic for persistence. Replica persistence happens only through separate control-plane HTTP pulls from the runtime.
- We will not use tmux as the user interaction or session-persistence mechanism.
- The orb's lifetime is independent of the browser or local CLI session.
- There is one agent/conversation per orb in the first version.
- Pi compaction is supported; Pi tree navigation and multiple sessions are not exposed initially.
- The composer supports foreground Pi user-shell commands through explicit `message`, `shell`, and `excluded shell` modes. `!` and `!!` at input offset zero enter the shell modes without leaving a visible prefix; both persist to history, while excluded shell alone is omitted from later model context. Shell submission requires an idle runtime and no image attachments (decided 2026-08-05).
- Multiple browser connections to one orb are allowed and may all issue requests; the runtime serializes live mutations and broadcasts state. The send-anytime message inbox serializes messages durably at the control plane before runtime delivery.
- Multiplayer product features such as presence, attribution, and per-user permissions are out of scope for the first slice.

## High-level architecture

```text
Browser
   |
   | HTTPS / WebSocket
   v
Control plane
   |-- Web/API service
   |-- Orb lifecycle orchestration
   |-- History ingestion and live fan-out
   |-- Cloud SQL/PostgreSQL replica
   |
   | harness-agnostic orb runtime protocol
   v
Orb host
   |-- Docker container initially
   |-- unsandboxed local process for container-restricted testing
   |-- GCE VM later
   |
   `-- Orb runtime (Node.js)
          |-- Pi SDK session and persistent harness history
          |-- history pull adapter
          |-- health and activity reporting
          `-- Pi history adapter
```

The browser talks only to the control plane. In the unauthenticated first slice, the control plane resolves/starts the orb, loads replicated history, and performs the cursor-aware handoff. It proxies the live WebSocket content-agnostically between browser and runtime. History persistence is a separate control-plane-to-runtime HTTP pull, so the proxy does not need to understand agent messages. Cloud Run WebSocket behavior was validated operationally in 2026-07 (`docs/open-questions.md`, question 2).

## In-orb spawning and deferred suborbs

An orb can launch another orb with a prompt through `pi-orb spawn` and receive its browser URL (implemented 2026-09-08). This creates independent same-project work with atomic durable prompt acceptance; see `docs/orb-spawning.md`.

First-class child orbs/subagents are a product goal but not part of the first slice.

Likely future properties:

- parent agent tools to spawn, inspect, message, wait for, and cancel child work;
- control-plane enforcement of concurrency, cost, TTL, and nesting limits;
- branch/worktree isolation so agents never concurrently mutate the same working tree;
- structured results including summary, patch/commit, tests, artifacts, and cost;
- selectable isolation such as process, container, or full orb.

No child-orb protocol has been finalized.

## Design doc index

Subsystem designs:

- [docs/host-provider.md](docs/host-provider.md) — the `OrbHostProvider` port, runtime readiness, Docker/GCE specifics, the exe.dev and AWS Lambda MicroVMs evaluations, rejected host alternatives
- [docs/native-vm-prototype.md](docs/native-vm-prototype.md) — native Debian VM experiment, retention/failure evidence, image inventory, and limits
- [docs/compute-replacement.md](docs/compute-replacement.md) — immutable-compute plan: dispose failed incarnations, replace stale host specifications on next Start, and retain the workspace throughout
- [docs/lifecycle.md](docs/lifecycle.md) — orb states, reconciliation rules, idle auto-stop, the orphan-host sweep
- [docs/orb-deletion.md](docs/orb-deletion.md) — permanent orb deletion, resource inventory, cleanup protocol, and verification plan
- [docs/project-deletion.md](docs/project-deletion.md) — permanent project deletion by atomic fan-out through deletion-grade cleanup for every child orb
- [docs/orb-archival.md](docs/orb-archival.md) — read-only transcript retention after shared deletion-grade resource cleanup
- [docs/orb-spawning.md](docs/orb-spawning.md) — in-orb CLI creation with an atomically queued prompt and browser URL
- [docs/runtime-protocol.md](docs/runtime-protocol.md) — the browser↔runtime wire protocol: handshake, frame union, ordering, backpressure
- [docs/history-replication.md](docs/history-replication.md) — the harness-agnostic history model, pull-only replication, the PostgreSQL schema
- [docs/pi-adapter.md](docs/pi-adapter.md) — Pi embedding and the Pi→normalized history mapping
- [docs/control-plane-api.md](docs/control-plane-api.md) — the project model and the browser-facing HTTP API
- [docs/web-ui.md](docs/web-ui.md) — UI behavior and visual design
- [docs/workspace-uploads.md](docs/workspace-uploads.md) — streaming browser uploads into orb-local files, inbox notifications, idle protection, and recovery
- [docs/dashboard-find.md](docs/dashboard-find.md) — dashboard Command-K Find architecture, selected Index card design, and presentation study
- [docs/terminal.md](docs/terminal.md) — investigation and provider-neutral proposal for an interactive web terminal
- [docs/credentials.md](docs/credentials.md) — the credential broker, Codex OAuth, GitHub tokens, security requirements
- [docs/mcp.md](docs/mcp.md) — project-scoped remote MCP configuration, static secret-backed headers, connection-scoped OAuth broker, first-party Pi tools, DST-first direct transport, and provider qualification
- [docs/orb-setup-hook.md](docs/orb-setup-hook.md) — repository-owned `.agents/setup` / `.agents/resume` boot hooks, matched to Amp's convention: triggers per compute incarnation, identity-free setup, user-visible failure
- [docs/workload-identity.md](docs/workload-identity.md) — requirements for orb-issued OIDC identity and keyless federation with cloud providers and private services
- [docs/workload-identity-recipes.md](docs/workload-identity-recipes.md) — relying-party integration recipes for that identity: GCP workload identity federation, AWS web-identity roles, and generic OIDC verification
- [docs/ports.md](docs/ports.md) — port exposure and preview URLs: tier-1 Tailscale, per-orb auth keys, the preview-host contract
- [docs/hosting.md](docs/hosting.md) — system-hosted orb files: durable namespaces, object storage, publication, serving, and lifecycle ownership
- [docs/deployment.md](docs/deployment.md) — Cloud Run/OpenTofu deployment direction (operational workflow: `infra/README.md`)
- [docs/testing.md](docs/testing.md) — DST strategy, the E2E slice, testing decisions
- [docs/stack.md](docs/stack.md) — language, repository layout, dependency, and error-handling choices

Tracking:

- [docs/postmortems/2026-09-11-release-logging-exclusion-iam.md](docs/postmortems/2026-09-11-release-logging-exclusion-iam.md) — partially applied release blocked by missing callback-log exclusion authority

- [TODO.md](TODO.md) — the actionable backlog: bugs, hardening, agreed follow-ups
- [docs/open-questions.md](docs/open-questions.md) — undecided design questions (frozen numbering)
- [docs/postmortems/2026-09-09-live-web-rebuild.md](docs/postmortems/2026-09-09-live-web-rebuild.md) — blank dashboard from rebuilding a live static root; immutable build and asset/browser validation rules
- [docs/postmortems/2026-09-09-posthog-template-discovery.md](docs/postmortems/2026-09-09-posthog-template-discovery.md) — authenticated PostHog discovery blocked by an optional method's HTTP-404 error envelope
- [docs/postmortems/](docs/postmortems/) — incident forensics; design docs keep the resulting rules and link here
- [docs/postmortems/2026-09-09-stale-thinking.md](docs/postmortems/2026-09-09-stale-thinking.md) — message-index reuse left stale green thinking below newer commands; explicit streaming retirement
- [docs/postmortems/2026-09-09-deleted-browser-reconciler.md](docs/postmortems/2026-09-09-deleted-browser-reconciler.md) — deleted browser revision remained active and raced new-generation provisioning
- [docs/postmortems/2026-09-09-orb-local-tailnet-smoke.md](docs/postmortems/2026-09-09-orb-local-tailnet-smoke.md) — preview smoke must dial through the daemon on userspace Tailscale callers
- [docs/postmortems/2026-09-09-release-hosting-bucket-iam.md](docs/postmortems/2026-09-09-release-hosting-bucket-iam.md) — scoped release cannot read the application hosting bucket during plan
- [docs/postmortems/2026-09-08-identity-cold-start.md](docs/postmortems/2026-09-08-identity-cold-start.md) — short HTTP attempt caps abandon queued mint requests and self-throttle behind runtime API cold starts
- [docs/postmortems/2026-09-08-workspace-image-readonly-check.md](docs/postmortems/2026-09-08-workspace-image-readonly-check.md) — captured workspace template fails resize after a successful read-only check
- [docs/postmortems/2026-09-08-orb-local-release-builder-user.md](docs/postmortems/2026-09-08-orb-local-release-builder-user.md) — orb-local release blocked by implicit SSH username and runtime account collision
- [docs/postmortems/2026-09-05-signing-key-bootstrap-orphans.md](docs/postmortems/2026-09-05-signing-key-bootstrap-orphans.md) — DST-discovered signing-key orphan leak, retry ownership fix, and preserved failure trace

Reference material:

- [docs/postmortems/2026-09-09-stale-frontend-preview.md](docs/postmortems/2026-09-09-stale-frontend-preview.md) — failed Vite reload left an old fixture API serving a new browser client; restart and verify the actual shared service
- [docs/postmortems/2026-09-09-upload-e2e-script-order.md](docs/postmortems/2026-09-09-upload-e2e-script-order.md) — upload validation exposed an ordered mock-inference script defect; all inference consumers need explicit acceptance barriers

- [docs/postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md](docs/postmortems/2026-09-05-tailscale-invalid-key-at-first-boot.md) — failed initial enrollment, composed-DST reproduction, and incarnation-fenced key revocation
- [docs/postmortems/2026-09-07-mixed-generation-drain-restart.md](docs/postmortems/2026-09-07-mixed-generation-drain-restart.md) — cross-revision restart and stale-provision races found by DST
- [docs/postmortems/2026-09-07-explicit-start-terminal-backstop.md](docs/postmortems/2026-09-07-explicit-start-terminal-backstop.md) — explicit Start delayed by a process-local terminal backstop
- [docs/postmortems/2026-09-07-stale-stopping-marker.md](docs/postmortems/2026-09-07-stale-stopping-marker.md) — an old process-local stop episode rejected a restarted orb
- [docs/postmortems/2026-09-07-native-foundation-release-contracts.md](docs/postmortems/2026-09-07-native-foundation-release-contracts.md) — first native rollout contract failures and fixes
- [docs/postmortems/2026-09-07-native-rust-dns-bootstrap.md](docs/postmortems/2026-09-07-native-rust-dns-bootstrap.md) — native boot blocked by Rust DNS resolver behavior
- [docs/postmortems/2026-09-07-native-workspace-systemd-cycle.md](docs/postmortems/2026-09-07-native-workspace-systemd-cycle.md) — retained-workspace boot dropped by a systemd ordering cycle
- [docs/postmortems/2026-09-09-release-iap-sdk-component.md](docs/postmortems/2026-09-09-release-iap-sdk-component.md) — missing SDK beta commands stopped reconciliation after successful apply
- [docs/postmortems/2026-09-09-release-test-environment.md](docs/postmortems/2026-09-09-release-test-environment.md) — inherited release context let passing contract tests overwrite their caller's evidence
- [docs/postmortems/2026-09-09-native-cleanup-dst-io.md](docs/postmortems/2026-09-09-native-cleanup-dst-io.md) — real diagnostic IO and a busy observer escaped deterministic cleanup scheduling
- [docs/postmortems/2026-09-09-credential-probe-role-reset.md](docs/postmortems/2026-09-09-credential-probe-role-reset.md) — ambient SQL role targeted the production password; restoration and explicit-target safeguards
- [docs/postmortems/2026-09-09-local-e2e-docker-startup.md](docs/postmortems/2026-09-09-local-e2e-docker-startup.md) — wrong containerd store and interrupted local validation; preserve evidence and owned fixtures
- [docs/postmortems/2026-09-09-tracked-deployment-credentials.md](docs/postmortems/2026-09-09-tracked-deployment-credentials.md) — live credential confirmed in public plan archives; artifact containment and rotation status
- [docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md](docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md) — interrupted release exited before builder cleanup
- [docs/references/amp-orb-lessons.md](docs/references/amp-orb-lessons.md) — lessons from Amp's “Putting an Agent in an Orb”
- [docs/EXE-DEV.md](docs/EXE-DEV.md) — the full exe.dev host-provider evaluation
- [docs/AWS-MICROVMS.md](docs/AWS-MICROVMS.md) — the full AWS Lambda MicroVMs host-provider evaluation
- [docs/PI-CODEX-E2E.md](docs/PI-CODEX-E2E.md) — Pi + mock-OpenAI-Codex E2E integration mechanism
- [docs/DETERMINED-BUG.md](docs/DETERMINED-BUG.md) — `determined` 0.4.0 cross-task-await deadlock (fixed in 0.4.1)
