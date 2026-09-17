# Multi-user company deployment

## Scope (clarified 2026-09-16)

Users are trusted coworkers at one small company. Each has their own projects/orbs, Codex/GitHub credentials and personal settings. Cross-user file access is acceptable. Network security has the same trust assumptions as the current personal deployment. No adversarial-customer isolation, quotas, billing or collaboration features are required for this milestone.

**Decision (2026-09-16; deployment updated 2026-09-17):** stages 1–2 application identity, owned projects, and personal settings are deployed from `ec81e80` for existing single-user use. Migration 023's owner assignment and data preservation are verified. Typed-history migration compatibility enforcement remains a follow-up (`docs/postmortems/2026-09-17-typed-history-runtime-fence.md`). Stage 3 credentials is authorized but not deployed. It must complete before coworker onboarding.

The initial 2026-09-15 assessment interpreted “customers” as unrelated, mutually untrusted tenants. Its hostile-tenant qualification, mandatory limits and network separation were rejected by this clarification: they solve a different problem. Existing authentication, token fencing and secret-handling safeguards remain; the smaller feature must still select the correct user's credentials and data reliably.

## Current gaps

- The deployed service resolves an application principal and makes `/api/v1/session` a no-store principal probe. Stage-1 production evidence remains guarded API traffic rather than a dedicated session-response or two-user test. See `docs/deployment.md` and `docs/control-plane-api.md`.
- Deployed stage 2 gives projects required owners, per-owner names and default lists, and user-keyed personal instructions. Migration verification found all three projects assigned to the selected owner and the existing personal-instructions row exactly preserved.
- Codex/GitHub broker pointers, login gates, challenges and Pi auth storage remain global until stage 3.
- Preview configuration is deployment-wide: one Tailscale OAuth client and tailnet. This already fits a shared company tailnet. See `docs/ports.md`.

## Application identity (deployed 2026-09-16 from `1fcc261`)

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

Issuer and subject stay server-only. Identity resolution is separate from the ownership scope below; credentials remain global until stage 3.

The local `all` composition explicitly uses fixed identity `pi-orb:local/developer` and has no Google login. Tests inject fixed Alice/Bob identities. The cloud `ops` role authenticates only as the machine principal configured by `PI_ORB_OPS_PRINCIPAL=serviceAccount:pi-orb-debug@<project>.iam.gserviceaccount.com`, under existing Cloud Run invoker IAM. It neither infers a human nor calls the user store. Resource-addressed operations derive user context from project ownership where needed; user-context ops operations require an explicitly selected user.

Layering stays explicit: composition selects the role adapter; the IAP adapter verifies third-party input and the PostgreSQL adapter resolves the user; the domain resolver composes typed results; the HTTP guard maps only the resulting discriminated errors and attaches the principal before route handlers run. Browser handlers do not call identity storage or Google verification directly.

The original user is never inferred from email, row order or a browser bootstrap call. Migration 023 receives an explicit trusted-operator identity tuple as described below and creates or verifies that stable mapping transactionally. Stage 1 was also qualified locally before its single-user deployment.

## Schema target

| Table | Change |
| --- | --- |
| `users` (new; stage 1) | Stable UUID plus unique verified `(identity_issuer, identity_subject)` and nullable display email. |
| `projects` | Add `owner_user_id REFERENCES users(id)`; change name uniqueness to `(owner_user_id, name)`. |
| `credential_pointers` (stage 3 proposal) | Add `user_id REFERENCES users(id)`; change primary key from `provider` to `(user_id, provider)`. Existing generations, CAS versions and refresh leases become per-user. |
| `personal_instructions` | Replace the `singleton` primary key with `user_id REFERENCES users(id)`; retain content, revision and timestamp. A valid user with no row reads implicit empty revision 0 until first write. |

One new table and three changed tables; credential changes await stage 3. Orbs inherit project ownership, without independent owners or transfers.

No ownership column is required on `orbs`: `orbs.project_id → projects.owner_user_id` supplies it. `history_records`, `orb_messages`, `orb_deletions`, `workspace_uploads`, `hosted_files`, `hosting_operations`, `hosting_cleanup_items` and `hosting_events` inherit through their orb. `hosting_attempts` inherits through its operation. `orb_spawns` already has a project anchor. `project_secret_pointers`, `project_mcp`, `mcp_oauth`, `mcp_oauth_events` and `mcp_oauth_garbage` already have project scope. These operations still need the right user context, but not duplicate ownership columns. `oidc_signing_keys` remains deployment-wide.

### Migration 023 cutover (decided 2026-09-16)

Migration `023` is a one-time transaction. A fresh database whose projects and legacy singleton personal instructions are both still initial-empty needs no original-owner input. Any existing project or noninitial personal-instructions data requires all three trusted-operator values: `PI_ORB_ORIGINAL_USER_ID`, `PI_ORB_ORIGINAL_IDENTITY_ISSUER`, and `PI_ORB_ORIGINAL_IDENTITY_SUBJECT`. Partial input or invalid UUID/identity values fails closed.

