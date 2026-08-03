# GitHub App integration (DESIGN.md §15.3). The app's client id is plain
# configuration (var.github_client_id); its client secret and the brokered
# user credential live in Secret Manager. Tofu creates the secrets; the
# client-secret *version* is added manually after registering the app:
#
#   printf '%s' "$CLIENT_SECRET" | \
#     gcloud secrets versions add pi-orb-github-client-secret --data-file=-

# Parent secret for the broker's GitHub user credential; the GsmSecretStore
# only adds/reads/destroys versions on it (same pattern as the Codex one).
resource "google_secret_manager_secret" "github_credential" {
  secret_id = "pi-orb-credential-github"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "cp_github_credential_accessor" {
  secret_id = google_secret_manager_secret.github_credential.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "cp_github_credential_versions" {
  secret_id = google_secret_manager_secret.github_credential.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret" "github_client_secret" {
  secret_id = "pi-orb-github-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "cp_reads_github_client_secret" {
  secret_id = google_secret_manager_secret.github_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}
