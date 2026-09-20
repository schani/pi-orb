# pi-orb Design

> **Status:** Living design documentation. This file is the entry point — purpose, scope, product decisions, and the architecture overview — plus an index of the topical design docs under `docs/`. Each doc records decisions, current proposals, rejected approaches, evidence, and open questions for its subsystem.

## Purpose

pi-orb runs an AI coding agent in an isolated, remotely managed environment called an **orb**. A user should eventually be able to invoke `pi-orb` from a project, get a web-based agent experience backed by an orb, disconnect, and later reconnect from another machine without tying the orb's lifetime to a local process.

Pi is the first agent harness, embedded through the Pi SDK. The host lifecycle, runtime protocol, history model, and replica storage should remain harness-agnostic enough to support another harness, such as Claude Code or Codex, later.

## Current vertical-slice scope

The first target is deliberately narrow:

- Run locally using Docker; container-restricted trusted test environments may use the unsandboxed process-host + embedded PGlite composition.
- Drive lifecycle and conversation input through the web UI; a local checkout is not required. The in-orb `pi-orb` CLI may read sibling-orb metadata and replicated transcripts, launch independent same-project orbs with prompts, and request self-archival or self-deletion when the user asks.
- Let users register a project with a name and public Git repository URL.
- Clone the repository into a fresh orb without caching or synchronization optimizations.
- Use a fixed orb runtime image and prescribed base environment; projects may add write-only environment secrets fetched by each orb runtime at boot (`docs/credentials.md`).
- Embed Pi through its TypeScript SDK.
- Provide a web UI; no terminal TUI and no tmux-based interaction.
- Run exactly one Pi session/conversation per orb.
- Support a linear conversation and compaction. Do not expose branching, session switching, cloning, or forking initially. Durable send-anytime input is implemented: a message steers when delivered to a busy agent and otherwise starts a turn, while submission to a stopped or failed orb durably queues the message and requests startup (`docs/runtime-protocol.md`). Scheduled self-sleep is approved and under DST-first implementation: graceful stop/start with a durable deadline and combined first-wake notification (`docs/orb-sleep.md`).
- Persist the orb itself only through its filesystem.
- Replicate the complete conversation history to the control plane database.
- Make stopped-orb history viewable immediately from the database without starting the orb.
- Put Docker behind an infrastructure abstraction that can later gain a GCE implementation.
- Build deterministic simulation testing into concurrency-critical code from the start using [`determined`](https://www.npmjs.com/package/determined).
- Support trusted-company ownership without collaboration features: own-user defaults, company-wide direct resource access, and no presence, transfer, coworker-switcher or permissions framework.

The first version is not intended to be a generic VM configurator or a generic remote development platform.

## Product and interaction decisions

- The user-facing interface is web-based. The runtime image also provides a narrow `pi-orb` CLI for agents to discover sibling orbs, inspect replicated transcripts, launch independent same-project work (`docs/orb-spawning.md`), mint workload-identity tokens, and archive or delete themselves on user request (`docs/orb-archival.md`, `docs/orb-deletion.md`).
- The browser communicates only with the control plane, never directly with an orb runtime.
- The original first slice has no application authentication or authorization: anybody who can reach it can perform every operation. It is local/trusted-development software and must not be exposed publicly.
- Stages 1–2 application identity, owned projects, and per-user personal instructions are deployed from `ec81e80` for existing single-user use. Stage 2's schema/data cutover is verified; typed-history migration compatibility enforcement remains a follow-up (`docs/postmortems/2026-09-17-typed-history-runtime-fence.md`). Stage 3 per-user credentials is on `main`, qualified, and undeployed; coworker onboarding remains unauthorized. Cloud IAP remains the login boundary; local development uses one explicit fixed developer identity. `docs/multi-user.md`.
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
- Multi-user scope is trusted coworkers at one small company (clarified 2026-09-16): default lists are own-user, while existing direct project/orb/file/transcript/settings/lifecycle access stays company-wide. A project and its children have one owner; its Codex/GitHub credentials, login cohort, runtime token grants, naming, and auxiliary inference follow that owner, never the viewer. No coworker switcher, transfers, quotas, security-boundary or roles framework. Stages 1–2 are deployed; stage 3 is on `main`, qualified, and undeployed. Coworker onboarding remains unauthorized. `docs/multi-user.md`.

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

The browser talks only to the control plane. In the original first slice, the control plane resolves/starts the orb, loads replicated history, and performs the cursor-aware handoff. It proxies the live WebSocket content-agnostically between browser and runtime. History persistence is a separate control-plane-to-runtime HTTP pull, so the proxy does not need to understand agent messages. Cloud Run WebSocket behavior was validated operationally in 2026-07 (`docs/open-questions.md`, question 2).

## In-orb spawning and deferred suborbs

An orb can launch another orb with a prompt through `pi-orb spawn` and receive its browser URL (implemented 2026-09-08). This creates independent same-project work with atomic durable prompt acceptance; see `docs/orb-spawning.md`.

First-class child orbs/subagents are a product goal but not part of the first slice. Local subagent integration is being validated in `docs/subagents.md` (2026-09-14): a minimal pinned gotgenes fork plus runtime-owned aggregate activity, preserving one user-facing root conversation with additional internal SDK sessions. It is not deployed.

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
- [docs/orb-sleep.md](docs/orb-sleep.md) — approved, DST-first implementation contract for CLI-requested graceful stop/start and combined first-wake notice
- [docs/orb-deletion.md](docs/orb-deletion.md) — permanent orb deletion, resource inventory, cleanup protocol, and verification plan
- [docs/project-deletion.md](docs/project-deletion.md) — permanent project deletion by atomic fan-out through deletion-grade cleanup for every child orb
- [docs/orb-archival.md](docs/orb-archival.md) — read-only transcript retention after shared deletion-grade resource cleanup
- [docs/orb-spawning.md](docs/orb-spawning.md) — in-orb CLI creation with an atomically queued prompt and browser URL
- [docs/runtime-protocol.md](docs/runtime-protocol.md) — the browser↔runtime wire protocol: handshake, frame union, ordering, backpressure
- [docs/history-replication.md](docs/history-replication.md) — the harness-agnostic history model, pull-only replication, the PostgreSQL schema
- [docs/pi-adapter.md](docs/pi-adapter.md) — Pi embedding and the Pi→normalized history mapping
- [docs/subagents.md](docs/subagents.md) — local leaf subagents, minimal gotgenes fork, aggregate activity and DST-first integration/acceptance plan
- [docs/control-plane-api.md](docs/control-plane-api.md) — the project model and the browser-facing HTTP API
- [docs/multi-user.md](docs/multi-user.md) — trusted-company identity, owned projects/settings, per-user credentials, and tailnet options
- [docs/web-ui.md](docs/web-ui.md) — UI behavior and visual design
- [docs/transcript-cache.md](docs/transcript-cache.md) — bounded browser transcript caching, ownership/freshness rules and deterministic/browser qualification
- [docs/agent-settings.md](docs/agent-settings.md) — implemented lifecycle-cluster header, model/thinking authority, persistence, mutation and DST qualification
- [docs/personal-instructions.md](docs/personal-instructions.md) — account-wide `AGENTS.md`, Home gear editor, next-start adoption and test-first qualification
- [docs/project-instructions.md](docs/project-instructions.md) — additional per-project instructions, Config tab, additive virtual context and next-start adoption
- [docs/workspace-uploads.md](docs/workspace-uploads.md) — streaming browser uploads into orb-local files, inbox notifications, idle protection, and recovery
- [docs/dashboard-find.md](docs/dashboard-find.md) — dashboard and orb-view Command-K Find architecture, selected Index card design, and presentation study
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

- [docs/postmortems/2026-09-20-composer-typing-stalls.md](docs/postmortems/2026-09-20-composer-typing-stalls.md) — browser-parent cycle collection and independent unchanged-transcript rerenders stalled composer input
- [docs/postmortems/2026-09-18-image-preview-validation.md](docs/postmortems/2026-09-18-image-preview-validation.md) — mutable-source qualification, subpixel geometry inference, and undrained browser-route teardown failures
- [docs/postmortems/2026-09-18-hosted-frontend-bootstrap-readiness.md](docs/postmortems/2026-09-18-hosted-frontend-bootstrap-readiness.md) — hosted blank-shell cause remains unresolved; browser assertions now own their fixture-response readiness
- [docs/postmortems/2026-09-18-boot-context-cold-start.md](docs/postmortems/2026-09-18-boot-context-cold-start.md) — two runtime-API cold starts exhausted a mandatory boot read; bounded retry is implemented locally
- [docs/postmortems/2026-09-18-webkit-missing-resource-race.md](docs/postmortems/2026-09-18-webkit-missing-resource-race.md) — stale metadata polling resurrected an orb after a definitive history 404
- [docs/postmortems/2026-09-18-e2e-concurrency-readiness.md](docs/postmortems/2026-09-18-e2e-concurrency-readiness.md) — frontend assertions raced their dependent fixture responses under suite load
- [docs/postmortems/2026-09-17-broker-refresh-publication-retry.md](docs/postmortems/2026-09-17-broker-refresh-publication-retry.md) — refresh publication stopped after a proved pre-commit pointer failure
- [docs/postmortems/2026-09-17-release-owner-environment-leak.md](docs/postmortems/2026-09-17-release-owner-environment-leak.md) — deployment owner input leaked into fresh-database release E2E migrations
- [docs/postmortems/2026-09-17-e2e-job-budget.md](docs/postmortems/2026-09-17-e2e-job-budget.md) — serial E2E growth exceeded the GitHub job's whole-path timeout
- [docs/postmortems/2026-09-17-typed-history-runtime-fence.md](docs/postmortems/2026-09-17-typed-history-runtime-fence.md) — typed-history backfill ran while a legacy runtime writer remained active
- [docs/postmortems/2026-09-17-delivered-message-order.md](docs/postmortems/2026-09-17-delivered-message-order.md) — delivered inbox prompt rendered after its assistant turn when the browser lacked the matching user history record
- [docs/postmortems/2026-09-16-validator-cleanup-timeout.md](docs/postmortems/2026-09-16-validator-cleanup-timeout.md) — five-minute cleanup CLI timeout while the accepted GCE delete completed asynchronously
- [docs/postmortems/2026-09-16-release-validation-blockers.md](docs/postmortems/2026-09-16-release-validation-blockers.md) — boot-hook DST, Find source-lifecycle and project-instructions activation-race corrections
- [docs/postmortems/2026-09-16-codex-websocket-closures.md](docs/postmortems/2026-09-16-codex-websocket-closures.md) — persisted OpenAI Codex response-stream closures, automatic retry evidence, and limits of the production diagnosis
- [docs/postmortems/2026-09-14-subagent-notification-transcript.md](docs/postmortems/2026-09-14-subagent-notification-transcript.md) — raw model-facing XML shown in the browser; delayed uncollected child failures caused extra parent replies
- [docs/postmortems/2026-09-14-local-subagent-routing-and-disclosure.md](docs/postmortems/2026-09-14-local-subagent-routing-and-disclosure.md) — stale delegation guidance created an independent orb; nested tool folds hid existing input/output
- [docs/postmortems/2026-09-15-cache-catchup-fixture-ownership.md](docs/postmortems/2026-09-15-cache-catchup-fixture-ownership.md) — cache catch-up repair race; socket-owned fixture work and durable completion barriers

- [docs/postmortems/2026-09-15-long-transcript-navigation.md](docs/postmortems/2026-09-15-long-transcript-navigation.md) — slow orb switching profile: large JSON response and 1Password-amplified composer mount

- [docs/postmortems/2026-09-14-terminal-retry-pre-ready.md](docs/postmortems/2026-09-14-terminal-retry-pre-ready.md) — terminal retry E2E counted transient StrictMode opens instead of current transport ownership

- [docs/postmortems/2026-09-13-release-webkit-prerequisite.md](docs/postmortems/2026-09-13-release-webkit-prerequisite.md) — missing managed browser dependency in unattended release checks

- [docs/postmortems/2026-09-12-delete-discard-dst-ordering.md](docs/postmortems/2026-09-12-delete-discard-dst-ordering.md) — preserved DST failure from an unforced discard/deletion intermediate-state assumption

- [docs/postmortems/2026-09-12-mcp-completion-selector.md](docs/postmortems/2026-09-12-mcp-completion-selector.md) — test synchronization across history publication and live-output retirement

- [docs/postmortems/2026-09-11-release-logging-exclusion-iam.md](docs/postmortems/2026-09-11-release-logging-exclusion-iam.md) — partially applied release blocked by missing callback-log exclusion authority

- [TODO.md](TODO.md) — the actionable backlog: bugs, hardening, agreed follow-ups
- [docs/open-questions.md](docs/open-questions.md) — undecided design questions (frozen numbering)
- [docs/postmortems/2026-09-09-live-web-rebuild.md](docs/postmortems/2026-09-09-live-web-rebuild.md) — blank dashboard from rebuilding a live static root; immutable build and asset/browser validation rules
- [docs/postmortems/2026-09-09-posthog-template-discovery.md](docs/postmortems/2026-09-09-posthog-template-discovery.md) — authenticated PostHog discovery blocked by an optional method's HTTP-404 error envelope
- [docs/postmortems/2026-09-12-terminal-focus-and-scroll-padding.md](docs/postmortems/2026-09-12-terminal-focus-and-scroll-padding.md) — resize hit-target focus and scrolling padding caused a thick edge and partial terminal rows
- [docs/postmortems/2026-09-12-mobile-safari-scroll-ownership.md](docs/postmortems/2026-09-12-mobile-safari-scroll-ownership.md) — phone momentum/keyboard drift; one visual viewport owner and an internal transcript scroller
- [docs/postmortems/2026-09-16-e2e-fake-inference-tls-reset.md](docs/postmortems/2026-09-16-e2e-fake-inference-tls-reset.md) — transient TLS reset from the hosted mock inference service hung an undeadlined diagnostic dump until the job timeout erased the run's evidence
- [docs/postmortems/2026-09-16-terminal-shade-stale-scrollend.md](docs/postmortems/2026-09-16-terminal-shade-stale-scrollend.md) — terminal shade E2E latched a stale `scrollend` from an earlier write instead of the wheel's own scroll
- [docs/postmortems/2026-09-15-postgres-e2e-port-collision.md](docs/postmortems/2026-09-15-postgres-e2e-port-collision.md) — fixed PostgreSQL host-port collision prevented 55 store contracts from running
- [docs/postmortems/2026-09-15-find-keyboard-navigation.md](docs/postmortems/2026-09-15-find-keyboard-navigation.md) — fleet Find selected a project instead of the expected orb in keyboard-navigation E2E
- [docs/postmortems/2026-09-15-native-personal-instructions-fixture.md](docs/postmortems/2026-09-15-native-personal-instructions-fixture.md) — mandatory boot read missing from the native validator's strict broker; release stopped before apply
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
- [docs/postmortems/2026-09-14-idle-stop-admission-race.md](docs/postmortems/2026-09-14-idle-stop-admission-race.md) — forced late child admission exposed a missing runtime fence before idle-stop drain
- [docs/postmortems/2026-09-16-webkit-cache-readiness.md](docs/postmortems/2026-09-16-webkit-cache-readiness.md) — cold-history readiness assertions require protocol synchronization, not navigation timing
- [docs/postmortems/2026-09-15-docker-snapshot-validation-failure.md](docs/postmortems/2026-09-15-docker-snapshot-validation-failure.md) — missing Docker parent snapshot blocked four full-slice qualification scenarios; later builds do not clear the failure
- [docs/postmortems/2026-09-14-webkit-compositor-validation-crash.md](docs/postmortems/2026-09-14-webkit-compositor-validation-crash.md) — native WebKit compositor fault during local qualification; passing isolated probes do not clear it
- [docs/postmortems/2026-09-09-local-e2e-docker-startup.md](docs/postmortems/2026-09-09-local-e2e-docker-startup.md) — wrong containerd store and interrupted local validation; preserve evidence and owned fixtures
- [docs/postmortems/2026-09-09-tracked-deployment-credentials.md](docs/postmortems/2026-09-09-tracked-deployment-credentials.md) — live credential confirmed in public plan archives; artifact containment and rotation status
- [docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md](docs/postmortems/2026-09-07-native-build-cancellation-cleanup.md) — interrupted release exited before builder cleanup
- [docs/references/amp-orb-lessons.md](docs/references/amp-orb-lessons.md) — lessons from Amp's “Putting an Agent in an Orb”
- [docs/EXE-DEV.md](docs/EXE-DEV.md) — the full exe.dev host-provider evaluation
- [docs/AWS-MICROVMS.md](docs/AWS-MICROVMS.md) — the full AWS Lambda MicroVMs host-provider evaluation
- [docs/PI-CODEX-E2E.md](docs/PI-CODEX-E2E.md) — Pi + mock-OpenAI-Codex E2E integration mechanism
- [docs/DETERMINED-BUG.md](docs/DETERMINED-BUG.md) — `determined` 0.4.0 cross-task-await deadlock (fixed in 0.4.1)
