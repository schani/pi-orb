# Exact workload trust anchor; do not substitute the hashed service URI.
locals {
  issuer_service_name = "pi-orb-issuer"
  oidc_issuer_url     = "https://${local.issuer_service_name}-${local.foundation.project_number}.${var.region}.run.app"
}

resource "google_secret_manager_secret" "oidc_signing_key" {
  secret_id = "pi-orb-credential-oidc-signing-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "cp_signing_key_accessor" {
  secret_id = google_secret_manager_secret.oidc_signing_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.control_plane_email}"
}

resource "google_secret_manager_secret_iam_member" "cp_signing_key_versions" {
  secret_id = google_secret_manager_secret.oidc_signing_key.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${local.control_plane_email}"
}
