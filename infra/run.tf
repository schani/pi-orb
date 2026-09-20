# Single application; the issuer resource and exact trust origin are retained.
locals {
  hosting_env = {
    PI_ORB_HOSTING_STORE  = "gcs"
    PI_ORB_HOSTING_BUCKET = google_storage_bucket.hosting.name
    PI_ORB_HOSTING_ORIGIN = local.hosting_origin
    PI_ORB_APP_ORIGIN     = local.app_origin
  }
  shared_env = merge(
    {
      PI_ORB_SECRET_STORE                 = "gsm"
      PI_ORB_GCP_PROJECT                  = var.project
      PI_ORB_HOST_PROVIDER                = "gce"
      PI_ORB_GCE_ZONE                     = var.zone
      PI_ORB_GCE_MACHINE_TYPE             = "n2d-highmem-2"
      PI_ORB_GCE_SERVICE_ACCOUNT          = local.orb_vm_email
      PI_ORB_GCE_SUBNETWORK               = local.orb_subnetwork_resource
      PI_ORB_GCE_IMAGE_RESOURCE           = var.native_image_resource
      PI_ORB_GCE_IMAGE_ID                 = var.native_image_id
      PI_ORB_GCE_WORKSPACE_IMAGE_RESOURCE = var.workspace_image_resource
      PI_ORB_GCE_WORKSPACE_IMAGE_ID       = var.workspace_image_id
      # Always set, so a revision's fence is explicit rather than inherited
      # from a default (docs/host-provider.md).
      PI_ORB_HOST_SPEC_GENERATION = tostring(var.deploy_generation)
    },
    var.github_client_id != "" ? { PI_ORB_GITHUB_CLIENT_ID = var.github_client_id } : {},
    var.tailscale_oauth_client_id != "" ? {
      PI_ORB_TAILSCALE_OAUTH_CLIENT_ID  = var.tailscale_oauth_client_id
      PI_ORB_TAILSCALE_TAILNET_DNS_NAME = var.tailscale_tailnet_dns_name
    } : {},
  )
}

resource "google_cloud_run_v2_service" "issuer" {
  name                 = local.issuer_service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  deletion_protection  = false

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
    tag     = "files"
  }

  template {
    service_account = local.control_plane_email
    timeout         = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = local.pi_orb_network
        subnetwork = local.run_egress_subnetwork
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_RELEASE_ACTIVATION_BUCKET"
        value = local.foundation.state_bucket
      }
      env {
        name  = "PI_ORB_AUTH_MODE"
        value = "google"
      }
      env {
        name  = "PI_ORB_GOOGLE_CLIENT_ID"
        value = var.google_client_id
      }
      env {
        name  = "PI_ORB_MACHINE_SUBJECT"
        value = var.machine_subject
      }
      env {
        name  = "PI_ORB_OIDC_ISSUER_URL"
        value = local.oidc_issuer_url
      }
      dynamic "env" {
        for_each = { PI_ORB_GOOGLE_CLIENT_SECRET = "google_client_secret", PI_ORB_COOKIE_SECRET = "cookie_secret" }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.auth[env.value].secret_id
              version = google_secret_manager_secret_version.auth[env.value].version
            }
          }
        }
      }
      env {
        name  = "PI_ORB_BROKER_URL"
        value = local.app_origin
      }
      dynamic "env" {
        for_each = local.hosting_env
        content {
          name  = env.key
          value = env.value
        }
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
        for_each = local.shared_env
        content {
          name  = env.key
          value = env.value
        }
      }
      # The GitHub device-login gate (reconciler) needs the app client secret.
      dynamic "env" {
        for_each = var.github_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_GITHUB_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.github_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      # The reconciler mints a per-orb tailnet auth key at host creation.
      dynamic "env" {
        for_each = var.tailscale_oauth_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.tailscale_oauth_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      resources {
        limits            = { cpu = "1", memory = "1Gi" }
        cpu_idle          = false # always-allocated CPU: the poller/reconciler run here
        startup_cpu_boost = true
      }
    }
  }
  lifecycle {
    postcondition {
      condition     = contains(self.urls, local.app_origin)
      error_message = "Cloud Run did not assign the canonical app origin."
    }
  }
  depends_on = [
    google_logging_project_exclusion.mcp_oauth_callback,
    google_logging_project_exclusion.google_callback,
    google_secret_manager_secret_iam_member.cp_auth,
    google_secret_manager_secret_iam_member.cp_mcp_oauth_accessor,
    google_secret_manager_secret_iam_member.cp_mcp_oauth_versions,
    google_storage_bucket_iam_member.control_plane_hosting_objects,
    google_secret_manager_secret_iam_member.cp_reads_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}
