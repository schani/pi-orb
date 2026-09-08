# Private object storage for orb-hosted files (docs/hosting.md). PostgreSQL owns
# publication and cleanup state; this bucket contains only immutable file bytes.
locals {
  browser_service_name = "pi-orb"
  app_origin           = "https://${local.browser_service_name}-${local.foundation.project_number}.${var.region}.run.app"
  hosting_origin       = "https://files---${local.browser_service_name}-${local.foundation.project_number}.${var.region}.run.app"
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
