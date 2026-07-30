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
  description = "Google Workspace domain allowed through IAP (hardcoded decision, DESIGN.md §3.6)."
  type        = string
  default     = "heyglide.com"
}

variable "control_plane_image" {
  description = "Digest-pinned control-plane image (from build-push.sh)."
  type        = string
}

variable "runtime_image" {
  description = "Digest-pinned orb runtime image (from build-push.sh)."
  type        = string
}
