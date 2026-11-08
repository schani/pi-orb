# pi-orb design

Entry point to the design docs. Topical docs under `docs/` own their facts; this file holds purpose, scope, cross-cutting product decisions, the architecture overview and the doc map.

## Purpose

pi-orb runs an AI coding agent in an isolated, remotely managed environment called an **orb**. The user works with it through a web UI, can disconnect, and later reconnect from another machine; the orb's lifetime is independent of any browser or local process.

## Scope

- Projects have a name and an optional Git repository; each orb starts from a fresh checkout or an empty workspace.
- Each orb runs one harness, chosen at creation and immutable: central Pi (default) or host-native Claude. Spawned orbs inherit the caller's harness.
- One root conversation per orb: linear, with compaction. No branching, session switching, cloning or forking.
- A fixed runtime image and prescribed base environment, extended per project by secrets, boot hooks, instructions, skills and MCP servers.
- Process (trusted local testing), Docker and GCE hosts behind one host-provider abstraction.
- An in-orb `pi-orb` CLI lets the agent inspect and search sibling transcripts, spawn and message orbs, alert the user, sleep, expose ports, publish files, mint workload-identity tokens, and archive or delete itself when the user asks.
- Trusted coworkers at one company; no collaboration, presence, transfer or permissions framework (`docs/auth.md`).
- Deterministic simulation testing with [`determined`](https://www.npmjs.com/package/determined) is built into concurrency-critical code from the start (`docs/testing.md`).
- Not a generic VM configurator or remote development platform.

## Product decisions

- The user interface is the web app. There is no terminal TUI, and tmux is never the interaction or persistence mechanism.
- The browser talks only to the control plane, never directly to an orb runtime.
- Multiple browser connections to one orb may all issue requests. Live mutations serialize in the agent; inputs serialize in the durable inbox (`docs/inbox.md`).
- Live WebSocket traffic is never persistence authority (`docs/history.md`).
- Complete normalized public history is retained in PostgreSQL; stopped and archived orbs are readable without starting compute.

## Architecture

```text
Browser -- HTTPS / WebSocket --> Control plane (one Cloud Run service)
                                 |-- web/API, auth, lifecycle, brokers
                                 |-- central Pi (Durable) + PostgreSQL authority
                                 |-- normalized public history and live fan-out
                                 `-- OrbHostProvider (process / Docker / GCE)
                                       |-- execution services and workspace
                                       `-- native Claude + filesystem history
```

- **Placement.** Pi runs centrally; Claude runs on its host. Host choice never changes placement (`docs/host-provider.md`).
- **Central Pi** commits private agent state and public history in one PostgreSQL transaction. Inference, MCP, inbox and conversation attachment do not need execution readiness; host-backed tools bind to the current compute incarnation only when invoked (`docs/pi.md`, `docs/lifecycle.md`).
- **Native Claude** keeps authority on its retained filesystem; history reaches PostgreSQL by pull replication and the browser attaches through a content-agnostic proxy (`docs/claude.md`, `docs/history.md`).
- **Passive reads** (history, details, search) use product storage without loading a harness or waking compute.
- **Workspaces** live on retained host storage and survive compute replacement (`docs/lifecycle.md`).

## Doc map

Compute:
- [docs/host-provider.md](docs/host-provider.md) — `OrbHostProvider` port, incarnations, runtime image, process/Docker/GCE providers
- [docs/lifecycle.md](docs/lifecycle.md) — orb states, reconciliation, wake, idle stop, sleep, compute replacement, Claude recovery, event log
- [docs/teardown.md](docs/teardown.md) — orb archive and delete, project delete, cleanup engine
- [docs/orb-setup-hook.md](docs/orb-setup-hook.md) — `.agents/setup` and `.agents/resume` boot hooks

Agents:
- [docs/pi.md](docs/pi.md) — central Pi on Durable: placement, persistence, tools and code-mode, subagents, recovery, patches
- [docs/claude.md](docs/claude.md) — host-native Claude Agent SDK: auth, query lifecycle, steering, history, recovery
- [docs/agent-context.md](docs/agent-context.md) — instructions, skills, owner secrets, git identity, model/thinking settings
- [docs/mcp.md](docs/mcp.md) — project remote MCP servers, OAuth broker, central Pi client
- [docs/model-usage.md](docs/model-usage.md) — per-call model usage ledger and usage page
- [docs/activity-headlines.md](docs/activity-headlines.md) — Luna activity headlines

Protocol and history:
- [docs/runtime-protocol.md](docs/runtime-protocol.md) — browser↔agent live WebSocket and runtime HTTP contract
- [docs/control-plane-api.md](docs/control-plane-api.md) — browser and runtime HTTP API, project and orb model
- [docs/history.md](docs/history.md) — record model, storage authority, Claude replication, browser loading and cache, search
- [docs/inbox.md](docs/inbox.md) — durable per-orb input FIFO, peer messages, spawning

Access:
- [docs/auth.md](docs/auth.md) — application login, sessions, machine callers, ownership
- [docs/credentials.md](docs/credentials.md) — runtime bearer, credential broker, device logins, project secrets
- [docs/workload-identity.md](docs/workload-identity.md) — orb-issued OIDC tokens and keyless federation
- [docs/http-exposure.md](docs/http-exposure.md) — HTTP previews, hosted files, live file links

UI:
- [docs/web-ui.md](docs/web-ui.md) — visual system, navigation, missing resources, dashboard, orb workspace, Find, mobile
- [docs/terminal.md](docs/terminal.md) — interactive orb terminal
- [docs/workspace-uploads.md](docs/workspace-uploads.md) — browser uploads into orb workspaces
- [docs/orb-alerts.md](docs/orb-alerts.md) — CLI-issued transcript alerts and unread flags

Operations:
- [docs/deployment.md](docs/deployment.md) — Cloud Run/GCE deployment, release transaction, rollout monitor (procedures: `infra/README.md`)
- [docs/testing.md](docs/testing.md) — test commands, rules, DST strategy, E2E layout, approved exceptions
- [docs/stack.md](docs/stack.md) — toolchain, repository layout, dependencies, database access
- [docs/dependency-audit.md](docs/dependency-audit.md) — audit method, external pins, open findings

Tracking:
- [TODO.md](TODO.md) — actionable backlog
- [docs/open-questions.md](docs/open-questions.md) — undecided questions (frozen numbering)
- [docs/postmortems/](docs/postmortems/) — incident forensics; owning docs keep the resulting rules
- [docs/references/amp-orb-lessons.md](docs/references/amp-orb-lessons.md) — lessons from Amp's orbs
