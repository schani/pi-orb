# Adoption of the live 2026-07-30 deployment into the fresh GCS-backed state
# (the original local state was lost). Import blocks are no-ops once the
# resource is in state. Deliberately not imported: IAM members (additive,
# re-asserting them is idempotent), project services (enabling an enabled API
# is a no-op), and random_password/secret versions — the database password
# rotates on adoption, so all three Cloud Run services must be rolled to pick
# up the new DATABASE_URL secret version (deploy.sh restarts the browser;
# roll the other two with a no-op update).

import {
  to = google_service_account.control_plane
  id = "projects/${var.project}/serviceAccounts/pi-orb-control-plane@${var.project}.iam.gserviceaccount.com"
}

import {
  to = google_compute_subnetwork.run_egress
  id = "projects/${var.project}/regions/${var.region}/subnetworks/pi-orb-run-egress"
}

import {
  to = google_compute_firewall.control_plane_to_runtime
  id = "projects/${var.project}/global/firewalls/pi-orb-cp-to-runtime"
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
  to = google_sql_database_instance.pi_orb
  id = "projects/${var.project}/instances/pi-orb"
}

import {
  to = google_sql_database.pi_orb
  id = "projects/${var.project}/instances/pi-orb/databases/pi_orb"
}

import {
  to = google_sql_user.pi_orb
  id = "${var.project}/pi-orb/pi-orb"
}

import {
  to = google_secret_manager_secret.database_url
  id = "projects/${var.project}/secrets/pi-orb-database-url"
}

import {
  to = google_secret_manager_secret.codex_credential
  id = "projects/${var.project}/secrets/pi-orb-credential-openai-codex"
}

import {
  to = google_cloud_run_v2_service.browser
  id = "projects/${var.project}/locations/${var.region}/services/pi-orb"
}

import {
  to = google_cloud_run_v2_service.ops
  id = "projects/${var.project}/locations/${var.region}/services/pi-orb-ops"
}

import {
  to = google_cloud_run_v2_service.runtime
  id = "projects/${var.project}/locations/${var.region}/services/pi-orb-runtime-api"
}
