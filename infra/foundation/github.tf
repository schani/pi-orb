# Only this manually dispatched workflow on this repository's main branch can
# assume the existing scoped deployer. Audience alone is not an admission rule.
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "pi-orb-github"
  display_name              = "pi-orb GitHub deployment"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "deploy"
  display_name                       = "Manual main deployment"
  attribute_mapping = {
    "google.subject"          = "assertion.sub"
    "attribute.repository_id" = "assertion.repository_id"
  }
  attribute_condition = join(" && ", [
    "assertion.repository_id == '1307054237'",
    "assertion.repository_owner_id == '61363'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.event_name == 'workflow_dispatch'",
    "assertion.workflow_ref == 'schani/pi-orb/.github/workflows/deploy.yml@refs/heads/main'",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_deployer_admission" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/1307054237"
}

output "github_workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "trusted_pi_orb_project_id" {
  value = var.trusted_pi_orb_project_id
}
