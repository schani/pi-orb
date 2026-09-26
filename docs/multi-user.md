# Multi-user company deployment

**Implemented 2026-09-19; local qualification passed 2026-09-20; not deployed.** The single `pi-orb-issuer` application uses Google login and stateless sealed cookies. `docs/control-plane-consolidation.md` records decisions and cutover gates; `docs/deployment.md` defines the implemented topology/configuration. Dated live evidence below describes earlier releases, not this implementation.

## Scope (clarified 2026-09-16)

Users are trusted coworkers at one small company. Each has their own projects/orbs, Codex/GitHub credentials and personal settings. Cross-user file access is acceptable. Network security has the same trust assumptions as the current personal deployment. No adversarial-customer isolation, quotas, billing or collaboration features are required for this milestone.

**Decision (updated 2026-09-17):** stages 1–2 application identity, owned projects, and personal settings are deployed from `ec81e80` for existing single-user use; migration 023's owner assignment and data preservation are verified. Typed-history migration compatibility enforcement remains a follow-up (`docs/postmortems/2026-09-17-typed-history-runtime-fence.md`). Stage 3 per-user credentials and migration 024 are on `main`, qualified, and authorized for the requested GitHub Actions production release. Coworker onboarding is not authorized.

The initial 2026-09-15 assessment interpreted “customers” as unrelated, mutually untrusted tenants. Its hostile-tenant qualification, mandatory limits and network separation were rejected by this clarification: they solve a different problem. Existing authentication, token fencing and secret-handling safeguards remain; the smaller feature must still select the correct user's credentials and data reliably.

## Current gaps

- The deployed service resolves an application principal and makes `/api/v1/session` a no-store principal probe. Stage-1 production evidence remains guarded API traffic rather than a dedicated session-response or two-user test. See `docs/deployment.md` and `docs/control-plane-api.md`.
- Deployed stage 2 gives projects required owners, per-owner names/default lists, and user-keyed personal instructions. Migration verification found all three projects assigned to the selected owner and the existing personal-instructions row exactly preserved.
- Stage 3 on `main` gives each owner independent Codex/GitHub pointers, login gates, challenges, and Pi login artifacts. Its requested production deployment is authorized; coworker onboarding is not.
- Preview configuration is deployment-wide: one Tailscale OAuth client and tailnet. This already fits a shared company tailnet. See `docs/ports.md`.

## Application identity (implemented 2026-09-19; not deployed)

`users` has a stable UUID, unique verified `(identity_issuer, identity_subject)` and nullable display email. Google login resolves the user before issuing a stateless twelve-hour sealed session. Email is presentation data, never identity or linking authority. No session table or per-request user lookup is required. Google company admission, cookies, logout's copied-cookie limitation and Origin-only CSRF are specified in `docs/credentials.md`.

Every protected application request receives one principal:

```ts
type Principal =
  | { kind: "user"; user: { id: string; email: string | null } }
  | { kind: "ops"; id: string };
```

`GET /api/v1/session` returns `{ status: "ok", principal }` with `Cache-Control: no-store`; cookie-authenticated responses also include `logoutAvailable: true`. Issuer and subject stay server-only. `PI_ORB_AUTH_MODE=local` explicitly resolves `pi-orb:local/developer`; tests inject Alice/Bob. Google mode verifies browser sessions or Google machine ID tokens with exact app audience and immutable `PI_ORB_MACHINE_SUBJECT`. Machine callers never infer a human. Runtime incarnation bearers remain a separate credential class.

Composition selects the auth service; HTTP guards map typed results, while provider/store adapters contain third-party exceptions. Browser handlers do not call identity storage or Google verification directly. Source: `apps/control-plane/src/{identity-composition.ts,domain/application-auth.ts,http/browser-identity.ts}`.

### Google identity migration 027

The migration job alone reads nonsecret `PI_ORB_GOOGLE_IDENTITY_MAPPINGS`, a JSON array of `{userId, oldIssuer, oldSubject, googleSubject}`. Supply independently verified exact identities; `oldIssuer` must be `https://cloud.google.com/iap`. `027_google_identities.sql` locks users and atomically changes matched issuer/subject pairs to `https://accounts.google.com` and the supplied Google subject. UUIDs, emails, timestamps, ownership and dependent records remain unchanged. It rejects missing IAP coverage, unexpected tuples, malformed/duplicate mappings and occupied destinations. Fresh databases need no input; subsequent jobs need none after committed migration. Runtime startup does not read this variable.

Retire old identity-serving processes before migration: a table lock cannot stop one returning later. Migration logs record filename, outcome and mapped count, never identity values; `schema_migrations` records completion. There is no email linking, replacement user or compatibility phase. Cutover: `docs/control-plane-consolidation.md`.

## Schema target

