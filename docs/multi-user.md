# Multi-user company deployment

## Scope (clarified 2026-09-16)

Users are trusted coworkers at one small company. Each has their own projects/orbs, Codex/GitHub credentials and personal settings. Cross-user file access is acceptable. Network security has the same trust assumptions as the current personal deployment. No adversarial-customer isolation, quotas, billing or collaboration features are required for this milestone.

**Decision (2026-09-16):** stage 1 application identity is implemented locally and not deployed. Stages 2–3 are not authorized or ready. They remain one production cutover before coworker onboarding; stage 1 must not be deployed alone merely to discover the original user's UUID. No deployment is authorized.

The initial 2026-09-15 assessment interpreted “customers” as unrelated, mutually untrusted tenants. Its hostile-tenant qualification, mandatory limits and network separation were rejected by this clarification: they solve a different problem. Existing authentication, token fencing and secret-handling safeguards remain; the smaller feature must still select the correct user's credentials and data reliably.

## Current gaps

- The local implementation resolves an application principal and makes `/api/v1/session` a no-store principal probe. The deployed revision still has the earlier reachability-only response until the authorized coordinated cutover. See `docs/deployment.md` and `docs/control-plane-api.md`.
- Projects have no owner and their names are globally unique. Orbs, history, files, secrets and MCP already have useful project/orb/connection relationships.
- Codex/GitHub broker pointers are keyed only by provider. Login gates, challenges and Pi auth storage are global. Personal instructions are a database singleton.
- Browser and in-orb lists are fleet-wide. Multi-user dashboard/default discovery behavior needs an owner scope; permitted cross-user access is not a security failure. Runtime credentials and instructions must resolve the owning user independently of whoever is viewing an orb.
- Preview configuration is deployment-wide: one Tailscale OAuth client and tailnet. This already fits a shared company tailnet. See `docs/ports.md`.

## Application identity (decided and implemented locally 2026-09-16; not deployed)

`users` has a stable UUID, a unique verified `(identity_issuer, identity_subject)`, and nullable display email. Email is mutable presentation data, never identity or authority. A trusted user request idempotently creates or resolves its row. There is no guessed-email bootstrap, first-database-user fallback, new login framework, cookie, login UI, or roles framework.

Production browser authentication verifies the IAP JWT with `google-auth-library` behind a narrow adapter. Assertions must be ES256, have issuer `https://cloud.google.com/iap`, and have the direct Cloud Run audience `/projects/PROJECT_NUMBER/locations/REGION/services/SERVICE_NAME`, configured as `PI_ORB_IAP_AUDIENCE`. Missing or cryptographically invalid assertions are domain `unauthenticated` failures and return 401. Verification-key or database availability failures return 503; store invariants return 500. The adapter catches library throws/rejections immediately and returns typed `neverthrow` results.

The verification-key adapter coalesces concurrent fetches and honors provider `max-age`, capped at one hour; absent cache guidance falls back to five minutes. Its HTTP timeout is five seconds. A fresh cache miss for an unknown key ID can force one refresh per cache, with a global 30-second cooldown to prevent attacker-selected key IDs from causing repeated provider traffic.

Every covered application request receives one principal:

```ts
type Principal =
  | { kind: "user"; user: { id: string; email: string | null } }
  | { kind: "ops"; id: string };
```

All browser API, hosted-file, OAuth callback, live WebSocket and terminal WebSocket endpoints require the principal appropriate to the serving role: user on `browser`/`all`, ops on `ops`. Static assets do not resolve a database principal. Runtime bearer routes and the public issuer remain separate authentication surfaces. `/api/v1/session` returns one shape with `Cache-Control: no-store`:

```ts
{ status: "ok", principal: { kind: "user", user: { id, email } } }
{ status: "ok", principal: { kind: "ops", id } }
```

Issuer and subject stay server-only. Stage 1 establishes identity, not project scope or authorization; global credentials and personal instructions remain current.

The local `all` composition explicitly uses fixed identity `pi-orb:local/developer` and has no Google login. Tests inject fixed Alice/Bob identities. The cloud `ops` role authenticates only as the machine principal configured by `PI_ORB_OPS_PRINCIPAL=serviceAccount:pi-orb-debug@<project>.iam.gserviceaccount.com`, under existing Cloud Run invoker IAM. It neither infers a human nor calls the user store. Existing orb operations will eventually derive their user from project ownership; any new user-owned ops operation must require an explicitly selected user.

Layering stays explicit: composition selects the role adapter; the IAP adapter verifies third-party input and the PostgreSQL adapter resolves the user; the domain resolver composes typed results; the HTTP guard maps only the resulting discriminated errors and attaches the principal before route handlers run. Browser handlers do not call identity storage or Google verification directly.

