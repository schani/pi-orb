# The two Cloud Run services (DESIGN.md §15.1 "Cloud exposure"): one image,
# role env var as the hard route allowlist. IAP on the browser service is
# enabled by deploy.sh (gcloud) — the provider's IAP-on-Cloud-Run support
# is still settling; revisit when it is stable.

locals {
  shared_env = {
    PI_ORB_ROLE_UNUSED          = "per-service"
    PI_ORB_SECRET_STORE         = "gsm"
    PI_ORB_GCP_PROJECT          = var.project
    PI_ORB_HOST_PROVIDER        = "gce"
    PI_ORB_GCE_ZONE             = var.zone
    PI_ORB_GCE_SERVICE_ACCOUNT  = google_service_account.orb_vm.email
    PI_ORB_GCE_SUBNETWORK       = "regions/${var.region}/subnetworks/${google_compute_subnetwork.orbs.name}"
    PI_ORB_RUNTIME_IMAGE        = var.runtime_image
  }
}

resource "google_cloud_run_v2_service" "runtime" {
  name                = "pi-orb-runtime-api"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true
  deletion_protection = false

  template {
    service_account = google_service_account.control_plane.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "runtime"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = { for k, v in local.shared_env : k => v if k != "PI_ORB_ROLE_UNUSED" }
        content {
          name  = env.key
          value = env.value
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.cp_reads_database_url]
}

resource "google_cloud_run_v2_service" "browser" {
  name                = "pi-orb"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.control_plane.email
    timeout         = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "browser"
      }
      env {
        name  = "PI_ORB_BROKER_URL"
        value = google_cloud_run_v2_service.runtime.uri
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = { for k, v in local.shared_env : k => v if k != "PI_ORB_ROLE_UNUSED" }
        content {
          name  = env.key
          value = env.value
        }
      }
      resources {
        limits             = { cpu = "1", memory = "1Gi" }
        cpu_idle           = false # always-allocated CPU: the poller/reconciler run here
        startup_cpu_boost  = true
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.cp_reads_database_url]
}
