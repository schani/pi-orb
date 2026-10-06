# Owner subscription credentials (docs/credentials.md). The control plane
# writes immutable versions after the native CLI connection flow.
resource "google_secret_manager_secret" "claude_subscription" {
  secret_id = "pi-orb-credential-claude-subscription"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "cp_claude_subscription_accessor" {
  secret_id = google_secret_manager_secret.claude_subscription.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.control_plane_email}"
}

resource "google_secret_manager_secret_iam_member" "cp_claude_subscription_versions" {
  secret_id = google_secret_manager_secret.claude_subscription.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${local.control_plane_email}"
}
