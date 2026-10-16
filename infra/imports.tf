# Import blocks adopt pre-existing resources on first apply; no-ops once in state.
# foundation/adopt.sh projects the application state rather than rebuilding it, so the
# database password and secret version stay in the application state.

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
