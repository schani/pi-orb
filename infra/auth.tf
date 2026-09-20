variable "google_client_id" {
  description = "Manually registered Google web OAuth client; both origin callbacks must be registered."
  type        = string
  validation {
    condition     = length(var.google_client_id) > 0
    error_message = "Google client ID is required."
  }
}

variable "google_client_secret" {
  type      = string
  sensitive = true
  validation {
    condition     = length(var.google_client_secret) > 0
    error_message = "Google client secret is required."
  }
}

variable "cookie_secret" {
  description = "Restart-stable cookie sealing secret; generate at least 32 random bytes."
  type        = string
  sensitive   = true
  validation {
    condition     = length(var.cookie_secret) >= 32
    error_message = "Cookie secret must contain at least 32 characters."
  }
}

variable "machine_subject" {
  description = "Immutable uniqueId of pi-orb-debug, independently verified by an administrator."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{10,32}$", var.machine_subject))
    error_message = "Machine subject must be the debug service account's numeric uniqueId, not its email."
  }
}

locals {
  auth_secrets = {
    google_client_secret = var.google_client_secret
    cookie_secret        = var.cookie_secret
  }
}

resource "google_secret_manager_secret" "auth" {
  for_each  = toset(["google_client_secret", "cookie_secret"])
  secret_id = "pi-orb-${replace(each.key, "_", "-")}"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "auth" {
  for_each    = google_secret_manager_secret.auth
  secret      = each.value.id
  secret_data = local.auth_secrets[each.key]
}

resource "google_secret_manager_secret_iam_member" "cp_auth" {
  for_each  = google_secret_manager_secret.auth
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.control_plane_email}"
}

resource "google_logging_project_exclusion" "google_callback" {
  name        = "google-auth-callback"
  description = "Do not retain Google authorization callback query strings"
  filter      = "httpRequest.requestUrl:\"/auth/callback\""
}
