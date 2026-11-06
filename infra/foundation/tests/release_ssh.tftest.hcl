mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/ssh-test/serviceAccounts/release-ssh@ssh-test.iam.gserviceaccount.com"
    }
  }
}

run "release_ssh_contract" {
  command = plan

  assert {
    condition = { for key, binding in google_project_iam_member.deployer_iap_tunnel : key => binding.condition[0].expression } == {
      image_build = "destination.port == 22 && (destination.ip.startsWith(\"10.11.0.\"))"
      orb_0_7     = "destination.port == 22 && (destination.ip.startsWith(\"10.10.0.\") || destination.ip.startsWith(\"10.10.1.\") || destination.ip.startsWith(\"10.10.2.\") || destination.ip.startsWith(\"10.10.3.\") || destination.ip.startsWith(\"10.10.4.\") || destination.ip.startsWith(\"10.10.5.\") || destination.ip.startsWith(\"10.10.6.\") || destination.ip.startsWith(\"10.10.7.\"))"
      orb_8_15    = "destination.port == 22 && (destination.ip.startsWith(\"10.10.8.\") || destination.ip.startsWith(\"10.10.9.\") || destination.ip.startsWith(\"10.10.10.\") || destination.ip.startsWith(\"10.10.11.\") || destination.ip.startsWith(\"10.10.12.\") || destination.ip.startsWith(\"10.10.13.\") || destination.ip.startsWith(\"10.10.14.\") || destination.ip.startsWith(\"10.10.15.\"))"
    }
    error_message = "Release SSH binding keys or rendered conditions changed."
  }

  assert {
    condition     = alltrue([for binding in google_project_iam_member.deployer_iap_tunnel : length(regexall("&&|\\|\\||!", binding.condition[0].expression)) <= 12])
    error_message = "Release SSH rendered conditions exceed IAM's 12 logical operators."
  }

  assert {
    condition = (
      google_storage_bucket.state.force_destroy == false &&
      google_storage_bucket.state.uniform_bucket_level_access == true &&
      google_storage_bucket.state.public_access_prevention == "enforced" &&
      google_storage_bucket.state.versioning[0].enabled == true &&
      length(google_storage_bucket.state.retention_policy) == 0 &&
      alltrue([for api in google_project_service.apis : api.disable_on_destroy == false]) &&
      google_artifact_registry_repository.pi_orb.format == "DOCKER" &&
      length(google_artifact_registry_repository.pi_orb.remote_repository_config) == 0 &&
      output.foundation_schema_version == 1
    )
    error_message = "Foundation bucket, API, repository or output contract changed."
  }
}
