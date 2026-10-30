def textsearch_flags:
  [.settings[0].database_flags[]? | select(.name == "cloudsql.enable_pg_textsearch")];
def other_flags:
  [.settings[0].database_flags[]? | select(.name != "cloudsql.enable_pg_textsearch")] | sort_by(.name);

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
    .before.database_version == "POSTGRES_17" and
    (.before.settings | length) == 1 and (.after.settings | length) == 1 and
    ((.before | textsearch_flags) == [] or
     (.before | textsearch_flags) == [{name: "cloudsql.enable_pg_textsearch", value: "off"}]) and
    (.after | textsearch_flags) == [{name: "cloudsql.enable_pg_textsearch", value: "on"}] and
    (.before | other_flags) == (.after | other_flags) and
    (.before | del(.settings[0].database_flags)) == (.after | del(.settings[0].database_flags)) and
    (.after_unknown | type) == "object" and
    all(.after_unknown | ..; . != true))))
