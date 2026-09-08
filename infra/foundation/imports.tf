import {
  to = google_storage_bucket.state
  id = var.state_bucket
}
import {
  to = google_compute_network.pi_orb
  id = "projects/${var.project}/global/networks/pi-orb"
}
import {
  to = google_compute_subnetwork.orbs
  id = "projects/${var.project}/regions/${var.region}/subnetworks/pi-orb-${var.region}"
}
import {
  to = google_compute_subnetwork.run_egress
  id = "projects/${var.project}/regions/${var.region}/subnetworks/pi-orb-run-egress"
}
import {
  to = google_compute_global_address.private_services
  id = "projects/${var.project}/global/addresses/pi-orb-private-services"
}
import {
  to = google_service_networking_connection.private_services
  id = "projects/${var.project}/global/networks/pi-orb:servicenetworking.googleapis.com"
}
import {
  to = google_artifact_registry_repository.pi_orb
  id = "projects/${var.project}/locations/${var.region}/repositories/pi-orb"
}
import {
  to = google_service_account.orb_vm
  id = "projects/${var.project}/serviceAccounts/pi-orb-orb-vm@${var.project}.iam.gserviceaccount.com"
}
import {
  to = google_service_account.control_plane
  id = "projects/${var.project}/serviceAccounts/pi-orb-control-plane@${var.project}.iam.gserviceaccount.com"
}
import {
  to = google_service_account.issuer
  id = "projects/${var.project}/serviceAccounts/pi-orb-issuer@${var.project}.iam.gserviceaccount.com"
}
import {
  to = google_service_account.deployer
  id = "projects/${var.project}/serviceAccounts/pi-orb-amp-deployer@${var.project}.iam.gserviceaccount.com"
}
import {
  to = google_iam_workload_identity_pool.pi_orb
  id = "projects/${var.project}/locations/global/workloadIdentityPools/pi-orb-orbs"
}
import {
  to = google_iam_workload_identity_pool_provider.pi_orb
  id = "projects/${var.project}/locations/global/workloadIdentityPools/pi-orb-orbs/providers/pi-orb-oidc"
}
import {
  to = google_iam_workload_identity_pool.amp
  id = "projects/${var.project}/locations/global/workloadIdentityPools/amp-orbs"
}
import {
  to = google_iam_workload_identity_pool_provider.amp
  id = "projects/${var.project}/locations/global/workloadIdentityPools/amp-orbs/providers/amp-oidc"
}
