# Application request logs are disabled; ingress URL logs also contain app secrets.
resource "google_logging_project_exclusion" "preview_requests" {
  count       = var.preview_origin != "" ? 1 : 0
  name        = "preview-requests"
  description = "Do not retain preview paths or query strings in Cloud Run request logs"
  filter      = <<-FILTER
    resource.type="cloud_run_revision"
    log_id("run.googleapis.com/requests")
    httpRequest.requestUrl =~ "^https://p[1-9][0-9]{0,4}-o[0-9a-f-]{36}\.${replace(trimprefix(var.preview_origin, "https://"), ".", "\\.")}([/:?]|$)"
  FILTER
}

# Wildcard HTTPS edge for preview hosts (docs/http-exposure.md). The zone and
# its delegation are foundation-owned; this root writes only its records.
locals {
  preview_count  = var.preview_origin != "" ? 1 : 0
  preview_domain = trimprefix(var.preview_origin, "https://")
}

resource "google_compute_global_address" "preview" {
  count = local.preview_count
  name  = "pi-orb-preview"
}

resource "google_certificate_manager_dns_authorization" "preview" {
  count  = local.preview_count
  name   = "pi-orb-preview"
  domain = local.preview_domain
}

resource "google_dns_record_set" "preview_certificate_authorization" {
  count        = local.preview_count
  managed_zone = "pi-orb-preview"
  name         = google_certificate_manager_dns_authorization.preview[0].dns_resource_record[0].name
  type         = google_certificate_manager_dns_authorization.preview[0].dns_resource_record[0].type
  ttl          = 300
  rrdatas      = [google_certificate_manager_dns_authorization.preview[0].dns_resource_record[0].data]
}

resource "google_certificate_manager_certificate" "preview" {
  count = local.preview_count
  name  = "pi-orb-preview"
  managed {
    domains            = ["*.${local.preview_domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.preview[0].id]
  }
}

resource "google_certificate_manager_certificate_map" "preview" {
  count = local.preview_count
  name  = "pi-orb-preview"
}

resource "google_certificate_manager_certificate_map_entry" "preview" {
  count        = local.preview_count
  name         = "pi-orb-preview-wildcard"
  map          = google_certificate_manager_certificate_map.preview[0].name
  hostname     = "*.${local.preview_domain}"
  certificates = [google_certificate_manager_certificate.preview[0].id]
}

resource "google_compute_region_network_endpoint_group" "preview" {
  count                 = local.preview_count
  name                  = "pi-orb-preview"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloud_run_v2_service.issuer.name
  }
}

# Edge request logs would retain preview paths and queries.
resource "google_compute_backend_service" "preview" {
  count                 = local.preview_count
  name                  = "pi-orb-preview"
  protocol              = "HTTPS"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  backend {
    group = google_compute_region_network_endpoint_group.preview[0].id
  }
  log_config {
    enable = false
  }
}

resource "google_compute_url_map" "preview" {
  count           = local.preview_count
  name            = "pi-orb-preview"
  default_service = google_compute_backend_service.preview[0].id
}

resource "google_compute_target_https_proxy" "preview" {
  count           = local.preview_count
  name            = "pi-orb-preview"
  url_map         = google_compute_url_map.preview[0].id
  certificate_map = "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.preview[0].id}"
}

resource "google_compute_global_forwarding_rule" "preview" {
  count                 = local.preview_count
  name                  = "pi-orb-preview"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_address            = google_compute_global_address.preview[0].address
  port_range            = "443"
  target                = google_compute_target_https_proxy.preview[0].id
}

resource "google_dns_record_set" "preview_wildcard" {
  count        = local.preview_count
  managed_zone = "pi-orb-preview"
  name         = "*.${local.preview_domain}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_global_address.preview[0].address]
}
