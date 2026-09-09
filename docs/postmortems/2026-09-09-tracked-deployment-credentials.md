# Tracked deployment credentials

## Evidence (2026-09-09)

While preparing GitHub deployment, the existing 2026-08-09 security backlog item
was checked against current production state. The three tracked files
`infra/adopt-11639b8.plan`, `infra/deploy-28798f6.plan` and
`infra/deploy-sol.plan` were ZIP plan archives with embedded `tfstate` and
`tfstate-prev`. They contained one distinct database password; an in-memory
comparison confirmed that it still matched the current production credential.
Only the count and match verdict were printed, never the password, URL or hash.

The full binary plans were subsequently decoded using OpenTofu 1.12.5 and their
archived provider lock (Google 6.50.0). Newer tool/schema readers failed and those
first diagnostics were retained. The decoded planned/prior values and inline
environment fields showed database credential material, not an additional
populated credential family. Sensitive-field flags are not evidence of a populated
secret: for example, the root-password field was marked sensitive but unset.
Only allowlisted field names were printed. Private plan scratch was removed.

The repository is public. Neither private Cloud SQL networking nor deleting
the files makes that credential secret again. History rewrites also cannot
recall copies, so credential rotation is required independently of repository
cleanup.

## Containment

The archives are removed from the current tree. `infra/artifact_guard.py` checks
tracked filenames, ZIP entry names and state/plan JSON signatures, including
renamed artifacts, without printing content. CI runs it before dependency
installation. Git and Docker ignore rules exclude generated Google credentials,
plans, state, local evidence and provider caches. The committed non-secret
pi-orb external-account configuration remains allowed.

A later diagnostic accidentally cleared the production password through ambient
SQL role state. It was restored from the unchanged canonical secret; the temporary
login was deleted and fresh connectivity verified. This restored availability,
not secrecy (`docs/postmortems/2026-09-09-credential-probe-role-reset.md`).

At this checkpoint credential rotation is not complete. Its outcome and any
additional exposed credentials must be verified separately; remaining work is
tracked only in `TODO.md`.

## Rule

Upload only allowlisted, structurally constructed release records. Never upload
a workspace directory, saved plan, state, auth file or raw diagnostic bundle as
a CI artifact. Temporary files use owner-only permissions and credential-bearing
scratch is deleted even when cloud fixtures are retained for diagnosis.
