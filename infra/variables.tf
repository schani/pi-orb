variable "project" {
  type    = string
  default = "playground-dev-6ae7"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "iap_domain" {
  description = "Google Workspace domain allowed through IAP (hardcoded decision, docs/deployment.md)."
  type        = string
  default     = "heyglide.com"
}

variable "github_client_id" {
  description = "GitHub App client id for the gh/user-token flow (docs/credentials.md); empty disables the integration. Public by nature — it travels in every device-flow request; the client secret lives only in Secret Manager."
  type        = string
  default     = "Iv23liA7Aecbetq28EHv"
}

variable "control_plane_image" {
  description = "Digest-pinned control-plane image (from build-push.sh)."
  type        = string
}

variable "runtime_image" {
  description = "Digest-pinned orb runtime image (from build-push.sh)."
  type        = string
}
