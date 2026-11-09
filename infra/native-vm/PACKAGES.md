# Native VM package baseline

The image uses Debian 12's GCE guest image and installs packages without
APT recommendations. `packages.tsv` records every resolved package and its
installed size; transitive libraries remain only as dependencies of this baseline.

- Google guest agent 1:20261021.00-g1, systemd, SSH, CA certificates: VM boot and operation.
- Node 26.13.0 LTS, npm 12.2.1, runtime npm dependencies, native node-pty: agent and terminal.
- Bun 1.4.4 (`bun`, `bunx`): project JavaScript runtime/package tooling; checksum-pinned x64 baseline archive, shared with Docker via `infra/install_bun.sh`.
- Docker Engine/CLI 29.9.3, containerd.io 2.4.2-3, Buildx, Compose: project containers/builds.
- git, git-crypt 0.8.0, gh and broker helpers: repository and GitHub workflows.
- gcloud: prescribed GCP tooling.
- Chromium and agent-browser: prescribed browser automation.
- Python, venv, zip/unzip, curl, ripgrep: prescribed agent tools.
- build-essential, pkg-config, libssl-dev: native addon and git-crypt source builds.
- rustup and its proxies: prescribed Rust bootstrap; no toolchain is preinstalled, and explicit installs use durable home.
- sudo: repository setup hooks; orb UID/GID is fixed at 2000.
- iproute2, util-linux, OpenSSL: isolated synthetic Claude acceptance namespaces and owned TLS fixture.

The image excludes the inherited OS Config agent, unattended-upgrade package,
Vim, nano, wget, manual-page tools, and agent-browser executables for other
platforms. Their functions are either unnecessary at runtime or covered by the
smaller prescribed tools above. The build retains all transitive packages APT
requires for the guest environment and prescribed tools; it does not run a broad
autoremove over the GCE base image.
The base is `projects/debian-cloud/global/images/debian-12-bookworm-v20261027`.
Builds refresh installed Debian packages, pin Docker/CLI to
`5:29.9.3-1~debian.12~bookworm`, containerd.io to
`2.4.2-3~debian.12~bookworm`, and google-guest-agent to `1:20261021.00-g1`.
Docker's Bookworm repository does not offer containerd 2.3.7 LTS. Build and
acceptance validate exact versions and parse the configured persistent roots
without starting daemons.

Platform package updates use image rebuilds. Build caches, instance identity,
SSH keys, runtime credentials, and first-party test/build-only source are removed
before capture. The four synthetic Claude acceptance helpers remain under
`/opt/pi-orb/claude-qualification`; they import the installed runtime and use only
test-owned credentials and files. The installed guest publishes boot edges directly and the image
acceptance test verifies the guest-attribute copy.

Workspace admission: `README.md`. Boot edges are written to the serial journal, the
`pi-orb/boot-status` guest attribute, and the `pi-orb-boot` Cloud Logging log.
Cloud publication uses the already prescribed Google Cloud CLI and adds no image
package.

The builder installs and verifies npm 12.2.1 after extracting Node and before
installing dependencies; acceptance verifies it as `orb` (`docs/stack.md`).

Node 26.13.0 is used for CI, Docker and native builds; it has the Wasm wrapper
lifetime protection Node 24.22.1 lacks
(`docs/postmortems/2026-10-28-node-wasm-wrapper-lifetime.md`). The linux-x64
archive SHA-256 is checked against the
[signed manifest](https://nodejs.org/dist/v26.13.0/SHASUMS256.txt.asc) and pinned
in `infra/native-vm/install.sh`; `/opt/pi-orb/node-version` records it. Docker
stages use `node:26.13.0-bookworm-slim`; the non-Linux filesystem test uses
`node:26.13.0-bookworm` for Python and ext4 tools.

Build checks and `acceptance.sh` require Bun/bunx 1.4.4 and git-crypt 0.8.0, run
as `orb`. Both images build git-crypt with `infra/install_git_crypt.sh` from the
checksum-pinned upstream source against Debian OpenSSL (the upstream x86_64 binary
needs a newer glibc). Source and GPL license are in
`/usr/local/share/doc/git-crypt/`; no keys are installed (`docs/host-provider.md`).
