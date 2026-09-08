locals {
  pi_orb_pool_id     = "pi-orb-orbs"
  pi_orb_provider_id = "pi-orb-oidc"
  amp_pool_id        = "amp-orbs"
  amp_provider_id    = "amp-oidc"
  pi_orb_issuer_url  = "https://pi-orb-issuer-${data.google_project.pi_orb.number}.${var.region}.run.app"
  pi_orb_audience    = "urn:pi-orb:gcp:${var.project}"
  amp_audience       = "urn:amp:gcp:${var.project}"
}

resource "google_iam_workload_identity_pool" "pi_orb" {
  workload_identity_pool_id = local.pi_orb_pool_id
  display_name              = "pi-orb orbs"
  description               = "Keyless access from this repository's pi-orb project"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "pi_orb" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.pi_orb.workload_identity_pool_id
  workload_identity_pool_provider_id = local.pi_orb_provider_id
  display_name                       = "pi-orb orb OIDC"
  attribute_mapping = {
    "google.subject"             = "assertion.sub"
    "attribute.project_id"       = "assertion.project_id"
    "attribute.orb_id"           = "assertion.orb_id"
    "attribute.host_incarnation" = "string(assertion.host_incarnation)"
  }
  attribute_condition = "assertion.token_use == 'exchanged' && assertion.project_id == '${var.trusted_pi_orb_project_id}'"
  oidc {
    issuer_uri        = local.pi_orb_issuer_url
    allowed_audiences = [local.pi_orb_audience]
  }
}

resource "google_iam_workload_identity_pool" "amp" {
  workload_identity_pool_id = local.amp_pool_id
  display_name              = "Amp orbs"
  description               = "Keyless access from approved Amp project orbs"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "amp" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.amp.workload_identity_pool_id
  workload_identity_pool_provider_id = local.amp_provider_id
  display_name                       = "Amp orb OIDC"
  attribute_mapping = {
    "google.subject"       = "assertion.thread_id"
    "attribute.project_id" = "assertion.project_id"
    "attribute.user_id"    = "assertion.user_id"
  }
  attribute_condition = "assertion.project_id == '${var.trusted_amp_project_id}' && assertion.user_id == '${var.trusted_amp_user_id}' && assertion.token_use == 'exchanged'"
  oidc {
    issuer_uri        = "https://ampcode.com/api/workload-identity"
    allowed_audiences = [local.amp_audience]
  }
}

resource "google_service_account_iam_member" "pi_orb_deployer_admission" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.pi_orb.name}/attribute.project_id/${var.trusted_pi_orb_project_id}"
}

resource "google_service_account_iam_member" "amp_deployer_admission" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.amp.name}/attribute.user_id/${var.trusted_amp_user_id}"
}
