# VPC and subnets. The VPC, orb subnet, orb-VM service account, and Artifact
# Registry repo predate this plane (created during the validation exercise)
# and are adopted via import blocks.

import {
  to = google_compute_network.pi_orb
  id = "projects/${var.project}/global/networks/pi-orb"
}

resource "google_compute_network" "pi_orb" {
  name                    = "pi-orb"
  auto_create_subnetworks = false
}

import {
  to = google_compute_subnetwork.orbs
  id = "projects/${var.project}/regions/${var.region}/subnetworks/pi-orb-us-central1"
}

resource "google_compute_subnetwork" "orbs" {
  name                     = "pi-orb-us-central1"
  network                  = google_compute_network.pi_orb.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/20"
  private_ip_google_access = true
}

# Dedicated subnet for Cloud Run Direct VPC egress: the firewall below can
# then admit only control-plane traffic to orb runtimes, not orb-to-orb.
resource "google_compute_subnetwork" "run_egress" {
  name                     = "pi-orb-run-egress"
  network                  = google_compute_network.pi_orb.id
  region                   = var.region
  ip_cidr_range            = "10.10.16.0/26"
  private_ip_google_access = true
}

resource "google_compute_firewall" "control_plane_to_runtime" {
  name          = "pi-orb-cp-to-runtime"
  network       = google_compute_network.pi_orb.id
  direction     = "INGRESS"
  source_ranges = [google_compute_subnetwork.run_egress.ip_cidr_range]
  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

# Release smoke reaches disposable orb VMs through Identity-Aware Proxy, never
# over their public address. The source range is Google's fixed TCP-forwarding
# range, and the target service account limits the rule to pi-orb hosts rather
# than every VM attached to this VPC.
resource "google_compute_firewall" "iap_to_orb_ssh" {
  name                    = "pi-orb-iap-to-orb-ssh"
  network                 = google_compute_network.pi_orb.id
  direction               = "INGRESS"
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.orb_vm.email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}

# Private services access for Cloud SQL private IP.
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
  depends_on              = [google_project_service.apis]
}
