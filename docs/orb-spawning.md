# In-orb spawning

## Decision (2026-09-08)

An agent can create an independent orb in its own project, provide its initial prompt, and receive its browser URL through `pi-orb spawn`. Implemented as a narrow runtime-authenticated mutation plus the existing lifecycle and durable inbox—no new worker, orchestration loop, or Pi transport.

The new orb gets a fresh default-branch checkout, normal project secrets, boot hooks, and agent configuration. Without explicit model selection it inherits the caller orb's immutable harness (`pi | claude`); its stored user time zone (including `NULL`) always comes from the same transaction-fenced caller row. It inherits neither model settings, workspace nor conversation. The prompt must include needed context and identify any pushed commits/artifacts. **Tool guidance (2026-10-15):** central `orb_spawn` explicitly states “Orbs do not share workspaces.” The orb continues if the caller stops, exits, is archived, or is deleted. Project deletion removes both.

This is not a parent/child lifecycle, result callback, worktree handoff, wait/cancel protocol, or scheduler. Cross-project creation, recursive delegation, cost quotas, and TTLs are outside this slice. The broader orchestration question remains in `docs/open-questions.md`, question 29. Agent instructions describe requested delegation, warn about fresh checkouts and compute independence, and prohibit recursive fan-out without user direction.

**Browser nesting (implemented locally 2026-10-14; not deployed):** project orb-list and individual-orb GETs expose the existing immutable caller ID as optional `OrbView.spawnedByOrb`, retaining provenance after caller archival/deletion and omitting it for non-spawned orbs. Mutation responses may omit it. Nesting is derived presentation only: same-project working parents, including stopped/failed orbs, retain working children; a missing or shelved parent releases direct working children to roots without reparenting writes. Archive membership remains independent. Rules and observability: `docs/web-ui.md`; API shape: `docs/control-plane-api.md`. No new persisted state or schema.

## Model selection (2026-10-14; not deployed)

Optional `model` is canonical `{provider,id}`: `orb_spawn({prompt:"…",model:{provider:"claude",id:"sonnet"}})`. CLI `--model claude/sonnet` parses the same tuple. Provider selects the harness (`openai-codex` → Pi, `claude` → Claude). Omission preserves inherited harness/time zone and fresh-session defaults, never the caller's model. Malformed input and unsupported providers reject before acceptance.

**User-approved persistence (question 79):** migration `046_orb_initial_model.sql` adds only nullable `orbs.initial_model` JSONB, a closed immutable `{provider,id}` committed with creation. It supplies initial settings before fresh central/Pi/Claude input. Retained native settings override it; an uninitialized Pi header has no settings to override.

**Structural decision:** the request carries exact initial settings, not a selector requiring alias resolution. Before new acceptance, one availability check consults only the requested provider under the project owner: Pi uses its shared eligible-model policy and the existing owner credential broker; Claude uses `ClaudeSubscriptionAuth.grant` and an input-free SDK `supportedModels()` control query without a persisted session. No preflight constructs an orb or agent session. Invalid/unadvertised/disconnected models return `invalid_request`; lookup failures return retryable `unavailable`. Neither creates work. The project owner observed before the async check is fenced under the existing project lock before acceptance.

**Bootstrap contract (2026-10-15):** native boot-context omits `initialModel` exactly when stored intent is null; otherwise it carries the exact canonical `{provider,id}`. Present null or malformed refs reject. Absence means no bootstrap intent. Central composition supplies the same intent through its existing `initialSettings`. Only fresh native state is seeded. Native `orb_spawn` and runtime HTTP share `OrbSpawnRequestSchema`; durable call identity remains outside the request.

Pi and Claude validate the effective model at startup without replacing fresh intent with a default. Central stores the exact selection; a model removed after acceptance fails durably with `no_model` at first generation, not readiness. Retained settings take precedence. Existing settings/history and lifecycle paths expose outcomes.

The existing acceptance hash covers prompt, normalized name and canonical model (or null). The existing spawn-caller read identifies accepted IDs, which skip mutable availability checks; only the atomic store decides retry equality/conflicts. Identical retries use the same atomic store operation and caller/project/target fences; changing model conflicts independently of mutable settings, credentials or catalogs. The original project-owner authorization remains under the project/caller locks.

