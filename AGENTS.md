This is an awesome project! I use it every day, and I'm so glad you're helping me build it. Thank you!!!

## Project stage: proof of concept

pi-orb is still a POC (noted 2026-08-03). Do not build backwards-compatibility machinery unless explicitly asked: no deprecated route aliases, no dual-read/dual-write phases, no multi-deploy migration choreography. Breaking changes to internal contracts (runtime routes, protocol schemas, env contracts) ship directly; running orbs that break on an old contract are simply stopped and restarted. SQL schema migrations (`adapters/pg/migrations/*.sql`) remain the normal way to change the database — this note is about compatibility staging, not about avoiding migration files.

## Simplicity

Always consider simplicity an important criterion when planning and building. Prefer the smallest design that satisfies the actual requirements; question whether a problem can be removed instead of managed. Avoid speculative configurability, extra state machines, and compatibility machinery without a demonstrated need. When simplifying, remove obsolete code, options, tests, and documentation together while preserving safety and observability.

Discuss any change or addition to persisted state with the user before implementing it.

## Design documentation

All changes to prompts must be approved by the user before implementation.

Docs describe the current design, not its history. `DESIGN.md` is the entry point: purpose, scope, architecture and the doc map. Topical docs live under `docs/`, incident forensics in `docs/postmortems/`, undecided questions in `docs/open-questions.md`, actionable work in `TODO.md`. Git, PR descriptions and postmortems hold history.

When a task changes a requirement, decision or contract, update the owning doc in the same task:

1. One owner per fact. State each fact in exactly one doc; elsewhere link to it, never restate it.
2. Rewrite, don't append. Replace superseded text so the doc reads as the current state. Organize by topic, never by date; no dated section headings. A rejected alternative gets at most two lines next to the decision that rejected it.
3. No status in docs: no deployed, undeployed, local, qualified or authorized stamps, and no qualification logs, test counts, run IDs or SHAs. Deployment state is the deployed revision versus git; evidence belongs in PR descriptions or postmortems. Agreed design that is not yet built says so once at the top of its section and has a `TODO.md` item.
4. Keep interfaces and examples synchronized with the surrounding prose.
5. Open questions live only in `docs/open-questions.md`. Numbering is frozen: never renumber or delete, because code and docs reference questions by number. A resolved question shrinks to one line naming the owning doc.
6. Actionable items live only in `TODO.md`, one line each plus links, with no evidence and no done items: no TODO/FIXME comments in code, no TODOs in design prose. An item lives in exactly one of `TODO.md` / `docs/open-questions.md`; when a decided question implies work, mark it resolved and move the work to `TODO.md` in the same edit.
7. Incident forensics get a file in `docs/postmortems/`; the owning doc keeps only the resulting rule plus a link.
8. Evidence links must resolve: tracked files, GitHub Actions runs or hosted-file URLs, never `.context/`, `/tmp/` or `/workspace/` paths.
9. Reference docs by path (for example `docs/credentials.md`), never by section number. When adding or removing a doc, update the map in `DESIGN.md`.

## Audience

This project is for one person. The UI does not need to explain itself, and it must not repeat itself: no orientation copy, no help text, no legends, no label next to an icon that already says the same thing, no fact shown in two places on one screen.

## Missing resources

When a requested resource does not exist, preserve the requested URL and show a clear resource-specific “doesn't exist” message with a link back to the dashboard. Never silently redirect a missing resource to the dashboard. Apply this consistently to all resource types and unknown application routes.

## Error handling

Do not use exceptions for expected or recoverable control flow. First-party fallible APIs return `neverthrow` `Result` or `ResultAsync` with explicit discriminated error types.

When third-party or platform code can throw or reject, catch it at the immediate adapter boundary with `Result.fromThrowable`, `ResultAsync.fromThrowable`, or an equally narrow wrapper and map it to a typed error. Do not let raw exceptions, rejected promises, or untyped `Error` objects cross into first-party domain code. Use exceptions only where a framework contract requires them, and document narrow lint overrides.

## Testing

Install repository dependencies with `npm ci` before running checks or starting the frontend. `npm run` does not install dependencies; if a local tool such as `tsc` is missing, install dependencies and continue validation rather than reporting the missing tool as a blocker.

Deterministic simulation testing with the `determined` package is a first-class design constraint. Keep concurrency-critical logic, clocks, persistence, runtime transport, and host lifecycle behavior behind simulation-friendly boundaries. New state machines and retry/reconciliation logic must include deterministic scheduling checkpoints, failpoints where appropriate, invariant-focused tests, and reproducible failure traces.

Run `npm run test:e2e` before deploying any change that touches the runtime protocol, the runtime HTTP/WebSocket server, or the agent harness — the unit suite does not exercise the browser↔runtime handshake end to end (learned 2026-08-04: a partially-scoped snapshot gate rejected every first message with `stale_head`; only the E2E path covers that flow). The E2E runs on macOS Docker Desktop as well as Linux/OrbStack (fixed 2026-08-06 — loopback port publishing plus `host.docker.internal`; docs/host-provider.md).

No test may be flaky. A failure that does not reproduce on every run is evidence of an uncontrolled schedule, resource collision, or environmental assumption — never noise. It blocks deployment until it is root-caused; a passing rerun does not clear it. Never rerun merely to obtain green, weaken an assertion blindly, or hide the failure with a larger timeout. Preserve the first failure evidence, identify whether the defect is in the product, test synchronization, or harness isolation, and fix that cause with explicit deterministic synchronization or resource ownership wherever possible. This rule always holds, unless the user explicitly makes an exception.

Approved exceptions for specific historical failures are listed in `docs/testing.md`. Each covers only its named failure; new failures, exact-head qualification, assertions and DST replay/root-cause requirements are never waived.

For a DST failure, replay the recorded trace from `test-failures/` (`DST_REPLAY=<trace> npx vitest run …`) before any fix, understand the interleaving, and only then decide whether the defect is in the product or in the scenario's assumptions. Never delete the trace to make the suite pass.

## Observability

For every feature, before it ships, ask: **if something goes wrong with this feature in the field, what observability will we wish we had?** Then implement that observability as part of the feature, not as a follow-up. Concretely: decisions taken by autonomous machinery (reconcilers, boot hooks, guards) must be reconstructable afterwards from durable, queryable places — the `lifecycle:` event log, replicated history records, persisted columns — never only from ephemeral process stdout or guest logs; and outcomes that affect the user must be visible to the user in the product, not just to operators — a guard that declines silently is invisible at exactly the moment someone asks "why did nothing happen?". Respect the noise rules in `docs/lifecycle.md`: edges, not levels; a healthy fleet logs nothing.

# Tests and telemetry

Always write tests first, and make sure there is enough telemetry to judge success and diagnose failure.

# Design proposals

When I ask for design proposals, always use the existing pi-orb UI look&feel and design language, unless explicitly asked not to. Produce an HTML and share that with me.

# Plans

When I ask you for a plan, just give it to me, don't put it in an HTML or something, unless I ask for that.

# Keep it simple

Don't overbuild, neither in production nor in test code!

# Babysitting PRs

When the user asks you to babysit a PR:

- Make sure the PR only includes files that are actually needed.
- Run a sol loop.
- Monitor CI. If it fails, fix it.
- Once CI is green, merge the PR.
