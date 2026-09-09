[
  "google_sql_database_instance.pi_orb",
  "google_sql_database.pi_orb",
  "google_sql_user.pi_orb",
  "random_password.db",
  "google_secret_manager_secret.database_url",
  "google_secret_manager_secret_version.database_url"
] as $protected |
[.resource_changes[]? | select(.address as $address | $protected | index($address))] as $changes |
($changes | length) == ($protected | length) and
all($changes[]; .change.actions == ["no-op"])
