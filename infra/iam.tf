# Service accounts. The orb-VM SA predates this plane (imported); the
# control-plane SA is new. Least privilege per docs/credentials.md.

import {
  to = google_service_account.orb_vm
  id = "projects/${var.project}/serviceAccounts/pi-orb-orb-vm@${var.project}.iam.gserviceaccount.com"
}

resource "google_service_account" "orb_vm" {
  account_id   = "pi-orb-orb-vm"
  display_name = "pi-orb orb VM (minimal)"
}

resource "google_project_iam_member" "orb_vm_ar_reader" {
  project = var.project
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.orb_vm.email}"
}

resource "google_project_iam_member" "orb_vm_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.orb_vm.email}"
}

resource "google_service_account" "control_plane" {
  account_id   = "pi-orb-control-plane"
  display_name = "pi-orb control plane"
}

# Provision/start/stop orb VMs and attach their disks — but only pi-orb's
# own resources: the project may host other services' VMs, and this binding
# must not be able to touch them even through a control-plane bug. Instances
# and their boot disks are named pi-orb-<uuid>, data disks pi-orb-data-<uuid>,
# and instance creation needs `use` on the pi-orb subnets; everything else in
# compute is out of reach for mutations.
resource "google_project_iam_member" "cp_compute_admin" {
  project = var.project
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
  condition {
    title       = "pi-orb-resources-only"
    description = "Restrict mutations to pi-orb instances, disks, and subnets."
    expression = join(" || ", [
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/instances/pi-orb-\")",
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/disks/pi-orb-\")",
      "resource.name.startsWith(\"projects/${var.project}/regions/${var.region}/subnetworks/pi-orb\")",
    ])
  }
}

# Reads are project-wide: list, get, guest attributes, and zone-operation
# waits target collection/operation resources whose names can never match
# the condition above, so the conditioned admin binding cannot cover them.
# compute.viewer grants no mutations.
resource "google_project_iam_member" "cp_compute_viewer" {
  project = var.project
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

# Required to create VMs that run as the orb-VM service account.
resource "google_service_account_iam_member" "cp_uses_orb_vm" {
  service_account_id = google_service_account.orb_vm.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_project_iam_member" "cp_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

import {
  to = google_artifact_registry_repository.pi_orb
  id = "projects/${var.project}/locations/${var.region}/repositories/pi-orb"
}

resource "google_artifact_registry_repository" "pi_orb" {
  repository_id = "pi-orb"
  location      = var.region
  format        = "DOCKER"
}
