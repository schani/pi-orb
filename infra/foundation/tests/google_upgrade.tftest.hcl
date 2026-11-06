mock_provider "google" {
  mock_resource "google_service_account" {
    defaults = {
      name = "projects/upgrade-test/serviceAccounts/foundation@upgrade-test.iam.gserviceaccount.com"
    }
  }
}

run "google_upgrade_contract" {
  command = plan

  assert {
    condition = (
      google_storage_bucket.state.force_destroy == false &&
      google_storage_bucket.state.uniform_bucket_level_access == true &&
      google_storage_bucket.state.public_access_prevention == "enforced" &&
      google_storage_bucket.state.versioning[0].enabled == true &&
      length(google_storage_bucket.state.retention_policy) == 0
    )
    error_message = "State bucket protection or retention policy changed."
  }

  assert {
    condition     = alltrue([for api in google_project_service.apis : api.disable_on_destroy == false])
    error_message = "Foundation removal must not disable project APIs."
  }

  assert {
    condition = (
      google_artifact_registry_repository.pi_orb.format == "DOCKER" &&
      length(google_artifact_registry_repository.pi_orb.remote_repository_config) == 0
    )
    error_message = "Foundation repository must remain a standard Docker repository."
  }

  assert {
    condition     = output.foundation_schema_version == 1
    error_message = "Provider upgrades must preserve the application-facing foundation schema."
  }
}
