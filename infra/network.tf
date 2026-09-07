resource "google_compute_firewall" "control_plane_to_runtime" {
  name          = "pi-orb-cp-to-runtime"
  network       = local.pi_orb_network
  direction     = "INGRESS"
  source_ranges = [local.run_egress_cidr]
  allow {
    protocol = "tcp"
    ports    = ["8080"]
  }
}

# Release smoke reaches disposable orb VMs through Identity-Aware Proxy, never
# over their public address. The source range is Google's fixed TCP-forwarding
# range, and the target service account limits the rule to pi-orb hosts rather
# than every VM attached to this VPC.
resource "google_compute_firewall" "iap_to_orb_ssh" {
  name                    = "pi-orb-iap-to-orb-ssh"
  network                 = local.pi_orb_network
  direction               = "INGRESS"
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [local.orb_vm_email, local.image_builder_email]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