Rejected: merged cross-provider catalogs, alias resolution and child-intent rehydration for retries. Exact canonical input needs none of them. Native settings alone cannot store initial intent: a crash between acceptance and bootstrap would lose it. Prompt-embedded intent and a post-acceptance setter likewise lose atomicity/authority.

## CLI

```sh
pi-orb spawn --prompt 'Implement the parser tests and push your branch.'
pi-orb spawn --prompt-file task.md --name 'Parser tests' --json
pi-orb spawn --prompt-file - < task.md
pi-orb spawn --prompt 'Review the parser.' --model openai-codex/gpt-6.1-sol
```

Exactly one prompt source is required. Input is nonempty UTF-8 text; the serialized request has a 1 MiB byte limit, below the existing inbox limit. File/stdin reads are bounded. `--name` uses normal name validation and normalization.

Default stdout is one absolute browser URL and a newline. `--json` returns `{ orbId, projectId, url, messageId }`. Diagnostics go to stderr. Success means orb creation and the initial message committed durably, not that boot, credentials, or task execution succeeded. No browser needs to connect to trigger startup or delivery.

`--id <uuid>` selects the new orb ID and doubles as the retry key. Without it, the CLI generates a UUID before sending. The initial message ID equals the orb ID (inbox IDs are scoped to an orb). UUIDs are canonicalized to lowercase.

For simplicity the CLI makes **one** request with a 10-second deadline and no automatic retry/backoff loop. A network error, malformed response, or lost response reports **unknown acceptance** and the `--id` to reuse with the same prompt/name/model. A retryable server error also reports that ID. A definite validation, authority, or lifecycle conflict is a nonzero exit, not success. Exit classes are 2 invalid input, 3 unauthorized, 4 conflict/missing, 6 retryable/unknown, and 7 internal failure. This replaces the initial proposal for bounded internal retries: explicit stable-ID retries need no new scheduling machinery.

`pi-orb orbs` and `pi-orb transcript <id>` already provide discovery and replicated progress inspection. The returned browser URL shows existing startup, inbox, failure, and transcript state. There is no completion notification back to the caller.

**Spawn relations (2026-10-14):** native `orb_self` and `pi-orb self [--json]` expose historical `spawnedByOrb:{id,url}|null` and required `children:[{id,name:string|null,url}]`, existing direct accepted targets ordered by ID. Archived/deleting children remain until removed; deleted targets and grandchildren are omitted; empty means `[]`. Both paths use a shared application service/store port over existing `orb_spawns`, with no new persistence or lifecycle coupling (`docs/control-plane-api.md`). Alerts address the issuing orb's user, not its parent; inspect child progress with `orb_transcript` or `pi-orb transcript <id>`.

**Provenance naming (decided 2026-10-18):** APIs and domain/UI fields use `spawnedByOrb` to distinguish orb provenance from a local subagent's parent agent. Browser views retain the optional caller ID; self-inspection retains `{id,url}|null`. Storage and provenance semantics are unchanged.

## Runtime API

```text
PUT /runtime/v1/orbs/:orbId/spawn
Authorization: Bearer <existing per-incarnation runtime bearer>

{ "prompt": "...", "name": "optional name", "model": { "provider": "claude", "id": "opus" } }

202, Cache-Control: no-store
{ "orbId": "...", "projectId": "...", "url": "https://browser.example/orbs/...", "messageId": "..." }
```

Extra body fields are rejected. The caller and project come from the bearer, not caller-selected project/repository fields. New requests and retries require a running caller whose current token hash/incarnation still match and whose discard fence is absent. Authentication is rechecked at the transaction's mutation boundary, fencing stop/archive/deletion and compute replacement.

The transaction locks the project first, matching project deletion's lock order, then the caller. A deleting project cannot gain work. It inserts the `creating` orb with the caller's stored `user_time_zone`, its queued inbox row, and an immutable `orb_spawns` acceptance record together. Retry uses the accepted orb rather than resampling the caller's zone; no extra snapshot table or column is needed. `creating` already means startup is requested, so the inbox row has the ordinary creating-orb `auto_start = false`; it does not carry an extra future restart intent. Normal reconciliation and delivery survive process loss, including death before the post-commit nudge.

Migration `014_orb_spawns.sql` adds the acceptance table. It records source ID/incarnation, target ID, project ID, acceptance time, and SHA-256 of the prompt/normalized-name/canonical-model request. No prompt or bearer value appears in the acceptance log/table. The prompt lives only in the inbox and ordinary replicated history. The target ID is also the message ID, so no redundant message column is required.

