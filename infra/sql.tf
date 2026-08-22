# Cloud SQL Postgres, private IP only, backups + PITR from day one
# (docs/history-replication.md). The replica is the durable product history.

resource "google_sql_database_instance" "pi_orb" {
  name                = "pi-orb"
  database_version    = "POSTGRES_16"
  region              = var.region
  deletion_protection = true
  depends_on          = [google_service_networking_connection.private_services]

  settings {
    tier    = "db-custom-1-3840"
    edition = "ENTERPRISE"
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.pi_orb.id
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }
  }
}

resource "google_sql_database" "pi_orb" {
  name     = "pi_orb"
  instance = google_sql_database_instance.pi_orb.name
}

resource "random_password" "db" {
  length  = 32
  special = false # keeps the URL encoding-free
}

resource "google_sql_user" "pi_orb" {
  name     = "pi-orb"
  instance = google_sql_database_instance.pi_orb.name
  password = random_password.db.result
}

# The complete connection URL as one secret: Cloud Run cannot interpolate a
# separately injected password into an env value.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "pi-orb-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = "postgres://${google_sql_user.pi_orb.name}:${random_password.db.result}@${google_sql_database_instance.pi_orb.private_ip_address}:5432/${google_sql_database.pi_orb.name}"
}

resource "google_secret_manager_secret_iam_member" "cp_reads_database_url" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

# Parent secret for the broker's Codex credential (docs/credentials.md); the
# GsmSecretStore only adds/reads/destroys versions on it.
resource "google_secret_manager_secret" "codex_credential" {
  secret_id = "pi-orb-credential-openai-codex"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "cp_credential_accessor" {
  secret_id = google_secret_manager_secret.codex_credential.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}

resource "google_secret_manager_secret_iam_member" "cp_credential_versions" {
  secret_id = google_secret_manager_secret.codex_credential.id
  role      = "roles/secretmanager.secretVersionManager"
  member    = "serviceAccount:${google_service_account.control_plane.email}"
}