The original user is not seeded from a guessed email. The first verified user request creates the user row. Stage 2 will map existing ownership explicitly during the single controlled production cutover, using the UUID obtained from that verified request. The exact cutover procedure is a mechanical stage-2 detail, not a stage-1 bootstrap or product question. Stage 1 can be tested locally without deployment.

## Minimal schema

| Table | Change |
| --- | --- |
| `users` (new; stage 1) | Stable UUID plus unique verified `(identity_issuer, identity_subject)` and nullable display email. |
| `projects` | Add `owner_user_id REFERENCES users(id)`; change name uniqueness to `(owner_user_id, name)`. |
| `credential_pointers` | Add `user_id REFERENCES users(id)`; change primary key from `provider` to `(user_id, provider)`. Existing generations, CAS versions and refresh leases become per-user. |
| `personal_instructions` | Replace the `singleton` primary key with `user_id REFERENCES users(id)`; retain content, revision and timestamp. |

That is one new table and three changed tables. The proposal assumes every orb belongs to the owner of its project; it does not introduce independent orb ownership or project transfers.

No ownership column is required on `orbs`: `orbs.project_id → projects.owner_user_id` supplies it. `history_records`, `orb_messages`, `orb_deletions`, `workspace_uploads`, `hosted_files`, `hosting_operations`, `hosting_cleanup_items` and `hosting_events` inherit through their orb. `hosting_attempts` inherits through its operation. `orb_spawns` already has a project anchor. `project_secret_pointers`, `project_mcp`, `mcp_oauth`, `mcp_oauth_events` and `mcp_oauth_garbage` already have project scope. These operations still need the right user context, but not duplicate ownership columns. `oidc_signing_keys` remains deployment-wide.

In stage 2, existing rows can be assigned by a normal SQL migration using the original user's verified UUID obtained during the controlled cutover; the migration must not guess an email or select the first user row. No compatibility staging is proposed. Current schemas are in `apps/control-plane/src/adapters/pg/migrations/`.

## Ownership and credential proposal (stages 2–3; not authorized)

Keep company IAP admission and use the stage-1 application user for project creation, default listing and personal instructions. Never use a browser-selected user ID as credential authority. Exact cross-user browsing/mutation behavior remains in `docs/open-questions.md`, question 24.

Derive the credential owner from authenticated `orb → project → owner`. That same owner supplies Codex/GitHub tokens, personal instructions and control-plane inference such as orb naming. Merely opening a coworker's orb must not switch its model/Git identity to the viewer. Same-project spawning inherits the project's owner. Refresh CAS, leases and login challenges are keyed per user/provider; concurrent users must not share one global ceremony or Pi `auth.json`. Credential errors/challenges must reach the relevant user's UI and waiting orbs without exposing tokens.

OAuth secrets remain outside PostgreSQL. Distinct user pointers can reference distinct immutable versions under the existing provider Secret Manager parents; a separate Secret Manager secret per user is not required. Version reads, refreshes and destruction must follow the correct user's pointer. Local Pi auth artifacts need per-user paths. Provider client configuration, including the GitHub App client ID/secret, can stay shared; access/refresh tokens cannot.

The GitHub App's owning-account-only installation setting does not inherently prevent employee-specific OAuth tokens for already covered company repositories. App visibility changes are necessary only if installations must cover other repository-owning accounts. Repository access still requires the user's permissions, installation coverage and App grants.

Project secrets and MCP remain project/connection scoped. Cross-user file access does not imply showing raw broker credentials; existing no-secret-browser-response rules remain. No new preview proxy, account billing, quota service or cross-customer security program is proposed.

## Tailscale options

**Recommended, not selected:** one company tailnet with employee devices and all orbs. The existing global configuration supports this topology; invite employees and permit their devices to reach `tag:pi-orb`. A new tailnet is optional if the current one is suitable for company membership. Moving existing orbs to another tailnet requires re-enrollment and cleanup of old registrations; changing the DNS suffix alone is not migration.

**Per-user tailnets:** feasible, but more application work. Store a tailnet DNS name and OAuth client configuration per user, with the client secret in the secret store. Resolve the project's owner when provisioning, minting/revoking keys, removing devices and generating preview URLs. Retain enough enrollment identity to clean up the original tailnet even after settings change. The runtime already accepts a supplied auth key/hostname/preview host and need not understand users. This is a lifecycle/configuration feature, not a database-column-only change.

