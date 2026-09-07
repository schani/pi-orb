# Adoption of the live 2026-07-30 deployment into the fresh GCS-backed state
# (the original local state was lost). Import blocks are no-ops once the
# resource is in state. Foundation adoption projects the existing application
# state rather than rebuilding it, so the database password and secret version
# remain in the application state.

import {
  to = google_compute_firewall.control_plane_to_runtime
  id = "projects/${var.project}/global/firewalls/pi-orb-cp-to-runtime"
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
