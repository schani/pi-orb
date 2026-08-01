# pi-orb static plane (DESIGN.md §3.6). Per-orb VMs are dynamic resources
# created by GceOrbHostProvider and are never managed here. Images are built
# and pushed by build-push.sh, digests passed as vars.
#
# State lives in GCS (versioned bucket) — the original local state was lost
# with its working directory, so every pre-existing resource is adopted via
# the import blocks in imports.tf/network.tf/iam.tf on the first apply.

terraform {
  backend "gcs" {
    bucket = "pi-orb-tfstate-playground-dev-6ae7"
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

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "compute.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "artifactregistry.googleapis.com",
    "iap.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}
