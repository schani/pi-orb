# Orb runtime image: Debian-based Node 24 with git,
# Python 3, zip/unzip, the GitHub CLI, the Google Cloud CLI, and
# Tailscale for tier-1 port exposure
# (docs/ports.md). No systemd unit is enabled — the runtime process spawns
# tailscaled itself, in userspace-networking mode, so the container needs
# neither a TUN device nor NET_ADMIN. Build from the repository root:
#   docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
FROM node:24.22.1-bookworm-slim

COPY infra/runtime_apt.sh /usr/local/bin/runtime-apt
RUN chmod 755 /usr/local/bin/runtime-apt \
  && runtime-apt git git-crypt ca-certificates ripgrep curl zip unzip sudo python3 python3-venv python-is-python3 build-essential pkg-config \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
       -o /etc/apt/keyrings/tailscale-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/tailscale-archive-keyring.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian bookworm main" \
       > /etc/apt/sources.list.d/tailscale.list \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
       -o /usr/share/keyrings/cloud.google.asc \
  && chmod go+r /usr/share/keyrings/cloud.google.asc \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.asc] https://packages.cloud.google.com/apt cloud-sdk main" \
       > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && runtime-apt gh tailscale chromium google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

# Install only the pinned rustup multiplexer and its proxies in the disposable
# image. Explicit and repository-selected toolchains, plus Cargo state, live in
# the orb's persistent home and survive image updates.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) rust_arch=x86_64; rustup_sha=5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4 ;; \
      arm64) rust_arch=aarch64; rustup_sha=a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697 ;; \
      *) echo "unsupported Rust architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl --proto "=https" --tlsv1.2 -fsSL \
       "https://static.rust-lang.org/rustup/archive/1.29.2/${rust_arch}-unknown-linux-gnu/rustup-init" \
       -o /tmp/rustup-init \
  && echo "$rustup_sha  /tmp/rustup-init" | sha256sum --check - \
  && install -m 755 /tmp/rustup-init /usr/local/bin/rustup \
  && for proxy in cargo rustc rustdoc rustfmt cargo-clippy cargo-fmt clippy-driver; do ln -s rustup "/usr/local/bin/$proxy"; done \
  && rm /tmp/rustup-init

COPY infra/install_bun.sh /tmp/install_bun.sh
RUN sh /tmp/install_bun.sh "$TARGETARCH" \
  && test "$(bun --version)" = 1.4.4 \
  && test "$(bunx --version)" = 1.4.4 \
  && git-crypt --version \
  && rm /tmp/install_bun.sh

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/orb-runtime/package.json apps/orb-runtime/
RUN start="$(date +%s)" \
  && echo "runtime-deps:npm-install:start" \
  && npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=false --ignore-scripts \
  && echo "runtime-deps:npm-install:complete elapsed_s=$(($(date +%s) - start))" \
  && ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser
RUN --network=none start="$(date +%s)" \
  && echo "runtime-deps:pty-rebuild:start" \
  && rm -rf node_modules/node-pty/prebuilds \
  && npm_config_nodedir=/usr/local npm rebuild node-pty \
  && node -e "const pty = require('node-pty'); const child = pty.spawn('/bin/sh', ['-c', 'exit 0']); child.onExit(({ exitCode }) => process.exit(exitCode))" \
  && echo "runtime-deps:pty-rebuild:complete elapsed_s=$(($(date +%s) - start))"

COPY packages/protocol/src packages/protocol/src
COPY apps/orb-runtime/src apps/orb-runtime/src

# Broker-backed GitHub auth (docs/credentials.md): a gh shim ahead of /usr/bin/gh
# and a git credential helper for https://github.com, both fetching fresh
# short-lived tokens per invocation — no hosts.yml, nothing persisted.
COPY apps/orb-runtime/docker/gh /usr/local/bin/gh
COPY apps/orb-runtime/docker/pi-orb-git-credential /usr/local/bin/pi-orb-git-credential
# The `pi-orb` CLI (docs/workload-identity.md): `pi-orb id-token` mints a
# short-lived OIDC identity token for a caller-chosen audience, so code in an
# orb can federate into a cloud account without any stored cloud secret.
COPY apps/orb-runtime/docker/pi-orb /usr/local/bin/pi-orb
# Google's executable credential source (docs/workload-identity-recipes.md).
# Baked so the in-orb agent points an external-account config at a reviewed
# helper instead of writing its own — the same file the repository ships.
COPY scripts/pi-orb-gcp-identity /usr/local/bin/pi-orb-gcp-identity
RUN chmod 755 /usr/local/bin/gh /usr/local/bin/pi-orb-git-credential /usr/local/bin/pi-orb /usr/local/bin/pi-orb-gcp-identity \
  && git config --system credential.https://github.com.helper '!pi-orb-git-credential'

# Agent skills baked into the image (docs/pi-adapter.md), loaded through the
# resource loader's `additionalSkillPaths`. Outside /workspace on purpose: the
# orb's persistent volume is mounted there and would shadow them.
COPY apps/orb-runtime/skills /opt/pi-orb/skills

VOLUME /workspace
EXPOSE 8080

ENV PI_ORB_WORK_DIR=/workspace
# The platform marker every process in the orb sees, Amp's `AMP_ORB=1`
# analogue (docs/orb-setup-hook.md). Set on the image, not only by the runtime,
# so a `docker exec` shell — the thing a human debugs a hook from — sees it too.
ENV PI_ORB=1
# PID 1 lifetime is the execution boundary on both Docker and GCE.
ENV PI_ORB_CONTAINER=1
ENV HOME=/workspace/home
ENV RUSTUP_HOME=/workspace/home/.rustup
ENV CARGO_HOME=/workspace/home/.cargo
ENV PATH=/workspace/home/.cargo/bin:$PATH

# Node 24 strips types natively; no build step.
CMD ["node", "apps/orb-runtime/src/runtime-entry.ts"]
