# Testing strategy

## Decisions

- Deterministic simulation testing is a first-class requirement from the beginning, not a later hardening phase.
- We will use the TypeScript [`determined`](https://www.npmjs.com/package/determined) package.
- Concurrency-critical domain code should accept its simulation/task abstractions so the same code runs with controlled scheduling and entropy in tests and `noSimulation` in production.
- The simulation boundary is each application's `domain/` directory; everything effectful sits behind adapter interfaces that simulations replace with deterministic fakes.
- Failing entropy traces must be recordable and exactly replayable.
- Explicit failpoints and scheduling checkpoints should cover replication, lifecycle, retry, reconciliation, and shutdown races.
- DST complements rather than replaces normal unit, database integration, Docker, browser, and eventual GCE tests.

## Deterministic simulation testing strategy

The [`determined`](https://www.npmjs.com/package/determined) package provides cooperative deterministic scheduling, reproducible entropy, failpoints, blocking primitives, deadlock detection, and exact record/replay of failing schedules. pi-orb does not require timed mutex or condition-variable APIs: it coordinates with database compare-and-swap, explicit lifecycle state, serialized in-process mutation queues, and cancellable adapter operations. Virtual sleep/deadline timers only need to participate correctly in scheduler quiescence and cancellation.

The architecture should keep side effects behind adapters and put concurrency/state-machine logic in simulation-compatible code. Initial high-value simulation targets are:

- repeated and delayed history pulls;
- runtime or database failure before a poll transaction commits;
- a polling worker crashing immediately before or after commit;
- overlapping pollers reading the same orb cursor;
- incomplete streaming records becoming complete between pulls;
- history load racing with live subscription;
- parent records arriving after children;
- controlled stop racing with newly completed agent output;
- pull-derived liveness and readiness health checks racing with stop/restart decisions;
- a non-retryable replication-integrity failure or a runtime restart during a pending drain;
- repeated provider operations and control-plane recovery after partial failure;
- concurrent orb starts sharing one OAuth device flow, OAuth completion/failure, and restart while login is pending;
- multiple reconcilers observing and acting on the same orb.

Simulation tests should:

1. run many entropy-driven schedules and failpoint combinations;
2. save the full entropy trace and relevant test configuration on failure;
3. verify that the saved trace reproduces the same failure;
4. make replaying a captured failure a simple test command;
5. assert invariants, not only expected happy-path outputs.

Important invariants include no cursor advancement without the corresponding database commit, stable native record IDs across repeated pulls, no omission of complete records after a cursor, no return of incomplete records, idempotent retries, no host stop after a retryably failed pre-stop pull (an integrity failure stops the host only together with the transition to `failed`), at most one authoritative host per orb, and no transition from a failed health observation directly into an idle stop decision.

`determined` controls cooperative scheduling and entropy, but not wall-clock time or external systems by itself. Core code also needs injectable clocks/timers and simulated adapters for the database, runtime transport, and host provider. Real integration tests remain responsible for validating adapter behavior.

For end-to-end tests, the one external dependency that cannot be exercised as-is is OpenAI (Codex OAuth plus the model backend). A scripted mock service exists (deployed at `fake-openai.flingit.run`; per-test isolated sessions with their own OAuth/inference base URLs, a scenario API, device-login approval, and received-request assertions). [`docs/PI-CODEX-E2E.md`](docs/PI-CODEX-E2E.md) records the decided integration mechanism: override the `openai-codex` provider via `registerProvider` with the mock `baseUrl` and a custom `oauth` implementation (`packages/mock-openai`) — a supported injection point, not DNS or fetch interception. E2E mode activates only when `PI_ORB_FAKE_OPENAI_OAUTH_URL` and `PI_ORB_FAKE_OPENAI_INFERENCE_URL` are set; the control plane routes its auth gate through the mock and passes the same variables into every orb container, and production never registers the override.

The implemented E2E test (`e2e/`, run with `npm run test:e2e`) drives the full end-to-end success case (below) against real PostgreSQL, real Docker, and the real Pi SDK: device login approved through the mock's control API, a scripted turn whose tool call executes real bash inside the orb, streamed reasoning/tool frames over the live proxy, history replication verified in the database, and the controlled-stop drain with database-served history afterward. It clones the public pi-orb repository itself as the project under test. One integration constraint discovered while building it: the control plane's `ModelRuntime` must be created with `allowModelNetwork: false`, because `ModelRuntime.login` otherwise follows a successful login with a network model-availability sweep across all providers that can stall the device flow for minutes; the control plane resolves auth only and never needs the catalog.

The simulation boundary is decided: it is each application's `domain/` directory, mechanically enforced. Domain code imports only `determined`, `neverthrow`, and first-party interface types — no `pg`, Docker, `fetch`, Fastify, React, or Pi SDK imports — and every state machine receives `(task, clock, deps)`, where `deps` are the repository, host-provider, and runtime-client interfaces. Fastify handlers and UI code sit outside the simulation and are tested conventionally as thin folds over domain results. The control plane owns one shared deterministic test kit: in-memory repository, host-provider, and runtime-client fakes with simulated latency and failure injection, plus named failpoint constants, so all state-machine tests share the same fixtures and failure vocabulary. The kit's acceptance test is the concurrent-poller race: two pollers read the same cursor, both pull, the loser's compare-and-swap affects zero rows, and the replica ends with no duplicate or missing record.

State-machine timing uses two distinct patterns:

- periodic reconciliation waits with cancellable deterministic sleeps; in-process durations use `monotonicNow()`, while restart-stable deadlines derived from `state_changed_at` compare against injected `wallNow()`;
- each finite I/O/process/provider operation runs through a deadline helper that passes an `AbortSignal` into the adapter and always cancels its timer when the operation settles.

Code never `await`s an `AbortSignal` directly. APIs such as `fetch`, `execFile`, and simulated adapter sleeps observe it. A low-level cancellable-sleep implementation may await the signal's abort event internally. Avoid a bare `Promise.race` whose losing operation continues unobserved.

Baseline GitHub CI runs for every pull request and every push to `main`, using Node 24 and the committed npm lockfile. A single required checks job installs with `npm ci`, then runs the repository-wide typecheck, lint, and test scripts. Entropy-iteration budgets and deterministic failure-trace retention remain open.

Decided 2026-08-05 (from `docs/postmortems/2026-08-05-unreachable-restart-livelock.md`): **the fake world models host boot latency and preemption.** `FakeWorld` used to boot a host into a serving runtime instantaneously, which made every restart look free and hid a production livelock for as long as the feature existed — the reconciler's inline unreachable-runtime restart granted only `unreachableGraceMs` (30 s) for the runtime to come back, while a real COS VM needs ~60–70 s from `instances.start` to a serving container, so the restart path could never observe success and hard-stopped a booting VM forever. The rules now are:

- a host observes `running` as soon as the provider's start operation completes, but its runtime serves nothing until `bootLatencyMs` of virtual time has passed, and a booting runtime is indistinguishable from a dead one (health checks and history pulls both see an unreachable runtime);
- the measured 65 s applies to **every** scenario: no scenario opts out (`FakeOrbConfig.bootLatencyMs` remains tunable, but nothing sets it). While the livelock was unfixed, a dozen scenarios needed an instant-boot opt-out because any scheduler-legal liveness lapse in `running`/`stopping` livelocked them; with the 2026-08-06 fix (`docs/lifecycle.md`) all of them survive a real boot. A lapse now costs a restart that re-enters `starting`, so a scenario holding an orb in `running` must distinguish "left `running`" from "stopped" in its assertions;
- `seedRunningOrb` fast-forwards only the *initial* boot of the host it seeds — that host is already running by construction — and every later restart of it pays the full latency;
- `preemptHost` models a hypervisor ACPI soft-off (a Spot preemption): the runtime goes dark immediately while the instance keeps observing `running` for a soft window (30 s by default) and only then observes `stopped`. This is the race the incident lost — the liveness path beat the observation path — and a stop or start of the host in between overrides the soft-off, as in GCE;
- test lifecycle constants no longer compress the boot-related deadlines below a boot: as in production, both post-boot patience windows sit above a full boot and below the create/start deadline — `boot latency < postRestartGraceMs, unreachableBootDeadlineMs < createStartDeadlineMs`.

DST tests must never be flaky; a non-reproducing failure is a schedule the scenario cannot survive and must be root-caused from its recorded trace (`DST_REPLAY`) before any fix (also recorded in `AGENTS.md`). Standing interplay found 2026-08-03: since idle auto-stop (docs/lifecycle.md) landed, any scenario that holds an orb in `running` across long virtual stretches without busy activity or a visible tab races the test idle window — such scenarios must either simulate activity or opt out via a `makeHarness` `idleStopAfterMs` override, as the restart-recovery lifecycle tests now do. Second standing interplay, found 2026-08-06: successful pulls are the only liveness signal, so a scenario that runs a reconciler *without* `pollLoop` and holds an orb in `running` has its host restarted every grace period — correctly, since from the reconciler's side nothing has answered. A scenario that needs an orb to stay `running` (or several to be `running` at the same instant) must run the poll loop too.

## First end-to-end success case

The first vertical slice should demonstrate:

1. In the web UI, add a project with a name and public Git URL.
2. Start an orb for that project.
3. The configured `OrbHostProvider` creates an isolated persistent filesystem and runtime host; the first implementation does so with a Docker volume and container.
4. The runtime clones the repository and starts one embedded Pi session in it.
5. Send a prompt from the browser through the control plane.
6. Display assistant text, tool calls, tool results, and errors in the web UI.
7. The control plane periodically pulls complete Pi history records and persists them transactionally in PostgreSQL while live output continues.
8. Request orb stop; the control plane drains pulls until one returns no new complete records, then stops without waiting for Pi to settle.
9. Reopen the orb page and render database history immediately while the container starts.
10. Hand the browser connection to the runtime through the content-agnostic proxy and continue without duplicates or gaps.
11. Deterministically simulate temporary runtime/database failures, repeated pulls, worker crashes, concurrent pollers, and shutdown races, asserting idempotent and gap-free persistence.

“Deterministically simulate failures” means testing the replication state machine with `determined`: for example, a database transaction fails, so the stored cursor must remain unchanged and the next poll must safely return and commit the same stable record IDs. It does not mean injecting failures into the manual browser demo itself.
