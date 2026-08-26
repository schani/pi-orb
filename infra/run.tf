# The four Cloud Run services (docs/credentials.md "Cloud exposure"): one image,
# role env var as the hard route allowlist. IAP on the browser service is
# enabled by deploy.sh (gcloud) — the provider's IAP-on-Cloud-Run support
# is still settling; revisit when it is stable.

locals {
  shared_env = merge(
    {
      PI_ORB_ROLE_UNUSED         = "per-service"
      PI_ORB_SECRET_STORE        = "gsm"
      PI_ORB_GCP_PROJECT         = var.project
      PI_ORB_HOST_PROVIDER       = "gce"
      PI_ORB_GCE_ZONE            = var.zone
      PI_ORB_GCE_SERVICE_ACCOUNT = google_service_account.orb_vm.email
      PI_ORB_GCE_SUBNETWORK      = "regions/${var.region}/subnetworks/${google_compute_subnetwork.orbs.name}"
      PI_ORB_RUNTIME_IMAGE       = var.runtime_image
      # Always set, so a revision's fence is explicit rather than inherited
      # from a default (docs/host-provider.md).
      PI_ORB_HOST_SPEC_GENERATION = tostring(var.deploy_generation)
    },
    var.github_client_id != "" ? { PI_ORB_GITHUB_CLIENT_ID = var.github_client_id } : {},
    var.tailscale_oauth_client_id != "" ? {
      PI_ORB_TAILSCALE_OAUTH_CLIENT_ID  = var.tailscale_oauth_client_id
      PI_ORB_TAILSCALE_TAILNET_DNS_NAME = var.tailscale_tailnet_dns_name
    } : {},
  )
}

