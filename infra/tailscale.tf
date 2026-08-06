# Tailscale tier-1 port exposure (docs/ports.md). The OAuth client id and the
# tailnet DNS name are plain configuration (var.tailscale_oauth_client_id,
# var.tailscale_tailnet_dns_name); the client secret lives in Secret Manager.
# Tofu creates the secret; its *version* is added manually after creating the
# OAuth client (it must own tag:pi-orb):
#
#   printf '%s' "$TS_CLIENT_SECRET" | \
#     gcloud secrets versions add pi-orb-tailscale-oauth-client-secret --data-file=-

resource "google_secret_manager_secret" "tailscale_oauth_client_secret" {
  secret_id = "pi-orb-tailscale-oauth-client-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "cp_reads_tailscale_client_secret" {
  secret_id = google_secret_manager_secret.tailscale_oauth_client_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}
