# Credential probe cleared the production owner's password

## Incident (2026-09-09)

A Cloud SQL credential-rotation experiment created a disposable login with
membership in the production ownership role, `pi-orb`. It configured that login's
connection-time default role to `pi-orb`, verified inherited access, then attempted
to clear only the temporary login's password with:

```sql
RESET ROLE;
ALTER ROLE CURRENT_USER PASSWORD NULL;
```

That was unsafe and targeted production. `RESET ROLE` restores the connection-time
role setting, which in this case was **pi-orb**, not the authenticated temporary
login. `CURRENT_USER` therefore named the production owner. The temporary login
still authenticated afterwards, causing the probe's denial assertion to fail.

This was an operator error in a private diagnostic script, not a deployment of
new application code. Calling the fixture disposable did not make its inherited
production authority disposable. The test had no independent recovery watchdog;
it should not have been allowed to mutate passwords with that authority.

## Impact and recovery

- Probe-user creation completed at **18:33:27.582 UTC**.
- Cloud Run recorded **50 password-authentication errors**, all on the browser
  service, from **18:33:40.181313** through **18:34:23.368629 UTC**. This was
  production-impacting; the evidence does not support claiming uninterrupted UI
  availability. Existing database sessions need not fail when a password changes.
- The canonical Secret Manager value was unchanged. The agent restored the
  production user's password from that secret through an explicit, named-user
  Cloud SQL Admin API update, without printing credential material.
- Restoration operation `7f9a25fd-5193-430c-9a1c-be0500000032` completed at
  **18:34:28.080 UTC**. A fresh canonical database connection, schema read and
  authenticated ops project read subsequently passed.
- The follow-up log query found no matching password-authentication errors after
  restoration. This is a bounded observation, not proof that every request during
  the incident succeeded.
- All four application revisions remained unchanged. No application release,
  schema migration, workspace formatting, resizing or deletion occurred.
- Temporary login `pi-orb-role-probe-fbaf50a2732f45d49a570dbd952aea64` was explicitly
  deleted and verified absent. Its failed-probe evidence was retained. Credential
  principal containment takes precedence over retaining an unnecessary login.

The exposed original password is still the canonical credential. Restoring
availability did **not** complete credential rotation or undo its prior exposure.

## Earlier experimental findings

An isolated PostgreSQL 16 test showed that application-level `CREATEROLE` and
`pg_has_role(..., 'MEMBER WITH ADMIN OPTION')` do not establish permission to grant
one's own role. Another isolated attempt could not set the owner's `NOLOGIN`
attribute with those privileges. Those failures and their stopped fixtures were
retained. A revised isolated test using administrator-assigned membership and
explicitly named password revocation passed. The live probe improperly changed
that explicit target to `CURRENT_USER`; it did not faithfully execute the tested
procedure.

Cloud SQL's `databaseRoles` API successfully assigned the requested membership.
The unresolved issue is safe execution and recovery, not a need for broader
routine IAM authority.

## Rules

- Never use `CURRENT_USER`, `CURRENT_ROLE`, `SESSION_USER`, `RESET ROLE` or ambient
  session state to choose a destructive credential target. Use an explicit,
  validated identifier tied to the operation's recorded ownership.
- Disposable experiments must use disposable ownership roles too. They must not
  inherit a production owner merely to test role mechanics.
- A production credential mutation requires an independently armed and verified
  recovery mechanism and explicit target/precondition checks. Recovery identity
  must not depend on the application whose credentials are being changed.
- Execute the exact reviewed/tested procedure. A supposedly equivalent rewrite of
  a security-sensitive SQL statement invalidates that validation.
- Retain failures, but distinguish evidence/data fixtures from credential
  principals that should be disabled or removed for containment.

Private evidence: `.context/one-button/cloud-sql-role-probe.json`,
`cloud-sql-role-probe.log`, `emergency-password-restoration.json`, the probe source
and isolated role-test logs/scripts. No raw credential-bearing artifact is a CI
upload. Remaining credential-rotation work is tracked in `TODO.md`.
