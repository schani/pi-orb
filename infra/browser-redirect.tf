# Browser bookmarks enter through the former application origin.
resource "google_cloud_run_v2_service" "browser_redirect" {
  name                 = "pi-orb"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    # This identity can only write logs; it has no application data access.
    service_account = local.image_builder_email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    containers {
      image   = var.control_plane_image
      command = ["node"]
      args    = ["infra/browser-redirect.mjs"]
      env {
        name  = "PI_ORB_REDIRECT_ORIGIN"
        value = local.app_origin
      }
      resources {
        limits   = { cpu = "1", memory = "256Mi" }
        cpu_idle = true
      }
    }
  }
}
