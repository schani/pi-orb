This is an awesome project! I use it every day, and I'm so glad you're helping me build it. Thank you!!!

## Project stage: proof of concept

pi-orb is still a POC (noted 2026-08-03). Do not build backwards-compatibility machinery unless explicitly asked: no deprecated route aliases, no dual-read/dual-write phases, no multi-deploy migration choreography. Breaking changes to internal contracts (runtime routes, protocol schemas, env contracts) ship directly; running orbs that break on an old contract are simply stopped and restarted. SQL schema migrations (`adapters/pg/migrations/*.sql`) remain the normal way to change the database — this note is about compatibility staging, not about avoiding migration files.

## Design documentation

The design docs are the source of truth for pi-orb's evolving design. `DESIGN.md` is the entry point: purpose, scope, product decisions, the architecture overview, and an index of the topical docs under `docs/` (one per subsystem: host provider, lifecycle, runtime protocol, history/replication, Pi adapter, control-plane API, web UI, credentials, deployment, testing, stack). Incident forensics live in `docs/postmortems/`, undecided design questions in `docs/open-questions.md`, and actionable work in `TODO.md`.

Whenever a conversation or implementation changes a requirement, decision, proposal, rejected approach, experimental finding, or open question:

1. Update the relevant `docs/` file in the same task. Do not let implementation silently diverge from the docs.
2. Distinguish clearly between decisions (dated), current proposals, and unresolved questions. Preserve important rationale and evidence, not just the latest conclusion — rejected alternatives stay next to the decision that rejected them.
3. Keep interfaces and examples synchronized with the surrounding prose.
4. Open questions live only in `docs/open-questions.md`. Numbering is frozen and append-only: mark resolved in place, never renumber or delete, because code and docs reference questions by number.
5. Actionable items (bugs, hardening, agreed follow-ups) live only in `TODO.md`: no TODO/FIXME comments in code, no TODOs buried in design prose. An item lives in exactly one of `TODO.md` / `docs/open-questions.md`; when a question is decided and the decision implies work, mark it resolved there and move the work to `TODO.md` in the same edit.
6. Incident forensics get a file in `docs/postmortems/`; the design doc keeps the resulting rule or invariant plus a link.
7. Reference docs by path (for example `docs/credentials.md`), never by section number. When adding a doc, add it to the index in `DESIGN.md`.

## Missing resources

When a requested resource does not exist, preserve the requested URL and show a clear resource-specific “doesn't exist” message with a link back to the dashboard. Never silently redirect a missing resource to the dashboard. Apply this consistently to all resource types and unknown application routes.

## Error handling

Do not use exceptions for expected or recoverable control flow. First-party fallible APIs return `neverthrow` `Result` or `ResultAsync` with explicit discriminated error types.

When third-party or platform code can throw or reject, catch it at the immediate adapter boundary with `Result.fromThrowable`, `ResultAsync.fromThrowable`, or an equally narrow wrapper and map it to a typed error. Do not let raw exceptions, rejected promises, or untyped `Error` objects cross into first-party domain code. Use exceptions only where a framework contract requires them, and document narrow lint overrides.

## Testing

Deterministic simulation testing with the `determined` package is a first-class design constraint. Keep concurrency-critical logic, clocks, persistence, runtime transport, and host lifecycle behavior behind simulation-friendly boundaries. New state machines and retry/reconciliation logic must include deterministic scheduling checkpoints, failpoints where appropriate, invariant-focused tests, and reproducible failure traces.

Run `npm run test:e2e` before deploying any change that touches the runtime protocol, the runtime HTTP/WebSocket server, or the agent harness — the unit suite does not exercise the browser↔runtime handshake end to end (learned 2026-08-04: a partially-scoped snapshot gate rejected every first message with `stale_head`; only the E2E path covers that flow). The E2E runs on macOS Docker Desktop as well as Linux/OrbStack (fixed 2026-08-06 — loopback port publishing plus `host.docker.internal`; docs/host-provider.md).

No test may be flaky. A failure that does not reproduce on every run is evidence of an uncontrolled schedule, resource collision, or environmental assumption — never noise. It blocks deployment until it is root-caused; a passing rerun does not clear it. Never rerun merely to obtain green, weaken an assertion blindly, or hide the failure with a larger timeout. Preserve the first failure evidence, identify whether the defect is in the product, test synchronization, or harness isolation, and fix that cause with explicit deterministic synchronization or resource ownership wherever possible.

For a DST failure, replay the recorded trace from `test-failures/` (`DST_REPLAY=<trace> npx vitest run …`) before any fix, understand the interleaving, and only then decide whether the defect is in the product or in the scenario's assumptions. Never delete the trace to make the suite pass.

## Observability

For every feature, before it ships, ask: **if something goes wrong with this feature in the field, what observability will we wish we had?** Then implement that observability as part of the feature, not as a follow-up. Concretely: decisions taken by autonomous machinery (reconcilers, boot hooks, guards) must be reconstructable afterwards from durable, queryable places — the `lifecycle:` event log, replicated history records, persisted columns — never only from ephemeral process stdout or guest logs; and outcomes that affect the user must be visible to the user in the product, not just to operators — a guard that declines silently is invisible at exactly the moment someone asks "why did nothing happen?". Respect the noise rules in `docs/lifecycle.md`: edges, not levels; a healthy fleet logs nothing.
