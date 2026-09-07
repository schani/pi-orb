resource "google_service_account" "orb_vm" {
  account_id   = "pi-orb-orb-vm"
  display_name = "pi-orb orb VM (minimal)"
}

resource "google_service_account" "control_plane" {
  account_id   = "pi-orb-control-plane"
  display_name = "pi-orb control plane"
}

resource "google_service_account" "issuer" {
  account_id   = "pi-orb-issuer"
  display_name = "pi-orb public OIDC issuer"
}

# This is the identity attached to disposable image-builder VMs. Build
# orchestration runs as the deployer; the builder itself can only emit logs.
resource "google_service_account" "image_builder" {
  account_id   = "pi-orb-image-builder"
  display_name = "pi-orb native image builder VM"
}

resource "google_service_account" "deployer" {
  account_id   = "pi-orb-amp-deployer"
  display_name = "pi-orb Amp deployer"
}

resource "google_project_iam_member" "orb_vm_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.orb_vm.email}"
}

resource "google_project_iam_member" "image_builder_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.image_builder.email}"
}

resource "google_project_iam_member" "issuer_log_writer" {
  project = var.project
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.issuer.email}"
}

resource "google_project_iam_member" "control_plane_image_user" {
  project = var.project
  role    = "roles/compute.imageUser"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
  condition {
    title       = "pi-orb-images-only"
    description = "Read only pi-orb native runtime images."
    expression  = "resource.type == \"compute.googleapis.com/Image\" && resource.name.startsWith(\"projects/${var.project}/global/images/pi-orb-\")"
  }
}

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

resource "google_project_iam_member" "cp_compute_viewer" {
  project = var.project
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.control_plane.email}"
}

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

resource "google_project_iam_member" "deployer_build_compute" {
  project = var.project
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "pi-orb-image-builders-only"
    description = "Create and remove disposable native image builders."
    expression = join(" || ", [
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/instances/pi-orb-builder-\")",
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/instances/pi-orb-validator-\")",
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/disks/pi-orb-builder-\")",
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/disks/pi-orb-validator-\")",
      "resource.name.startsWith(\"projects/${var.project}/zones/${var.zone}/disks/pi-orb-data-\")",
      "resource.name.startsWith(\"projects/${var.project}/regions/${var.region}/subnetworks/pi-orb\")",
    ])
  }
}

resource "google_project_iam_member" "deployer_application_firewalls" {
  project = var.project
  role    = "roles/compute.securityAdmin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "pi-orb-application-firewalls-only"
    description = "Manage only the recurring application's firewall rules."
    expression = join(" || ", [
      "resource.type == \"compute.googleapis.com/Firewall\" && resource.name == \"projects/${var.project}/global/firewalls/pi-orb-cp-to-runtime\"",
      "resource.type == \"compute.googleapis.com/Firewall\" && resource.name == \"projects/${var.project}/global/firewalls/pi-orb-iap-to-orb-ssh\"",
    ])
  }
}

resource "google_project_iam_member" "deployer_image_admin" {
  project = var.project
  role    = "roles/compute.storageAdmin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "pi-orb-images-only"
    description = "Publish and retire only pi-orb native runtime images."
    expression  = "resource.type == \"compute.googleapis.com/Image\" && resource.name.startsWith(\"projects/${var.project}/global/images/pi-orb-\")"
  }
}

resource "google_project_iam_member" "deployer_iap_tunnel" {
  project = var.project
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "pi-orb-image-builders-only"
    description = "Open IAP tunnels only to disposable image build instances."
    expression  = "destination.port == 22 && destination.ip.startsWith(\"${local.image_build_ipv4_prefix}\")"
  }
}

resource "google_project_iam_member" "deployer_application_iap_admin" {
  project = var.project
  role    = "roles/iap.admin"
  member  = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "cloud-run-iap-web-services-only"
    description = "Manage IAP web-service policies without granting tunnel administration."
    expression  = "resource.type == \"iap.googleapis.com/WebService\""
  }
}

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.pi_orb.location
  repository = google_artifact_registry_repository.pi_orb.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

locals {
  deployer_project_roles = toset([
    "roles/cloudsql.admin",
    "roles/compute.viewer",
    "roles/logging.viewer",
    "roles/monitoring.viewer",
    "roles/run.admin",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  obsolete_deployer_project_roles = toset([
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/compute.networkAdmin",
    "roles/iap.admin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/servicenetworking.networksAdmin",
    "roles/serviceusage.serviceUsageAdmin",
  ])
}

# Existing projects import these exact historical member bindings with
# adopt_legacy_deployer_grants=true. Returning to the default false produces a
# reviewed destroy plan for only this deployer member, without authoritative IAM
# bindings that could revoke another administrator.
resource "google_project_iam_member" "obsolete_deployer" {
  for_each = var.adopt_legacy_deployer_grants ? local.obsolete_deployer_project_roles : toset([])
  project  = var.project
  role     = each.key
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_project_iam_member" "deployer" {
  for_each = local.deployer_project_roles
  project  = var.project
  role     = each.key
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_state_objects" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "application-state-only"
    description = "Recurring deploys mutate only application state and its release lock."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.state.name}/objects/static-plane/\")"
  }
}

resource "google_storage_bucket_iam_member" "deployer_state_reader" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.legacyBucketReader"
  member = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_storage_bucket_iam_member" "deployer_foundation_state_reader" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.deployer.email}"
  condition {
    title       = "foundation-state-read-only"
    description = "Read stable foundation outputs without changing foundation state."
    expression  = "resource.name.startsWith(\"projects/_/buckets/${google_storage_bucket.state.name}/objects/foundation/\")"
  }
}

resource "google_service_account_iam_member" "deployer_uses_runtime_accounts" {
  for_each = {
    control_plane = google_service_account.control_plane.name
    issuer        = google_service_account.issuer.name
    orb_vm        = google_service_account.orb_vm.name
    image_builder = google_service_account.image_builder.name
  }
  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
