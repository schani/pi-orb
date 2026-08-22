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

# The public OIDC issuer origin: the exact `iss` of every minted token, the
# `--issuer-uri` the workload-identity bootstrap must register, and the base the
# federation smoke fetches discovery and JWKS from. The service's postcondition
# guarantees this equals `local.oidc_issuer_url`.
output "issuer_url" {
  value = google_cloud_run_v2_service.issuer.uri
}