When input is required, the transaction inserts the exact UUID and verified identity mapping if absent, or verifies that both existing rows already match. It must not retarget an existing identity or UUID; any conflict rolls back. It then assigns every project, makes `projects.owner_user_id` non-null, replaces global project-name uniqueness with `(owner_user_id, name)`, and copies the legacy singleton instructions to that user without changing content, revision or timestamp. No guessed email, first-user selection, placeholder/null owner, dual read or compatibility phase exists.

The issuer/subject must have been independently verified through IAP before an operator supplies them; there is no bootstrap API and no need to deploy stage 1 alone. Local/test/ops setups use explicit known identities. If the migration is unapplied and required mapping is absent, startup fails closed. After `023` is recorded as applied, later bootstrap mappings cannot change ownership. Production migration completed at `2026-09-17T01:38:25.184Z` with independently verified owner UUID `53da7ad4-6c53-4223-868e-0641bb4bcdd9`. Verification found all three existing projects assigned to it with metadata unchanged, and the one legacy personal-instructions row's content, revision, and timestamp preserved. Current schemas are in `apps/control-plane/src/adapters/pg/migrations/`.

## Ownership and access (stage 2 decided 2026-09-16)

Company IAP admission remains the trust boundary. Default browser project/orb lists show only the signed-in user's projects; browser project creation and personal-instructions GET/PUT use that same user. Existing direct project, orb, file, transcript, settings and lifecycle URLs remain trusted-company-wide. There is no coworker switcher, transfer operation or new permissions framework.

The ops service has no implicit human. For the four user-context operations—default project list, project creation, personal-instructions GET and PUT—it requires `X-Pi-Orb-User-Id` naming a known user UUID. A user principal cannot override identity with that header. Resource-specific ops derive the owner from the addressed project where needed.

A project and all children have one owner. Creation idempotency includes owner: the same resource UUID under another owner conflicts. Project create and rename enforce normalized name uniqueness per owner with typed `409`; different owners may use the same name. Runtime inspection defaults to projects owned by the authenticated calling orb's project owner, while explicit transcript reads remain cross-user. Runtime boot always loads the orb project's owner's personal instructions, never the viewer's.

Stage 3 will derive credential ownership from authenticated `orb → project → owner`. That owner supplies Codex/GitHub tokens and control-plane inference such as orb naming. Merely opening a coworker's orb must not switch its model/Git identity to the viewer. Same-project spawning inherits the project's owner. Refresh CAS, leases and login challenges will be keyed per user/provider; concurrent users must not share one global ceremony or Pi `auth.json`. Credential errors/challenges must reach the relevant user's UI and waiting orbs without exposing tokens.

OAuth secrets remain outside PostgreSQL. Distinct user pointers can reference distinct immutable versions under the existing provider Secret Manager parents; a separate Secret Manager secret per user is not required. Version reads, refreshes and destruction must follow the correct user's pointer. Local Pi auth artifacts need per-user paths. Provider client configuration, including the GitHub App client ID/secret, can stay shared; access/refresh tokens cannot.

The GitHub App's owning-account-only installation setting does not inherently prevent employee-specific OAuth tokens for already covered company repositories. App visibility changes are necessary only if installations must cover other repository-owning accounts. Repository access still requires the user's permissions, installation coverage and App grants.

Project instructions, project secrets and MCP remain project/connection scoped; stage 2 does not turn existing project instructions into personal data. Cross-user file access does not imply showing raw broker credentials; existing no-secret-browser-response rules remain. No new preview proxy, account billing, quota service or cross-customer security program is proposed.

## Tailscale options

**Recommended, not selected:** one company tailnet with employee devices and all orbs. The existing global configuration supports this topology; invite employees and permit their devices to reach `tag:pi-orb`. A new tailnet is optional if the current one is suitable for company membership. Moving existing orbs to another tailnet requires re-enrollment and cleanup of old registrations; changing the DNS suffix alone is not migration.

**Per-user tailnets:** feasible, but more application work. Store a tailnet DNS name and OAuth client configuration per user, with the client secret in the secret store. Resolve the project's owner when provisioning, minting/revoking keys, removing devices and generating preview URLs. Retain enough enrollment identity to clean up the original tailnet even after settings change. The runtime already accepts a supplied auth key/hostname/preview host and need not understand users. This is a lifecycle/configuration feature, not a database-column-only change.

