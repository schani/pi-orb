# Native VM package baseline

The experiment uses Debian 12's GCE guest image and installs packages without
APT recommendations. `packages.tsv` records every resolved package and its
installed size; transitive libraries remain only as dependencies of this baseline.

- Google guest agent, systemd, SSH, CA certificates: VM boot and operation.
- Node 24.6.0, runtime npm dependencies, native node-pty: agent and terminal.
- Docker Engine 29.1.3, containerd, Buildx, Compose: project containers/builds.
- git, gh and broker helpers: repository and GitHub workflows.
- gcloud: prescribed GCP tooling.
- Chromium and agent-browser: prescribed browser automation.
- Python, venv, zip/unzip, curl, ripgrep: prescribed agent tools.
- build-essential, pkg-config: native addon builds, including project addons.
- rustup: prescribed Rust bootstrap; toolchains are installed in durable home.
- sudo: repository setup hooks; orb UID/GID is fixed at 2000 in this experiment.
- Tailscale: existing userspace preview support, supervised by the runtime.

The image excludes the inherited OS Config agent, unattended-upgrade package,
Vim, nano, wget, manual-page tools, and agent-browser executables for other
platforms. Their functions are either unnecessary at runtime or covered by the
smaller prescribed tools above. The build retains all transitive packages APT
requires for the guest environment and prescribed tools; it does not run a broad
autoremove over the GCE base image.
Platform package updates use image rebuilds. Build caches, instance identity,
SSH keys, runtime credentials, and first-party test/build-only source are removed
before capture. The installed guest publishes boot edges directly and the image
acceptance test verifies the guest-attribute copy.

The guest validates `/dev/disk/by-id/google-pi-orb-data` before mounting it. It
requires a 50 GiB disk containing an ext4 filesystem of exactly that size. It only
reads admission metadata: no formatting, resizing, or offline repair on runtime
disks. Missing, unsupported and mismatched filesystems fail closed; normal ext4
mount/journal handling remains unchanged for retained 50 GiB user disks. A forced
read-only integrity check runs on the empty template during image construction,
not on every retained-workspace restart. Boot edges are written to the serial journal, the
`pi-orb/boot-status` guest attribute, and the `pi-orb-boot` Cloud Logging log.
Cloud publication uses the already prescribed Google Cloud CLI and adds no image
package.
