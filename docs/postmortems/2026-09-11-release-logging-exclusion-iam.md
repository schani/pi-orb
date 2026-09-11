# MCP OAuth release blocked by logging-exclusion IAM

## Evidence (2026-09-11)

GitHub Deploy run [34559363802](https://github.com/schani/pi-orb/actions/runs/34559363802)
released commit `72fb304121c053a6b34318b4f5e266033fa019a8`. Its durable record is
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789098114-403ee06c-d7f5-4fc5-bfef-d2aa8b58ca6d.json`;
the same allowlisted record is attached to the workflow.

Preflight, checks (including E2E), build, plan and schema passed. The migration
job completed and was deleted. Apply created the MCP OAuth secret and both IAM
memberships and updated all four Cloud Run services, but failed at 04:17:51 UTC:
`logging.exclusions.create` was denied for
`projects/playground-dev-6ae7/exclusions/mcp-oauth-callback`.
The deployer's foundation role set includes Logging Viewer, not exclusion
management. A successful plan did not prove create permission.

The exit path repaired IAP and verified the exact `domain:heyglide.com` accessor
allowlist, persisted `applied-but-unvalidated` with `apply: failed`, and released
the release lock. Retirement, activation and live smoke gates did not run.
Read-only inspection subsequently confirmed Ready revisions `pi-orb-00051-f7v`,
`pi-orb-ops-00048-n7f`, `pi-orb-runtime-api-00053-x9v`, and
`pi-orb-issuer-00013-dzv`. Logging API GET of the exclusion returned 404.
Readiness does not establish release validation or controller activation.

## Safety and recovery status

Recovery was initially blocked on separately administered foundation authority. The orb
and GitHub runner use the same scoped deployer; neither may expand its own IAM.
No automatic retry or permission broadening was performed. Do not exercise real
MCP OAuth callbacks while the required default-sink exclusion is absent; this
finding does not establish whether any real callbacks occurred or whether other
sinks retain their query strings.

Preserve the exclusion rather than removing it to make apply pass, and establish
callback log protection before treating this release as usable.
Validation-only recovery does not apply missing infrastructure and therefore
cannot repair this failure by itself. The full release recovery below completed
the incident's recovery and preflight work.

## Correction (foundation applied; application recovery validated)

The user required autonomous GitHub deployment, not personal authentication per
release. The foundation now declares a custom role containing exactly
`logging.exclusions.create/get/update/delete` and an additive binding to the
existing shared deployer. This is project-level exclusion policy authority; it
is not restricted to one exclusion name. Logging Admin, IAM administration and
recurring personal credentials are rejected as unnecessary. The one-time grant
requires review/apply by the separate foundation administrator.

`infra/release_preflight.py` uses the real federated identity's read-only project
`testIamPermissions` call before checks/build/migration/apply. Missing permissions
fail closed with an administrator remedy; remote response bodies and tokens are
not printed. The existing release gate records the failed preflight durably.
The browser service explicitly depends on the exclusion and both OAuth secret
IAM memberships, preventing a first-create failure from publishing that browser
revision prematurely. This does not retroactively protect the already-updated
revision from the failed release or qualify additional sinks.

`npm ci`, the complete infrastructure test suite, the six new permission/order
regressions, and OpenTofu foundation formatting/validation passed. A read-only
live preflight reproduced missing create/update/delete (get is already granted).
No foundation mutation or release retry was attempted without administrator
access.

The human subsequently supplied a temporary administrator login. With the same
generation-matched GCS release lock held, a full foundation plan was inspected
and programmatically restricted to exactly two creates: the custom role and its
additive shared-deployer binding. The exact saved plan applied successfully with
zero changed or destroyed resources, and the release lock was released.
An isolated gcloud configuration using the committed federated credential passed
the read-only authority preflight; negative checks confirmed no
`resourcemanager.projects.setIamPolicy` or `iam.roles.create/update` permissions.
The personal login was revoked immediately, the normal account was reset to the
federated deployer, and its preflight passed again. This establishes permanent
shared authority for both GitHub and project orbs without recurring personal
credentials. Application recovery was verified separately below.

## Successful autonomous GitHub release

[Run 34562396846](https://github.com/schani/pi-orb/actions/runs/34562396846)
performed a fresh full release of `f7e56413b71d7e8c61ef374d499f9f4eca7bf1ed`
after the administrator login had been revoked. It ran independently through an
orb runtime restart; no second dispatch or runner intervention was necessary.
The transaction ran from 04:30:38 to 05:39:54 UTC and recorded `validated`,
`exitCode: 0`, with every gate passed: preflight, checks/E2E, build, plan, schema,
apply, repair, retire, activate, lifecycle, identity and complete.

The record is
`gs://pi-orb-tfstate-playground-dev-6ae7/static-plane/releases/r-1789101031-dbce69e8-1985-4ee4-b2ab-470376c6b47b.json`,
also attached to the workflow. Generation `1789102874` serves container digest
`sha256:14854730dda3837ea47eb87512d66ba54ed6146d416ea82c917d4889dc6a4b38`
on browser `pi-orb-00052-rmh`, ops `pi-orb-ops-00049-jjf`, runtime API
`pi-orb-runtime-api-00054-sbd`, and issuer `pi-orb-issuer-00014-hb8`.
Retirement recorded explicit active/idle zeroes for `pi-orb-00050-c4w` at 04:48
and `pi-orb-00051-f7v` at 05:28 before activation. Identity smoke included actual
GCP STS exchange, deployer impersonation, read-only API access and wrong-audience
rejection. All four recorded fixtures (one project, three orbs) were deleted.

Independent post-release Logging API inspection confirmed `mcp-oauth-callback`
exists, is enabled, and has exactly
`httpRequest.requestUrl:"/api/v1/mcp/oauth/callback"` as its filter. This validates
the default-sink configuration, not real-provider OAuth consent or every other
sink's behavior. Those qualification tasks remain in `TODO.md`. The original
run remains failed and applied-but-unvalidated; the successful fresh release
does not overwrite or relabel its evidence.