**Two tailnets on a device:** the normal Tailscale client supports saved accounts and switching, with only one active tailnet at a time; it cannot transmit on both simultaneously. Separate daemon/container/VM instances can provide separate network clients, but are not ordinary desktop account switching. Machine sharing can expose selected machines across tailnets without joining both, rather than merging the networks. Sources checked 2026-09-16: [fast user switching](https://tailscale.com/kb/1225/fast-user-switching), [machine sharing](https://tailscale.com/kb/1084/sharing). No simultaneous-daemon deployment was tested here.

## Proposed delivery stages (2026-09-16)

These are implementation slices, not separate multi-user releases. Stages 1–3 form one application cutover before onboarding coworkers: partial delivery must not serve another user the original user's global credentials or instructions. No dual-read, legacy fallback or compatibility rollout is proposed. Only stage 1 is authorized; it is implemented locally. Stages 2–3 and deployment remain unauthorized.

1. **Application identity (authorized; implemented locally, not deployed).** The decided identity and principal contract above are implemented. Focused tests cover invalid assertions, key/store failures, cache timing and concurrency, repeated/concurrent identity resolution, injected user identities, route coverage, role composition and both session variants; the user-store contract also runs against real PostgreSQL 15 through `node-postgres`. Typecheck, lint, 1,789 unit tests plus infra checks, and 61 process-backed E2E tests pass; skips and qualification limits are recorded in `docs/testing.md`. Every covered operation receives its role-appropriate stable principal, ops remains machine-only, and non-browser authentication surfaces remain separate. Do not deploy this slice independently.
2. **Owned projects and personal settings.** Add `projects.owner_user_id`, per-owner project-name uniqueness and per-user `personal_instructions`; assign existing resources/settings to the original user. Scope default browser listings/creation to the signed-in user and runtime instructions to the project's owner. Preserve allowed shared-file access. Tests cover duplicate names across users, owner inheritance, next-start instruction adoption and owner selection when a coworker views an orb. Exit: two test users have independent project lists and instructions, without duplicating ownership on child tables. Cross-user UI/mutation policy remains question 24; it must be selected before implementing those surfaces.
3. **Per-user Codex/GitHub end to end.** Key `credential_pointers`, broker calls, refresh leases and login state by user/provider, with separate Pi auth artifacts. Wire ownership through both provider login flows, lifecycle prerequisites/wakeups, runtime token requests, same-project spawning and background inference. Retain shared provider client configuration and secret parents where suitable. No fallback to another user's credential. Begin with DST for simultaneous logins, refresh races, failure/re-login and version cleanup; then adapter/store and two-user browser/runtime tests. Exit: one user's credential failure neither overwrites nor blocks the other's healthy flow, and all model/Git activity uses the orb owner's identity. This is the largest slice.
4. **Company pilot and cutover.** Run the full relevant suite, including browser/runtime E2E, and verify migration assignments before deployment. Stop/restart affected orbs if internal contracts change rather than supporting old runtimes. Onboard one coworker: create same-named projects, connect distinct Codex/GitHub accounts, inspect shared files, spawn/restart orbs and confirm credential/instruction ownership. Existing typed auth errors plus sanitized user/project/orb correlation must make wrong-account and login failures diagnosable without logging secrets. Exit: both users complete that flow on the deployed service; widen company admission only after it passes.

**Parallel operational workstream:** choose preview topology (question 26). A shared company tailnet is recommended and fits current code; verify employee device access to an actual orb port. If moving to a new tailnet, qualify enrollment, retained-node re-enrollment and old-device cleanup. Per-user tailnets are a separate optional feature, not a dependency of per-user application data/credentials. The application pilot can run without previews if the tailnet choice is deferred.

Each stage includes its own tests; the pilot is not the first validation. Schema changes use normal SQL migrations; original-user ownership assignment is an explicit stage-2 cutover operation, not stage-1 guessing. No quotas, billing, teams, new preview proxy or hostile-tenant hardening is included.

## Testing scope

“Isolation qualification” in the original assessment meant proving that one unrelated customer cannot access another's resources. That is not a requirement for these trusted coworkers.

The relevant tests instead prove correct per-user behavior: default project lists and duplicate names, instruction selection, credential ownership, concurrent login/refresh, same-project spawning and control-plane inference. A runtime always gets its project's owner's credentials, even when a different user is viewing it. Refreshing or reconnecting one user's provider must not overwrite or invalidate another's credentials. Permitted shared-file access stays functional.

Use deterministic schedules for multi-user login/refresh races and existing lifecycle integrations, store contracts for schema/query changes, and browser/runtime E2E for two logged-in users. This assessment involved repository inspection and Tailscale documentation, not deployment or live security qualification. Remaining stage-2/3 product choices live in `docs/open-questions.md` (24–26). Stage 1 is locally implemented but has not changed the deployed service.
