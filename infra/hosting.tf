# Private object storage for orb-hosted files (docs/http-exposure.md). PostgreSQL owns
# publication and cleanup state; this bucket contains only immutable file bytes.
locals {
  app_origin     = local.oidc_issuer_url
  hosting_origin = "https://files---${local.issuer_service_name}-${local.foundation.project_number}.${var.region}.run.app"
}

resource "google_storage_bucket" "hosting" {
  name                        = "pi-orb-hosting-${var.project}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = false
  }

  soft_delete_policy {
    retention_duration_seconds = 0
  }
}

resource "google_storage_bucket_iam_member" "control_plane_hosting_objects" {
  bucket = google_storage_bucket.hosting.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.control_plane_email}"
}

# No file paths or credentials in Cloud Run's automatic request-URL logs.
resource "google_logging_project_exclusion" "files_requests" {
  name        = "files-requests"
  description = "Do not retain hosted or live-file paths or query strings"
  filter      = <<-FILTER
    resource.type="cloud_run_revision"
    log_id("run.googleapis.com/requests")
    httpRequest.requestUrl =~ "^${replace(local.hosting_origin, ".", "\\.")}([/:?]|$)"
  FILTER
}