| Table | Change |
| --- | --- |
| `users` (new; stage 1) | Stable UUID plus unique verified `(identity_issuer, identity_subject)` and nullable display email. |
| `projects` | Add `owner_user_id REFERENCES users(id)`; change name uniqueness to `(owner_user_id, name)`. |
| `credential_pointers` (migration 024) | Required `user_id REFERENCES users(id)` and primary key `(user_id, provider)`. Generations, CAS versions and refresh leases are per-user. |
| `personal_instructions` | Replace the `singleton` primary key with `user_id REFERENCES users(id)`; retain content, revision and timestamp. A valid user with no row reads implicit empty revision 0 until first write. |

One new table and three changed tables. Orbs inherit project ownership, without independent owners or transfers.

No ownership column is required on `orbs`: `orbs.project_id → projects.owner_user_id` supplies it. `history_records`, `orb_messages`, `orb_deletions`, `workspace_uploads`, `hosted_files`, `hosting_operations`, `hosting_cleanup_items` and `hosting_events` inherit through their orb. `hosting_attempts` inherits through its operation. `orb_spawns` already has a project anchor. `project_secret_pointers`, `project_mcp`, `mcp_oauth`, `mcp_oauth_events` and `mcp_oauth_garbage` already have project scope. These operations still need the right user context, but not duplicate ownership columns. `oidc_signing_keys` remains deployment-wide.

### Migration 023 cutover (decided 2026-09-16)

Migration `023` is a one-time transaction. A fresh database whose projects and legacy singleton personal instructions are both still initial-empty needs no original-owner input. Any existing project or noninitial personal-instructions data requires all three trusted-operator values: `PI_ORB_ORIGINAL_USER_ID`, `PI_ORB_ORIGINAL_IDENTITY_ISSUER`, and `PI_ORB_ORIGINAL_IDENTITY_SUBJECT`. Partial input or invalid UUID/identity values fails closed.

When input is required, the transaction inserts the exact UUID and verified identity mapping if absent, or verifies that both existing rows already match. It must not retarget an existing identity or UUID; any conflict rolls back. It then assigns every project, makes `projects.owner_user_id` non-null, replaces global project-name uniqueness with `(owner_user_id, name)`, and copies the legacy singleton instructions to that user without changing content, revision or timestamp. No guessed email, first-user selection, placeholder/null owner, dual read or compatibility phase exists.

The issuer/subject must be independently verified before an operator supplies them; the original deployed cutover used IAP. There is no bootstrap API and no need to deploy stage 1 alone. Local/test/ops setups use explicit known identities. If the migration is unapplied and required mapping is absent, startup fails closed. After `023` is recorded as applied, later bootstrap mappings cannot change ownership. Production migration completed at `2026-09-17T01:38:25.184Z` with independently verified owner UUID `53da7ad4-6c53-4223-868e-0641bb4bcdd9`. Verification found all three existing projects assigned to it with metadata unchanged, and the one legacy personal-instructions row's content, revision, and timestamp preserved. Current schemas are in `apps/control-plane/src/adapters/pg/migrations/`.

### Migration 024 credential cutover (decided 2026-09-16; qualified on `main` 2026-09-17)

Migration `024` takes `PI_ORB_USER_ID` as the explicit original credential-owner UUID. In the migration transaction, the runner selects that exact row from `users`, uses its stored verified issuer/subject to populate the existing SQL settings, and fails unknown UUIDs without changing schema, pointers, or migration records. It then assigns every existing pointer to that user, makes `user_id` non-null, and replaces the original `provider` primary key with `(user_id, provider)`. An empty `credential_pointers` table can migrate without a selected owner outside the release path. A local `PI_ORB_AUTH_MODE=local` upgrade with existing pointers must set `PI_ORB_USER_ID` to their exact existing owner. Migration `023` retains its all-or-none bootstrap tuple for databases that still need initial ownership; partial tuples, invalid UUIDs, and conflicting selected/bootstrap UUIDs fail before database work. Migration 024 never inserts a user or guesses from projects, row order, email, or a first user. It preserves generations, row versions, leases, exact secret versions, refresh times, and timestamps. Durable migration logs record only the `users` resolution source and outcome, never issuer or subject. For the requested production release only, the user waived migration-024 protection for old-process credential writes and accepted that those writes may fail during overlap. This does not repeal the general compatibility policy, authorize coworker onboarding, or waive E2E. See `docs/deployment.md`.

## Ownership and access (stages 2–3 decided 2026-09-16)

Verified Google Workspace admission is the company trust boundary. Default browser project/orb lists show only the signed-in user's projects; browser project creation and personal-instructions GET/PUT use that same user. Existing direct project, orb, file, transcript, settings and lifecycle URLs remain trusted-company-wide. There is no coworker switcher, transfer operation or new permissions framework.

