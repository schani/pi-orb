# First-party OIDC issuer tier (docs/workload-identity.md). Three things live
# here: the public issuer URL every minted token carries as `iss`, the dedicated
# identity the public issuer service runs as, and the parent secret holding the
# private signing keys. The Cloud Run service itself is in run.tf beside its
# siblings.

data "google_project" "pi_orb" {}

locals {
  issuer_service_name = "pi-orb-issuer"

  # The chicken-and-egg: `iss` is part of the security identity of every token,
  # so the *runtime* service — which mints — must be told the issuer's URL at
  # deploy time. But a Cloud Run service cannot reference its own `.uri`, and
  # nothing else can reference it before it exists. Two alternatives were
  # rejected: an operator-supplied variable (a hand-copied string whose drift is
  # a silent trust migration, and one more thing a release can forget), and a
  # two-phase apply (machinery, and a window in which the two services disagree).
  #
  # Cloud Run v2 assigns a *deterministic* URL to a new service:
  #
  #   https://<service>-<project-number>.<region>.run.app
  #
  # It is computable before the service exists, needs no variable, and makes the
  # runtime and issuer services agree by construction rather than by discipline.
  # The three older services predate that scheme and still carry hashed URLs,
  # which is why this is only safe for a service being created now — so the
  # issuer service asserts the assumption against its real `.uri` in a
  # `lifecycle.postcondition`. A platform that stopped assigning this form would
  # fail the release loudly rather than deploy an issuer advertising a URL that
  # does not resolve.
  oidc_issuer_url = "https://${local.issuer_service_name}-${data.google_project.pi_orb.number}.${var.region}.run.app"
}

# The issuer is the deployment's only public unauthenticated surface, so it
# deliberately does not share the control plane's identity: that account can
# read every brokered user credential and the private signing keys below, and
# the issuer needs none of them. Its own account can read exactly one secret —
# the database URL, for the public JWKs in `oidc_signing_keys` — and write logs.
#
# Be precise about where that boundary stops (POC limitation, recorded
# 2026-08-22). It is a *Secret Manager* boundary: the issuer cannot read a
# private signing key, a brokered GitHub/Codex credential, or a Tailscale
# secret. It is **not** a database boundary. `DATABASE_URL` is the deployment's
# single full read/write application credential, so at the PostgreSQL layer this
# internet-facing service holds the same rights every other service does — it
# could read `orbs.runtime_token_hash` or write `oidc_signing_keys` if its code
# asked. What stops it today is the role's route allowlist (only discovery and
# JWKS are registered) and the trimmed environment, not the credential. A
# read-only PostgreSQL role for the issuer, granted `SELECT` on
# `oidc_signing_keys` alone, is tracked in `TODO.md` for the live gate.
resource "google_service_account" "issuer" {
  account_id   = "pi-orb-issuer"
  display_name = "pi-orb public OIDC issuer"
}

resource "google_secret_manager_secret_iam_member" "issuer_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.issuer.email}"
}

resource "google_project_iam_member" "issuer_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.issuer.email}"
}

# Parent secret for the issuer's private signing keys, following the Codex and
# GitHub credential precedent: tofu creates the parent, the control plane only
# adds, reads, and destroys versions on it.
#
# The id is not free-form. GsmSecretStore addresses
# `<PI_ORB_CREDENTIAL_SECRET_PREFIX>-<provider>`, the prefix defaults to
# `pi-orb-credential`, and `domain/signing-keys.ts` writes under the provider
# name `oidc-signing-key` — so this exact id is what the control plane looks
# for. A prettier `pi-orb-oidc-signing-key` would simply not be found.
resource "google_secret_manager_secret" "oidc_signing_key" {
  secret_id = "pi-orb-credential-oidc-signing-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Only the minting identity. `secretAccessor` covers the signer's per-signature
# read of an exact version; `secretVersionManager` covers the two writes key
# management performs — `addSecretVersion` when a key is generated and
# `destroySecretVersion` when a boot race loser drops the version nobody
# references (docs/workload-identity.md, stage 2).
#
# Within the control plane only the `runtime` role touches signing material, but
# the browser and ops services share this one pre-existing service account, so
# the grant is as narrow as the account split currently allows. What matters
# here is the boundary that is real: `google_service_account.issuer` — the
# public, unauthenticated service — appears in neither binding and can never
# read a private key. It is a Secret Manager boundary only; the issuer shares
# the one database credential with every other service (see the note above).
resource "google_secret_manager_secret_iam_member" "cp_signing_key_accessor" {
  secret_id = google_secret_manager_secret.oidc_signing_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "cp_signing_key_versions" {
  secret_id = google_secret_manager_secret.oidc_signing_key.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}