**Two tailnets on a device:** the normal Tailscale client supports saved accounts and switching, with only one active tailnet at a time; it cannot transmit on both simultaneously. Separate daemon/container/VM instances can provide separate network clients, but are not ordinary desktop account switching. Machine sharing can expose selected machines across tailnets without joining both, rather than merging the networks. Sources checked 2026-09-16: [fast user switching](https://tailscale.com/kb/1225/fast-user-switching), [machine sharing](https://tailscale.com/kb/1084/sharing). No simultaneous-daemon deployment was tested here.

## Delivery stages (2026-09-16)

**Clarification (2026-09-16; updated 2026-09-17):** the earlier blanket ban on deploying stage 1 independently conflated deployment with coworker onboarding. Identity and ownership can serve the existing user, but global credentials prevent coworker onboarding. No dual-read, legacy fallback, or compatibility rollout is proposed. Stages 1–2 are deployed for single-user use; stage 3 is authorized but not deployed.

1. **Application identity (deployed for single-user use).** The decided identity and principal contract above are implemented. Focused tests cover invalid assertions, key/store failures, cache timing and concurrency, repeated/concurrent identity resolution, injected user identities, route coverage, role composition and both session variants; the user-store contract also runs against real PostgreSQL 15 through `node-postgres`. Typecheck, lint, 1,789 unit tests plus infra checks, and 61 process-backed E2E tests pass; skips and qualification limits are recorded in `docs/testing.md`. Every covered operation receives its role-appropriate stable principal, ops remains machine-only, and non-browser authentication surfaces remain separate. This slice alone does not support coworker onboarding.
2. **Owned projects and personal settings (deployed; schema/data cutover verified).** Migration 023 adds required project ownership, per-owner project-name uniqueness and user-keyed `personal_instructions`. Default browser lists, creation and personal settings use the signed-in user; the four corresponding ops operations require explicit known-user selection. Runtime list inspection defaults to the calling orb owner's projects, runtime boot uses the project owner, and explicit transcript reads plus existing direct resource access remain company-wide. Tests cover migration fail-closed/rollback behavior, duplicate names across users, owner-aware idempotency, inheritance, next-start instruction adoption and viewer-independent owner selection. Production verification established exact owner assignment and personal-data preservation. Typed-history migration compatibility enforcement remains a separate follow-up.
3. **Per-user Codex/GitHub end to end.** Key `credential_pointers`, broker calls, refresh leases and login state by user/provider, with separate Pi auth artifacts. Wire ownership through both provider login flows, lifecycle prerequisites/wakeups, runtime token requests, same-project spawning and background inference. Retain shared provider client configuration and secret parents where suitable. No fallback to another user's credential. Begin with DST for simultaneous logins, refresh races, failure/re-login and version cleanup; then adapter/store and two-user browser/runtime tests. Exit: one user's credential failure neither overwrites nor blocks the other's healthy flow, and all model/Git activity uses the orb owner's identity. This is the largest slice.
4. **Company pilot and cutover.** Run the full relevant suite, including browser/runtime E2E, and verify migration assignments before deployment. If migrations change runtime writes, preserve supported old-runtime behavior or reject incompatible writes observably at the boundary. Onboard one coworker: create same-named projects, connect distinct Codex/GitHub accounts, inspect shared files, spawn/restart orbs and confirm credential/instruction ownership. Existing typed auth errors plus sanitized user/project/orb correlation must make wrong-account and login failures diagnosable without logging secrets. Exit: both users complete that flow on the deployed service; widen company admission only after it passes.

**Parallel operational workstream:** choose preview topology (question 26). A shared company tailnet is recommended and fits current code; verify employee device access to an actual orb port. If moving to a new tailnet, qualify enrollment, retained-node re-enrollment and old-device cleanup. Per-user tailnets are a separate optional feature, not a dependency of per-user application data/credentials. The application pilot can run without previews if the tailnet choice is deferred.

Each stage includes its own tests; the pilot is not the first validation. Schema changes use normal SQL migrations; original-user ownership assignment is an explicit stage-2 cutover operation, not stage-1 guessing. No quotas, billing, teams, new preview proxy or hostile-tenant hardening is included.

## Testing scope

“Isolation qualification” in the original assessment meant proving that one unrelated customer cannot access another's resources. That is not a requirement for these trusted coworkers.

The relevant tests instead prove correct per-user behavior: default project lists and duplicate names, instruction selection, credential ownership, concurrent login/refresh, same-project spawning and control-plane inference. A runtime always gets its project's owner's credentials, even when a different user is viewing it. Refreshing or reconnecting one user's provider must not overwrite or invalidate another's credentials. Permitted shared-file access stays functional.

Use deterministic schedules for multi-user login/refresh races and existing lifecycle integrations, store contracts for schema/query changes, and browser/runtime E2E for two logged-in users. This assessment involved repository inspection and Tailscale documentation, not deployment or live security qualification. Question 24 records the selected stage-2 access scope; remaining stage-3 and tailnet choices live in questions 25–26. Stages 1–2 are deployed from `ec81e80`; stage 2's migration data checks passed. Stage 3 remains undeployed, and typed-history migration compatibility enforcement remains a follow-up. Qualification and deployment evidence are recorded in `docs/testing.md` and `docs/deployment.md`.
