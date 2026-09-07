# Native Rust bootstrap transient DNS failure — 2026-09-07

The first native release deployed the application and passed the lifecycle
smoke. Its workload-identity smoke then created two orbs in parallel. One orb
booted; the other reported `rust_toolchain_init_failed` because its first
`rustup default stable` request could not resolve `static.rust-lang.org`.
Earlier boots and the parallel orb succeeded. Its failure boot record and filtered Cloud Logging evidence were preserved before normal discard cleanup.

The guest deliberately starts Tailscale with DNS acceptance disabled, so no
resolver rewrite occurred. Network-online ordering also cannot promise that a
later DNS request will succeed. The runtime made one install attempt with no
backoff, turning a transient per-VM network failure into terminal readiness.
The smoke failure was therefore a product resilience defect, not a reason to
rerun the gate.

Fresh-home Rust installation now retries only recognizable transient DNS,
connection, rate-limit, server, network-unreachable, and killed timeout
failures. The default-toolchain probe is limited to five seconds. Fresh installation, retry reporting, and 5- and 15-second backoff share one three-minute budget; each actual install command receives the full time remaining. Checksum and other permanent failures still return immediately. In the first live smoke this left room after the observed 339-second blank-disk preparation; the control plane's unchanged 12-minute first-contact and 15-minute create/start deadlines remain the outer bounds.
Existing toolchains still make one local check and no network request.

Retry and recovery edges go to the `pi-orb-boot` Cloud Logging log through the
native boot diagnostic helper. They do not overwrite the guest readiness
attribute. Deterministic scheduling coverage varies concurrent boot work and
proves recovery consumes only the two bounded delays; unit coverage fixes the
attempt count, classification, logs, permanent-failure behavior, and
existing-toolchain fast path.