The machine ops principal has no implicit human. For the four user-context operations—default project list, project creation, personal-instructions GET and PUT—it requires `X-Pi-Orb-User-Id` naming a known user UUID. A user principal cannot override identity with that header. Resource-specific ops derive the owner from the addressed project where needed.

A project and all children have one owner. Creation idempotency includes owner: the same resource UUID under another owner conflicts. Project create and rename enforce normalized name uniqueness per owner with typed `409`; different owners may use the same name. Runtime inspection defaults to projects owned by the authenticated calling orb's project owner, while explicit transcript reads remain cross-user. Runtime boot always loads the orb project's owner's personal instructions, never the viewer's.

Credential authority is the authenticated `orb → project → owner`. That owner supplies Codex/GitHub tokens, orb naming, and auxiliary inference; a viewer never selects them. Same-project spawning inherits ownership through the project. Runtime routes authenticate the incarnation, load its project, and bind the broker to its owner. No owner column is copied to the orb or request body.

`CredentialPointerStoreFactory.forUser(userId)` binds the generic pointer interface; `bindUserBroker` cheaply combines it with shared secret storage, provider clients, and constants. This keeps the broker generic and preserves MCP's separate project/connection binding. Pointer CAS, leases, login gates, Pi runtimes, GitHub flows, challenges, and blocked cohorts are keyed by user. Independent users neither serialize behind nor fail each other.

OAuth secrets remain outside PostgreSQL. User pointers reference immutable exact versions under the existing provider Secret Manager parents; no per-user parent or global enumeration is needed. Cleanup destroys only exact versions known to be superseded or definitely unpublished, so one user's rotation or CAS failure cannot delete another user's referenced or in-flight version. File-store writes use exclusive creation rather than overwrite. Provider client configuration, including the GitHub App client ID/secret, remains shared; access and refresh credentials do not.

The broker is canonical. Each gate resolves `getToken(..., "startup")` before opening a ceremony: a usable or refreshed credential proceeds, `auth_required` starts that owner's flow, and retryable storage/publication failures remain retryable lifecycle work rather than terminal cohort failure. `invalid_grant` affects only that user's generation. A successful fresh login publishes through the bound broker. Pi's SDK artifact exists only at `<PI_ORB_AUTH_DIR>/users/<user UUID>/auth.json` to publish that just-completed login; it is neither durable authority nor fallback. Shared/global `auth.json` import was rejected because migrated pointers are authoritative and stale files must not resurrect an invalidated credential.

A known pre-commit publication failure retains the in-memory completed-login material for retry. If a CAS acknowledgement is uncertain, the broker accepts success only after an exact pointer reread; otherwise it returns `login_commit_uncertain`, drops the staged login material, and resolves canonical state afresh on the next call. It never retries that uncertain version, which could resurrect a version superseded and destroyed by another actor.

The GitHub App's owning-account-only installation setting does not inherently prevent employee-specific OAuth tokens for already covered company repositories. App visibility changes are necessary only if installations must cover other repository-owning accounts. Repository access still requires the user's permissions, installation coverage and App grants.

Project instructions, project secrets and MCP remain project/connection scoped; stage 2 does not turn existing project instructions into personal data. Cross-user file access does not imply showing raw broker credentials; existing no-secret-browser-response rules remain. No new preview proxy, account billing, quota service or cross-customer security program is proposed.

## Tailscale options

**Recommended, not selected:** one company tailnet with employee devices and all orbs. The existing global configuration supports this topology; invite employees and permit their devices to reach `tag:pi-orb`. A new tailnet is optional if the current one is suitable for company membership. Moving existing orbs to another tailnet requires re-enrollment and cleanup of old registrations; changing the DNS suffix alone is not migration.

**Per-user tailnets:** feasible, but more application work. Store a tailnet DNS name and OAuth client configuration per user, with the client secret in the secret store. Resolve the project's owner when provisioning, minting/revoking keys, removing devices and generating preview URLs. Retain enough enrollment identity to clean up the original tailnet even after settings change. The runtime already accepts a supplied auth key/hostname/preview host and need not understand users. This is a lifecycle/configuration feature, not a database-column-only change.

