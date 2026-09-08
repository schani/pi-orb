# pi-orb static plane (docs/deployment.md). Per-orb VMs are dynamic resources
# created by GceOrbHostProvider and are never managed here. Images are built
# and pushed by build-push.sh, digests passed as vars.
#
# State lives in GCS (versioned bucket) — the original local state was lost
# with its working directory, so every pre-existing resource is adopted via
# the import blocks in imports.tf/network.tf/iam.tf on the first apply.

terraform {
  backend "gcs" {
    prefix = "static-plane"
  }

  required_providers {
    google = {
      source  = "opentofu/google"
      version = "~> 6.0"
    }
    random = {
      source  = "opentofu/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
}

data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.foundation_state_bucket
    prefix = "foundation"
  }
}

locals {
  foundation                = data.terraform_remote_state.foundation.outputs
  control_plane_email       = local.foundation.control_plane_service_account_email
  orb_vm_email              = local.foundation.orb_vm_service_account_email
  issuer_email              = local.foundation.issuer_service_account_email
  artifact_registry_repo    = local.foundation.artifact_registry_repository
  image_builder_email       = local.foundation.image_builder_service_account_email
  foundation_deployer_email = local.foundation.deployer_service_account_email
  pi_orb_network            = local.foundation.pi_orb_network
  orb_subnetwork            = local.foundation.orb_subnetwork
  orb_subnetwork_resource   = local.foundation.orb_subnetwork_resource
  run_egress_subnetwork     = local.foundation.run_egress_subnetwork
  run_egress_cidr           = local.foundation.run_egress_cidr
}

resource "terraform_data" "foundation_guard" {
  input = local.foundation.foundation_schema_version

  lifecycle {
    precondition {
      condition     = local.foundation.foundation_schema_version == 1
      error_message = "Unsupported or unadopted foundation state."
    }
    precondition {
      condition     = local.foundation.project == var.project && local.foundation.region == var.region && local.foundation.zone == var.zone
      error_message = "Foundation project, region, and zone must match the application root."
    }
  }
}
