output "app_url" {
  value      = local.app_origin
  depends_on = [google_cloud_run_v2_service.issuer]
}

output "hosting_url" {
  value      = local.hosting_origin
  depends_on = [google_cloud_run_v2_service.issuer]
}

output "sql_private_ip" {
  value = google_sql_database_instance.pi_orb.private_ip_address
}

# Public OIDC issuer origin: the exact `iss` of every minted token, the
# `--issuer-uri` the workload-identity bootstrap registers, and the base for the
# federation smoke's discovery and JWKS fetches. Cloud Run's `.uri` is a hashed
# origin instead; the issuer service postcondition checks this one is among them.
output "issuer_url" {
  value      = local.oidc_issuer_url
  depends_on = [google_cloud_run_v2_service.issuer]
}

# The zone orb VMs are created in (`var.zone`, not derivable from `var.region`).
# release.sh exports it as PI_ORB_GCE_ZONE for the live smokes; guessing
# `<region>-a` finds no instances and fails releases for an unrelated reason.
output "zone" {
  value = var.zone
}

output "orb_subnetwork" {
  value = local.orb_subnetwork
}

output "image_builder_service_account_email" {
  value = local.image_builder_email
}