resource "google_cloud_run_v2_service" "runtime" {
  name                 = "pi-orb-runtime-api"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.control_plane.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "runtime"
      }
      # The `iss` of every token this service mints, and a hard boot requirement
      # for the role since stage 2B of docs/workload-identity.md. It is computed,
      # not supplied: the same `local.oidc_issuer_url` configures the issuer
      # service below, so one apply can never ship a minting image without the
      # matching issuer identity, and a release cannot forget to pass it.
      env {
        name  = "PI_ORB_OIDC_ISSUER_URL"
        value = local.oidc_issuer_url
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = { for k, v in local.shared_env : k => v if k != "PI_ORB_ROLE_UNUSED" }
        content {
          name  = env.key
          value = env.value
        }
      }
      # The broker's GitHub user-token refresh needs the app client secret.
      dynamic "env" {
        for_each = var.github_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_GITHUB_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.github_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.cp_reads_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

resource "google_cloud_run_v2_service" "browser" {
  name                = "pi-orb"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.control_plane.email
    timeout         = "3600s"
    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "browser"
      }
      env {
        name  = "PI_ORB_BROKER_URL"
        value = google_cloud_run_v2_service.runtime.uri
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = { for k, v in local.shared_env : k => v if k != "PI_ORB_ROLE_UNUSED" }
        content {
          name  = env.key
          value = env.value
        }
      }
      # The GitHub device-login gate (reconciler) needs the app client secret.
      dynamic "env" {
        for_each = var.github_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_GITHUB_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.github_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      # The reconciler mints a per-orb tailnet auth key at host creation.
      dynamic "env" {
        for_each = var.tailscale_oauth_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.tailscale_oauth_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      resources {
        limits            = { cpu = "1", memory = "1Gi" }
        cpu_idle          = false # always-allocated CPU: the poller/reconciler run here
        startup_cpu_boost = true
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.cp_reads_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

# Ops surface for tooling/debugging: the browser API without loops or web
# assets, callable only by the debug service account via Cloud Run IAM.
resource "google_cloud_run_v2_service" "ops" {
  name                = "pi-orb-ops"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.control_plane.email
    scaling {
      min_instance_count = 0
      max_instance_count = 1
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "ops"
      }
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = { for k, v in local.shared_env : k => v if k != "PI_ORB_ROLE_UNUSED" }
        content {
          name  = env.key
          value = env.value
        }
      }
      # Not for minting (ops runs no loops): the control plane treats the
      # three tailscale settings as all-or-none, and without the secret this
      # service would omit previewHost from the orb view the browser shows.
      dynamic "env" {
        for_each = var.tailscale_oauth_client_id != "" ? [1] : []
        content {
          name = "PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.tailscale_oauth_client_secret.secret_id
              version = "latest"
            }
          }
        }
      }
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }
  depends_on = [
    google_secret_manager_secret_iam_member.cp_reads_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

# The public OIDC issuer (docs/workload-identity.md). Public ingress with
# invoker IAM disabled makes it the deployment's only unauthenticated surface —
# deliberately, because a relying party verifying a pi-orb token has no pi-orb
# credential to present. What it may serve is bounded by the role allowlist in
# the image: an OIDC discovery document and a JWKS, both public, cacheable, and
# secret-free. It never sees orb data, never authenticates a caller, and holds
# no secret-store access (iam bindings in oidc.tf).
#
# This is not an exception to the IAP rule in docs/deployment.md. That rule
# protects the *unauthenticated control plane* — the browser API, which exposes
# and mutates orb state. This service exposes two documents whose entire purpose
# is to be fetched anonymously by strangers, and it runs as its own service
# account so "public" and "can read credentials" are different identities.
resource "google_cloud_run_v2_service" "issuer" {
  name                 = local.issuer_service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  deletion_protection  = false

  template {
    service_account = google_service_account.issuer.email
    scaling {
      # Capped at one instance like its siblings. On a public unauthenticated
      # endpoint that cap is also the spend bound: both documents are served
      # `public, max-age=300`, so an entire verifier fleet costs one request per
      # key set per five minutes.
      min_instance_count = 0
      max_instance_count = 1
    }
    vpc_access {
      # Only to reach Cloud SQL, which is private-IP only.
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.pi_orb.id
        subnetwork = google_compute_subnetwork.run_egress.id
      }
    }
    containers {
      image = var.control_plane_image
      env {
        name  = "PI_ORB_ROLE"
        value = "issuer"
      }
      # Required at boot for this role, and identical to the runtime service's
      # value by construction (oidc.tf).
      env {
        name  = "PI_ORB_OIDC_ISSUER_URL"
        value = local.oidc_issuer_url
      }
      # The issuer's one piece of state: the public JWKs in `oidc_signing_keys`.
      # Private key material is addressed from those rows but lives in Secret
      # Manager, which this service account cannot read.
      #
      # This is the deployment's *shared* read/write database credential, not a
      # scoped one, so the public service's database rights equal every other
      # service's; only its route allowlist keeps it to two public documents
      # (oidc.tf, and the read-only-role item in TODO.md).
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }
      # Everything in local.shared_env is deliberately absent, because this role
      # reads none of it and each entry would widen a public service:
      #   PI_ORB_SECRET_STORE          the issuer never touches the secret
      #                                store; unset, it does not even construct
      #                                a Secret Manager client.
      #   PI_ORB_GCP_PROJECT           read only by that store and the GCE
      #                                provider.
      #   PI_ORB_HOST_PROVIDER,
      #   PI_ORB_GCE_*,
      #   PI_ORB_RUNTIME_IMAGE,
      #   PI_ORB_HOST_SPEC_GENERATION  this service creates no compute. Leaving
      #                                the provider unset also keeps the
      #                                digest-pin boot gate off its path.
      #   PI_ORB_GITHUB_*,
      #   PI_ORB_TAILSCALE_*           broker and reconciler settings; the
      #                                issuer brokers nothing and runs no loops.
      resources {
        limits = { cpu = "1", memory = "512Mi" }
      }
    }
  }

  # The deterministic-URL assumption in oidc.tf, checked against reality on
  # every apply. If this ever fails, the deployment is advertising an issuer URL
  # that does not resolve and every minted token names an unverifiable issuer:
  # fail the release rather than ship it.
  lifecycle {
    postcondition {
      condition     = self.uri == local.oidc_issuer_url
      error_message = "Cloud Run assigned ${self.uri}, but tokens are being minted with iss=${local.oidc_issuer_url}. Reconcile local.oidc_issuer_url in infra/oidc.tf before releasing."
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.issuer_reads_database_url,
    google_secret_manager_secret_version.database_url,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "ops_debug_invoker" {
  name     = google_cloud_run_v2_service.ops.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:pi-orb-debug@${var.project}.iam.gserviceaccount.com"
}
