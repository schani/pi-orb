# Agent Instructions

## Project stage: proof of concept

pi-orb is still a POC (noted 2026-08-03). Do not build backwards-compatibility machinery unless explicitly asked: no deprecated route aliases, no dual-read/dual-write phases, no multi-deploy migration choreography. Breaking changes to internal contracts (runtime routes, protocol schemas, env contracts) ship directly; running orbs that break on an old contract are simply stopped and restarted. SQL schema migrations (`adapters/pg/migrations/*.sql`) remain the normal way to change the database — this note is about compatibility staging, not about avoiding migration files.

## Living design document

`DESIGN.md` is the source of truth for pi-orb's evolving design.

Whenever a conversation or implementation changes a requirement, decision, proposal, rejected approach, experimental finding, or open question:

1. Update `DESIGN.md` in the same task.
2. Distinguish clearly between decisions, current proposals, and unresolved questions.
3. Remove or revise stale open questions when they are answered.
4. Preserve important rationale and evidence, not just the latest conclusion.
5. Keep interfaces and examples synchronized with the surrounding prose.

Do not let implementation silently diverge from `DESIGN.md`.

## Error handling

Do not use exceptions for expected or recoverable control flow. First-party fallible APIs return `neverthrow` `Result` or `ResultAsync` with explicit discriminated error types.

When third-party or platform code can throw or reject, catch it at the immediate adapter boundary with `Result.fromThrowable`, `ResultAsync.fromThrowable`, or an equally narrow wrapper and map it to a typed error. Do not let raw exceptions, rejected promises, or untyped `Error` objects cross into first-party domain code. Use exceptions only where a framework contract requires them, and document narrow lint overrides.

## Testing

Deterministic simulation testing with the `determined` package is a first-class design constraint. Keep concurrency-critical logic, clocks, persistence, runtime transport, and host lifecycle behavior behind simulation-friendly boundaries. New state machines and retry/reconciliation logic must include deterministic scheduling checkpoints, failpoints where appropriate, invariant-focused tests, and reproducible failure traces.

DST tests must never be flaky. A DST failure that does not reproduce on every run is not noise — it is a schedule the scenario cannot survive, and it must be root-caused before any fix: replay the recorded trace from `test-failures/` (`DST_REPLAY=<trace> npx vitest run …`), understand the interleaving, and only then decide whether the defect is in the product or in the scenario's assumptions. Never "fix" DST flakiness by rerunning, loosening assertions blindly, or deleting the trace.

