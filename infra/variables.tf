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

variable "tailscale_oauth_client_id" {
  description = "Tailscale OAuth client id used to mint per-orb auth keys (docs/ports.md); empty disables port exposure. An identifier, not a credential — it grants nothing without the client secret, which lives only in Secret Manager. The client must own tag:pi-orb."
  type        = string
  default     = "kcjtdpKcAL11CNTRL"
}

variable "tailscale_tailnet_dns_name" {
  description = "MagicDNS suffix of the tailnet; orbs are reachable at pi-orb-<orbId>.<this> by tailnet members only — the name itself grants no access."
  type        = string
  default     = "tail8fb2d0.ts.net"
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
