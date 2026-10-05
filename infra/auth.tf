variable "google_client_id" {
  description = "Manually registered Google web OAuth client; both origin callbacks must be registered."
  type        = string
  validation {
    condition     = length(var.google_client_id) > 0
    error_message = "Google client ID is required."
  }
}

variable "machine_subject" {
  description = "Immutable uniqueId of the existing pi-orb-debug service account."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{10,32}$", var.machine_subject))
    error_message = "Machine subject must be the debug service account's numeric uniqueId, not its email."
  }
}

data "google_secret_manager_secret" "auth" {
  for_each  = toset(["google_client_secret", "cookie_secret"])
  secret_id = "pi-orb-${replace(each.key, "_", "-")}"
}

resource "google_secret_manager_secret_iam_member" "cp_auth" {
  for_each  = data.google_secret_manager_secret.auth
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.control_plane_email}"
}

resource "google_logging_project_exclusion" "google_callback" {
  name        = "google-auth-callback"
  description = "Do not retain Google authorization callback query strings"
  filter      = "httpRequest.requestUrl:\"/auth/callback\""
}
