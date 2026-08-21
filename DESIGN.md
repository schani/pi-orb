# pi-orb Design

> **Status:** Living design documentation. This file is the entry point — purpose, scope, product decisions, and the architecture overview — plus an index of the topical design docs under `docs/`. Each doc records decisions, current proposals, rejected approaches, evidence, and open questions for its subsystem.

## Purpose

pi-orb runs an AI coding agent in an isolated, remotely managed environment called an **orb**. A user should eventually be able to invoke `pi-orb` from a project, get a web-based agent experience backed by an orb, disconnect, and later reconnect from another machine without tying the orb's lifetime to a local process.

Pi is the first agent harness, embedded through the Pi SDK. The host lifecycle, runtime protocol, history model, and replica storage should remain harness-agnostic enough to support another harness, such as Claude Code or Codex, later.

## Current vertical-slice scope

The first target is deliberately narrow:

- Run locally using Docker; container-restricted trusted test environments may use the unsandboxed process-host + embedded PGlite composition.
- Drive the product entirely through the web UI; a local checkout is not required.
- Let users register a project with a name and public Git repository URL.
- Clone the repository into a fresh orb without caching or synchronization optimizations.
- Use a fixed orb runtime image and a prescribed environment.
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

- The entire user interface will be web-based.
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

## Deferred: suborbs

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
- [docs/compute-replacement.md](docs/compute-replacement.md) — immutable-compute plan: dispose failed incarnations, replace stale host specifications on next Start, and retain the workspace throughout
- [docs/lifecycle.md](docs/lifecycle.md) — orb states, reconciliation rules, idle auto-stop, the orphan-host sweep
- [docs/orb-deletion.md](docs/orb-deletion.md) — permanent orb deletion, resource inventory, cleanup protocol, and verification plan
- [docs/project-deletion.md](docs/project-deletion.md) — permanent project deletion by atomic fan-out through deletion-grade cleanup for every child orb
- [docs/orb-archival.md](docs/orb-archival.md) — read-only transcript retention after shared deletion-grade resource cleanup
- [docs/runtime-protocol.md](docs/runtime-protocol.md) — the browser↔runtime wire protocol: handshake, frame union, ordering, backpressure
- [docs/history-replication.md](docs/history-replication.md) — the harness-agnostic history model, pull-only replication, the PostgreSQL schema
- [docs/pi-adapter.md](docs/pi-adapter.md) — Pi embedding and the Pi→normalized history mapping
- [docs/control-plane-api.md](docs/control-plane-api.md) — the project model and the browser-facing HTTP API
- [docs/web-ui.md](docs/web-ui.md) — UI behavior and visual design
- [docs/dashboard-find.md](docs/dashboard-find.md) — dashboard Command-K Find architecture, selected Index card design, and presentation study
- [docs/terminal.md](docs/terminal.md) — investigation and provider-neutral proposal for an interactive web terminal
- [docs/credentials.md](docs/credentials.md) — the credential broker, Codex OAuth, GitHub tokens, security requirements
- [docs/orb-setup-hook.md](docs/orb-setup-hook.md) — repository-owned `.agents/setup` / `.agents/resume` boot hooks, matched to Amp's convention: triggers per compute incarnation, identity-free setup, user-visible failure
- [docs/workload-identity.md](docs/workload-identity.md) — requirements for orb-issued OIDC identity and keyless federation with cloud providers and private services
- [docs/ports.md](docs/ports.md) — port exposure and preview URLs: tier-1 Tailscale, per-orb auth keys, the preview-host contract
- [docs/deployment.md](docs/deployment.md) — Cloud Run/OpenTofu deployment direction (operational workflow: `infra/README.md`)
- [docs/testing.md](docs/testing.md) — DST strategy, the E2E slice, testing decisions
- [docs/stack.md](docs/stack.md) — language, repository layout, dependency, and error-handling choices

Tracking:

- [TODO.md](TODO.md) — the actionable backlog: bugs, hardening, agreed follow-ups
- [docs/open-questions.md](docs/open-questions.md) — undecided design questions (frozen numbering)
- [docs/postmortems/](docs/postmortems/) — incident forensics; design docs keep the resulting rules and link here

Reference material:

- [docs/references/amp-orb-lessons.md](docs/references/amp-orb-lessons.md) — lessons from Amp's “Putting an Agent in an Orb”
- [docs/EXE-DEV.md](docs/EXE-DEV.md) — the full exe.dev host-provider evaluation
- [docs/AWS-MICROVMS.md](docs/AWS-MICROVMS.md) — the full AWS Lambda MicroVMs host-provider evaluation
- [docs/PI-CODEX-E2E.md](docs/PI-CODEX-E2E.md) — Pi + mock-OpenAI-Codex E2E integration mechanism
- [docs/DETERMINED-BUG.md](docs/DETERMINED-BUG.md) — `determined` 0.4.0 cross-task-await deadlock (fixed in 0.4.1)
