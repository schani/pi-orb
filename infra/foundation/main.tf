terraform {
  backend "gcs" {
    prefix = "foundation"
  }

  required_providers {
    google = {
      source  = "opentofu/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project
  region  = var.region
}

data "google_project" "pi_orb" {}

resource "google_project_service" "apis" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "logging.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

locals {
  image_build_ipv4_prefix = "10.11.0."
  orb_ipv4_cidr           = "10.10.0.0/20"
  orb_ipv4_prefixes       = [for octet in range(16) : "10.10.${octet}."]
}

resource "google_compute_network" "image_build" {
  name                    = "pi-orb-image-build"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "image_build" {
  name                     = "pi-orb-image-build-${var.region}"
  network                  = google_compute_network.image_build.id
  region                   = var.region
  ip_cidr_range            = "${local.image_build_ipv4_prefix}0/24"
  private_ip_google_access = true
}

resource "google_compute_firewall" "iap_to_image_builder" {
  name                    = "pi-orb-iap-to-image-builder"
  network                 = google_compute_network.image_build.id
  direction               = "INGRESS"
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.image_builder.email, google_service_account.orb_vm.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

resource "google_compute_network" "pi_orb" {
  name                    = "pi-orb"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "orbs" {
  name                     = "pi-orb-${var.region}"
  network                  = google_compute_network.pi_orb.id
  region                   = var.region
  ip_cidr_range            = local.orb_ipv4_cidr
  private_ip_google_access = true
}

resource "google_compute_subnetwork" "run_egress" {
  name                     = "pi-orb-run-egress"
  network                  = google_compute_network.pi_orb.id
  region                   = var.region
  ip_cidr_range            = "10.10.16.0/26"
  private_ip_google_access = true
}

resource "google_compute_global_address" "private_services" {
  name          = "pi-orb-private-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.pi_orb.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.pi_orb.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]
}

resource "google_compute_subnetwork_iam_member" "deployer_uses_orbs" {
  project    = var.project
  region     = var.region
  subnetwork = google_compute_subnetwork.orbs.name
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_compute_subnetwork_iam_member" "deployer_uses_run_egress" {
  project    = var.project
  region     = var.region
  subnetwork = google_compute_subnetwork.run_egress.name
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_compute_subnetwork_iam_member" "deployer_uses_image_build" {
  project    = var.project
  region     = var.region
  subnetwork = google_compute_subnetwork.image_build.name
  role       = "roles/compute.networkUser"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket" "state" {
  name                        = var.state_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_artifact_registry_repository" "pi_orb" {
  repository_id = "pi-orb"
  location      = var.region
  format        = "DOCKER"
  depends_on    = [google_project_service.apis]
}
