# Process samples complement Cloud Run's ingress and resource metrics.
locals {
  http_diagnostic_units = {
    interval_ms                     = "ms"
    listening                       = "1"
    fd_count                        = "1"
    inbound_connections             = "1"
    upgraded_connections            = "1"
    outbound_connections            = "1"
    inbound_half_closed_connections = "1"
    oldest_inbound_connection_ms    = "ms"
    oldest_upgraded_connection_ms   = "ms"
    requests_in_flight              = "1"
    oldest_request_ms               = "ms"
    last_public_request_age_ms      = "ms"
    connections_accepted            = "1"
    public_requests_started         = "1"
    health_requests_started         = "1"
    responses_finished              = "1"
    responses_closed_early          = "1"
    server_errors                   = "1"
    client_errors                   = "1"
    socket_errors                   = "1"
    transport_events_suppressed     = "1"
    process_cpu_percent             = "%"
    main_thread_cpu_percent         = "%"
    process_cpu_peak_percent        = "%"
    main_thread_cpu_peak_percent    = "%"
    cpu_sample_max_interval_ms      = "ms"
    event_loop_utilization_percent  = "%"
    event_loop_delay_p99_ms         = "ms"
    event_loop_delay_max_ms         = "ms"
    gc_count                        = "1"
    gc_total_ms                     = "ms"
    gc_max_ms                       = "ms"
  }
}

resource "google_logging_metric" "http_diagnostics" {
  for_each        = local.http_diagnostic_units
  project         = var.project
  name            = "pi_orb/http/${each.key}"
  description     = "Control-plane ${each.key}; 30-second process samples. See docs/deployment.md for aggregation."
  filter          = <<-FILTER
    resource.type="cloud_run_revision"
    resource.labels.service_name="${google_cloud_run_v2_service.issuer.name}"
    jsonPayload.message="control-plane.http"
    jsonPayload.${each.key}>=0
  FILTER
  value_extractor = "EXTRACT(jsonPayload.${each.key})"
  metric_descriptor {
    metric_kind  = "DELTA"
    value_type   = "DISTRIBUTION"
    unit         = each.value
    display_name = "Control-plane HTTP ${each.key}"
  }
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1
    }
  }
}
