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

variable "foundation_state_bucket" {
  description = "Bucket containing the separately administered foundation state."
  type        = string
  default     = "pi-orb-tfstate-playground-dev-6ae7"
}

variable "preview_origin" {
  description = "Optional exact HTTPS base origin for a separately operated Host-preserving preview TLS edge; empty disables registration. Registrable-domain separation from app/files is validated by the control plane."
  type        = string
  default     = ""
  validation {
    condition     = var.preview_origin == "" || can(regex("^https://[a-z0-9]+([.-][a-z0-9]+)*$", var.preview_origin))
    error_message = "preview_origin must be empty or an exact lowercase HTTPS DNS origin without path, query, fragment or port."
  }
}

variable "github_client_id" {
  description = "GitHub App client id for the gh/user-token flow (docs/credentials.md); empty disables the integration. Public by nature — it travels in every device-flow request; the client secret lives only in Secret Manager."
  type        = string
  default     = "Iv23liA7Aecbetq28EHv"
}

variable "deploy_generation" {
  description = "Monotonic script generation for forward-only repair fencing (docs/host-provider.md); release.sh clamps build-push.sh's candidate above the currently serving generation. An apply that omits it runs at generation 0: such a revision never repairs a host stamped by a real deploy, so a forgotten var delays an upgrade to the next deploy instead of repairing anything backward."
  type        = number
  default     = 0
}

variable "control_plane_image" {
  description = "Digest-pinned control-plane image (from build-push.sh)."
  type        = string
}

variable "native_image_resource" {
  description = "Accepted native VM image resource (from build-push.sh)."
  type        = string
  validation {
    condition     = can(regex("^projects/[a-z0-9-]+/global/images/pi-orb-[a-z0-9-]+$", var.native_image_resource))
    error_message = "An exact pi-orb image resource is required."
  }
}

variable "native_image_id" {
  description = "Numeric GCE identity of the accepted image, pinned against name reuse."
  type        = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.native_image_id))
    error_message = "A numeric GCE image identity is required."
  }
}

variable "workspace_image_resource" {
  description = "Accepted empty-ext4 workspace image resource (from build-push.sh)."
  type        = string
  validation {
    condition     = can(regex("^projects/[a-z0-9-]+/global/images/pi-orb-[a-z0-9-]+$", var.workspace_image_resource))
    error_message = "An exact pi-orb workspace image resource is required."
  }
}

variable "workspace_image_id" {
  description = "Numeric GCE identity of the accepted workspace image, pinned against name reuse."
  type        = string
  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.workspace_image_id))
    error_message = "A numeric GCE workspace image identity is required."
  }
}
