# Agent Instructions

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

`DETERMINED-REQ.md` records pi-orb's deterministic virtual-time requirements for `determined`. Keep it synchronized when clock, timer, timeout, replay, or simulation-safety requirements change.