**Two tailnets on a device:** the normal Tailscale client supports saved accounts and switching, with only one active tailnet at a time; it cannot transmit on both simultaneously. Separate daemon/container/VM instances can provide separate network clients, but are not ordinary desktop account switching. Machine sharing can expose selected machines across tailnets without joining both, rather than merging the networks. Sources checked 2026-09-16: [fast user switching](https://tailscale.com/kb/1225/fast-user-switching), [machine sharing](https://tailscale.com/kb/1084/sharing). No simultaneous-daemon deployment was tested here.

## Historical delivery stages (2026-09-16; before consolidation)

**Clarification (updated 2026-09-17):** the earlier blanket ban on deploying stage 1 independently conflated deployment with coworker onboarding. Identity and ownership can serve the existing user, but global credentials prevented coworker onboarding. No dual-read, legacy fallback, or compatibility rollout is proposed. Stages 1–2 are deployed for single-user use; stage 3 is on `main`, qualified, and authorized for the requested production release. Coworker onboarding is not authorized.

1. **Application identity (deployed for single-user use).** The then-current IAP identity and principal contract was implemented. Focused tests cover invalid assertions, key/store failures, cache timing and concurrency, repeated/concurrent identity resolution, injected user identities, route coverage, role composition and both session variants; the user-store contract also runs against real PostgreSQL 15 through `node-postgres`. Typecheck, lint, 1,789 unit tests plus infra checks, and 61 process-backed E2E tests pass; skips and qualification limits are recorded in `docs/testing.md`. Every covered operation receives its role-appropriate stable principal, ops remains machine-only, and non-browser authentication surfaces remain separate. This slice alone does not support coworker onboarding.
2. **Owned projects and personal settings (deployed; schema/data cutover verified).** Migration 023 adds required project ownership, per-owner project-name uniqueness and user-keyed `personal_instructions`. Default browser lists, creation and personal settings use the signed-in user; the four corresponding ops operations require explicit known-user selection. Runtime list inspection defaults to the calling orb owner's projects, runtime boot uses the project owner, and explicit transcript reads plus existing direct resource access remain company-wide. Tests cover migration fail-closed/rollback behavior, duplicate names across users, owner-aware idempotency, inheritance, next-start instruction adoption and viewer-independent owner selection. Production verification established exact owner assignment and personal-data preservation. Typed-history migration compatibility enforcement remains a separate follow-up.
3. **Per-user Codex/GitHub end to end (on `main`, qualified, deployment authorized).** Migration 024 and user-bound brokers key pointers, refresh leases, login state, Pi artifacts, lifecycle cohorts, runtime grants, naming, and auxiliary inference by project owner. Shared provider clients and secret parents remain generic. Owner-only views receive actionable device codes; coworkers and ops receive only `owner_login_required` plus provider. DST, SQL contracts, route/browser coverage, and process E2E prove one user's credential failure neither overwrites nor blocks the other's healthy flow, and model/Git activity uses the orb owner's identity. Qualification evidence is in `docs/testing.md`; the requested production release is authorized, with no coworker-onboarding or E2E waiver.
4. **Company pilot and cutover.** Run the full relevant suite, including browser/runtime E2E, and verify migration assignments before deployment. If migrations change runtime writes, preserve supported old-runtime behavior or reject incompatible writes observably at the boundary. Onboard one coworker: create same-named projects, connect distinct Codex/GitHub accounts, inspect shared files, spawn/restart orbs and confirm credential/instruction ownership. Existing typed auth errors plus sanitized user/project/orb correlation must make wrong-account and login failures diagnosable without logging secrets. Exit: both users complete that flow on the deployed service; widen company admission only after it passes.

**Parallel operational workstream:** choose preview topology (question 26). A shared company tailnet is recommended and fits current code; verify employee device access to an actual orb port. If moving to a new tailnet, qualify enrollment, retained-node re-enrollment and old-device cleanup. Per-user tailnets are a separate optional feature, not a dependency of per-user application data/credentials. The application pilot can run without previews if the tailnet choice is deferred.

Each stage includes its own tests; the pilot is not the first validation. Schema changes use normal SQL migrations; original-user ownership assignment is an explicit stage-2 cutover operation, not stage-1 guessing. No quotas, billing, teams, new preview proxy or hostile-tenant hardening is included.

## Testing scope

“Isolation qualification” in the original assessment meant proving that one unrelated customer cannot access another's resources. That is not a requirement for these trusted coworkers.

The relevant tests instead prove correct per-user behavior: default project lists and duplicate names, instruction selection, credential ownership, concurrent login/refresh, same-project spawning and control-plane inference. A runtime always gets its project's owner's credentials, even when a different user is viewing it. Refreshing or reconnecting one user's provider must not overwrite or invalidate another's credentials. Permitted shared-file access stays functional.

Use deterministic schedules for multi-user login/refresh races and existing lifecycle integrations, store contracts for schema/query changes, and browser/runtime E2E for two logged-in users. Question 24 records the access scope; question 25 resolves per-user app credentials while leaving user-level workload-identity claims open; tailnet choice remains question 26. Stages 1–2 are deployed from `ec81e80`; stage 2's migration data checks passed. Stage 3 is on `main`, qualified, undeployed, and authorized for the requested production release. No stage-3 live IAP, real provider account, private clone, GCE, Docker, deployment, or user-level workload-identity claim has yet been exercised. Typed-history migration compatibility enforcement remains a follow-up. Qualification and deployment evidence are recorded in `docs/testing.md` and `docs/deployment.md`.
