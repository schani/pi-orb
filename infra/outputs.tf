output "browser_url" {
  value = google_cloud_run_v2_service.browser.uri
}

output "runtime_url" {
  value = google_cloud_run_v2_service.runtime.uri
}

output "sql_private_ip" {
  value = google_sql_database_instance.pi_orb.private_ip_address
}

output "ops_url" {
  value = google_cloud_run_v2_service.ops.uri
}
