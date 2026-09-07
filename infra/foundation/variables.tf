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

variable "state_bucket" {
  type    = string
  default = "pi-orb-tfstate-playground-dev-6ae7"
}

variable "trusted_pi_orb_project_id" {
  description = "Immutable pi-orb project UUID admitted to recurring deployment authority."
  type        = string
  default     = "eacd1d25-2825-4c3a-a26b-3923baa86801"
}

variable "trusted_amp_project_id" {
  type    = string
  default = "cad0f81a-f72a-40be-ba23-4238ce350328"
}

variable "trusted_amp_user_id" {
  type    = string
  default = "user_01JYNTQK807VHERYA25EAND4SM"
}

variable "adopt_legacy_deployer_grants" {
  description = "Transitional adoption only: expose obsolete grants so they can be imported, then plan with the default false to remove them."
  type        = bool
  default     = false
}
