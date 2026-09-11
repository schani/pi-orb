# Shared immutable versions; payloads carry project/connection ownership for cleanup.
resource "google_secret_manager_secret" "mcp_oauth" {
  secret_id = "pi-orb-credential-mcp-oauth"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "cp_mcp_oauth_accessor" {
  secret_id = google_secret_manager_secret.mcp_oauth.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.control_plane_email}"
}

resource "google_secret_manager_secret_iam_member" "cp_mcp_oauth_versions" {
  secret_id = google_secret_manager_secret.mcp_oauth.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${local.control_plane_email}"
}

# Codes/state must not be retained in Cloud Run request-URL logs. Application
# request logging is disabled; callback responses are no-store/no-referrer.
resource "google_logging_project_exclusion" "mcp_oauth_callback" {
  name        = "mcp-oauth-callback"
  description = "Do not retain OAuth authorization callback query strings"
  filter      = "httpRequest.requestUrl:\"/api/v1/mcp/oauth/callback\""
}
