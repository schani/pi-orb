[
  "google_sql_database_instance.pi_orb",
  "google_sql_database.pi_orb",
  "google_sql_user.pi_orb",
  "random_password.db",
  "google_secret_manager_secret.database_url",
  "google_secret_manager_secret_version.database_url"
] as $protected |
[.resource_changes[]? | select(.address as $address | $protected | index($address))] as $changes |
($changes | map(.address) | sort) == ($protected | sort) and
all($changes[];
  .change.actions == ["no-op"] or
  (.address == "google_sql_database_instance.pi_orb" and
   (.change |
    .actions == ["update"] and
    .before.database_version == "POSTGRES_16" and .after.database_version == "POSTGRES_17" and
    (.before | del(.database_version)) == (.after | del(.database_version)) and
    (.after_unknown | type) == "object" and
    all(.after_unknown | ..; . != true))))
