mock_provider "google" {
  mock_resource "google_certificate_manager_dns_authorization" {
    defaults = {
      dns_resource_record = [{
        name = "_acme-challenge.preview.example.test."
        type = "CNAME"
        data = "test.authorize.certificatemanager.goog."
      }]
    }
  }
  mock_resource "google_cloud_run_v2_service" {
    defaults = {
      urls = ["https://pi-orb-issuer-123456789.us-central1.run.app"]
    }
  }
}

mock_provider "random" {}

override_data {
  target = data.terraform_remote_state.foundation
  values = {
    outputs = {
      foundation_schema_version           = 1
      project                             = "upgrade-test"
      project_number                      = "123456789"
      region                              = "us-central1"
      zone                                = "us-central1-a"
      state_bucket                        = "upgrade-test-state"
      control_plane_service_account_email = "control-plane@upgrade-test.iam.gserviceaccount.com"
      orb_vm_service_account_email        = "orb-vm@upgrade-test.iam.gserviceaccount.com"
      image_builder_service_account_email = "image-builder@upgrade-test.iam.gserviceaccount.com"
      deployer_service_account_email      = "deployer@upgrade-test.iam.gserviceaccount.com"
      artifact_registry_repository        = "projects/upgrade-test/locations/us-central1/repositories/pi-orb"
      pi_orb_network                      = "projects/upgrade-test/global/networks/pi-orb"
      orb_subnetwork                      = "projects/upgrade-test/regions/us-central1/subnetworks/orbs"
      orb_subnetwork_resource             = "regions/us-central1/subnetworks/orbs"
      run_egress_subnetwork               = "projects/upgrade-test/regions/us-central1/subnetworks/run-egress"
      run_egress_cidr                     = "10.10.16.0/26"
    }
  }
}

variables {
  project                  = "upgrade-test"
  control_plane_image      = "us-central1-docker.pkg.dev/upgrade-test/pi-orb/control-plane@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  native_image_resource    = "projects/upgrade-test/global/images/pi-orb-native-test"
  native_image_id          = "123456"
  workspace_image_resource = "projects/upgrade-test/global/images/pi-orb-workspace-test"
  workspace_image_id       = "654321"
  google_client_id         = "test.apps.googleusercontent.com"
  machine_subject          = "123456789012345678901"
  preview_origin           = "https://preview.example.test"
}

run "google_upgrade_contract" {
  command = plan

  assert {
    condition = (
      google_sql_database_instance.pi_orb.deletion_protection == true &&
      google_cloud_run_v2_service.issuer.deletion_protection == false
    )
    error_message = "SQL must retain deletion protection; Cloud Run must remain replaceable."
  }

  assert {
    condition = (
      google_storage_bucket.hosting.force_destroy == false &&
      google_storage_bucket.hosting.uniform_bucket_level_access == true &&
      google_storage_bucket.hosting.public_access_prevention == "enforced" &&
      google_storage_bucket.hosting.versioning[0].enabled == false &&
      google_storage_bucket.hosting.soft_delete_policy[0].retention_duration_seconds == 0
    )
    error_message = "Hosting bucket protection or retention changed."
  }

  assert {
    condition = (
      google_compute_backend_service.preview[0].load_balancing_scheme == "EXTERNAL_MANAGED" &&
      google_compute_global_forwarding_rule.preview[0].load_balancing_scheme == "EXTERNAL_MANAGED"
    )
    error_message = "Preview load balancer must remain explicitly EXTERNAL_MANAGED."
  }
}