Identical retries by the same currently authorized caller return the original IDs without inserting or redelivering. Comparison uses the immutable acceptance fingerprint, not mutable orb names or delivery state. A changed body/caller, unrelated target ID collision, deleted target, or archiving/archived/deleting target returns 409. Caller incarnation is recorded as provenance but not the retry key: a currently authorized replacement incarnation of the same caller may recover an ambiguous operation. A retired bearer never regains authority.

Acceptance rows have no caller/target foreign key: deleting either orb must not cascade to the other, erase provenance, or permit silent recreation of deleted work. They remain project-owned retry tombstones until project deletion removes them by cascade. They contain IDs/fingerprint only, not retained conversation content.

The browser URL uses the existing validated `PI_ORB_APP_ORIGIN` configuration plus `/orbs/<id>`. It is never derived from the runtime-only service URL or request Host header. Split roles require the configured browser origin; combined local deployments default to the control-plane origin. When using a separate local frontend, configure `PI_ORB_APP_ORIGIN` to that frontend's origin. The full-slice E2E explicitly builds and serves the real frontend to validate the returned URL, rather than assuming an API-only test process serves the app.

Expected failures use Result/ResultAsync and the existing sanitized runtime command error envelope. Invalid input is 400, rejected identity 401, lifecycle/body conflict 409, unavailable storage 503/retryable, and invariant/corruption 500/non-retryable. Immediate platform boundaries contain filesystem/fetch exceptions. Prompt/bearer bodies are never diagnostic log fields.

## Rejected alternatives

- Browser `/api/v1/*` calls from the CLI: production injects the runtime-only service URL, which deliberately does not register browser routes.
- Two calls, create then send: a caller crash between them strands a promptless orb. Sequential server calls have the same defect. Acceptance is one store transaction.
- A separate spawn worker or direct SDK prompt injection: normal lifecycle and inbox delivery already supply crash recovery and durable delivery.
- Full subagent orchestration in this slice: not needed to launch independent work and receive a URL.

## Observability and validation

`orb_spawns` is durable, queryable acceptance/provenance, committed with the work. `lifecycle: ... spawn-accepted` adds a source/target/message/project/harness/model edge only on first acceptance; retries produce no duplicate edge. Existing user-visible lifecycle and inbox errors explain boot/delivery failure at the URL. CLI diagnostics distinguish rejection from unknown acceptance.

Tests cover concurrent identical/conflicting submissions, write failpoints, response loss and process restart, caller stop/replacement/discard, project deletion, and unattended startup/delivery after caller archival and loss of the nudge. Shared in-memory/PGlite/PostgreSQL store contracts verify retry stability after rename/delivery changes and authority fencing. Driver tests force the last SQL write to fail and prove rollback leaves neither orb nor message, then verify provenance retention and deletion-safe retry tombstones. CLI/HTTP tests cover parsing, file/stdin limits, stdout/JSON, bearer use, URL origin, and sanitized failures. Full-slice E2E spawns through the installed in-orb shim, observes the mock agent finish without a browser connection, retries without duplicate input, opens the real browser URL, and deletes all work through project deletion.

Validation on 2026-09-08: `npm test` passed 1,491 unit/DST tests plus the infrastructure suites; all 41 real PostgreSQL store contracts passed; lint and typechecking passed. `PI_ORB_E2E_BACKEND=process npm run test:e2e` passed all 10 applicable tests (including all four full-slice legs and the real browser URL check); two Docker-only tests were skipped because this environment has no Docker daemon. No deployment was performed.

The guarantee is atomic acceptance plus existing inbox delivery semantics, not exactly-once external tool effects. Initial red-test traces remain in `test-failures/`. The unattended DST fixture initially omitted `FakeWorld.configureOrb`, producing repeatable provision failures; replay established the fixture defect before adding the explicit world configuration. The first E2E URL check also exposed an API-only harness assumption (404 at the app root); building/serving the actual frontend fixes that test boundary rather than weakening the URL assertion. The next run reached archival and exposed forward-only mock rule ordering: child execution/notification skipped archive rules. Ordering task → notification → archive and explicitly awaiting the notification request fixes the script; evidence and invariant are recorded in `docs/testing.md`.
