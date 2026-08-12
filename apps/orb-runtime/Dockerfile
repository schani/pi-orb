# Orb runtime image (DESIGN.md §3.3, §17.7): Debian-based Node 24 with git,
# Python 3, zip/unzip, the GitHub CLI (§15.3), and Tailscale for tier-1 port exposure
# (docs/ports.md). No systemd unit is enabled — the runtime process spawns
# tailscaled itself, in userspace-networking mode, so the container needs
# neither a TUN device nor NET_ADMIN. Build from the repository root:
#   docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl zip unzip python3 python3-venv python-is-python3 build-essential pkg-config \
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
  && apt-get update \
  && apt-get install -y --no-install-recommends gh tailscale chromium \
  && rm -rf /var/lib/apt/lists/*

# Install only the pinned rustup multiplexer in the disposable image. The
# runtime installs stable on first boot into the orb's persistent home, where
# project rust-toolchain.toml overrides and Cargo caches survive image updates.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) rust_arch=x86_64; rustup_sha=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10 ;; \
      arm64) rust_arch=aarch64; rustup_sha=9732d6c5e2a098d3521fca8145d826ae0aaa067ef2385ead08e6feac88fa5792 ;; \
      *) echo "unsupported Rust architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl --proto "=https" --tlsv1.2 -fsSL \
       "https://static.rust-lang.org/rustup/archive/1.29.0/${rust_arch}-unknown-linux-gnu/rustup-init" \
       -o /tmp/rustup-init \
  && echo "$rustup_sha  /tmp/rustup-init" | sha256sum --check - \
  && install -m 755 /tmp/rustup-init /usr/local/bin/rustup \
  && for proxy in cargo rustc rustdoc rustfmt cargo-clippy cargo-fmt clippy-driver; do ln -s rustup "/usr/local/bin/$proxy"; done \
  && rm /tmp/rustup-init

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/mock-openai/package.json packages/mock-openai/
COPY packages/luna/package.json packages/luna/
COPY apps/orb-runtime/package.json apps/orb-runtime/
RUN npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=false --ignore-scripts \
  && ln -s /app/node_modules/.bin/agent-browser /usr/local/bin/agent-browser \
  && rm -rf node_modules/node-pty/prebuilds \
  && npm rebuild node-pty \
  && node -e "const pty = require('node-pty'); const child = pty.spawn('/bin/sh', ['-c', 'exit 0']); child.onExit(({ exitCode }) => process.exit(exitCode))"

COPY packages/protocol/src packages/protocol/src
COPY packages/mock-openai/src packages/mock-openai/src
COPY packages/luna/src packages/luna/src
COPY apps/orb-runtime/src apps/orb-runtime/src

# Broker-backed GitHub auth (DESIGN.md §15.3): a gh shim ahead of /usr/bin/gh
# and a git credential helper for https://github.com, both fetching fresh
# short-lived tokens per invocation — no hosts.yml, nothing persisted.
COPY apps/orb-runtime/docker/gh /usr/local/bin/gh
COPY apps/orb-runtime/docker/pi-orb-git-credential /usr/local/bin/pi-orb-git-credential
RUN chmod 755 /usr/local/bin/gh /usr/local/bin/pi-orb-git-credential \
  && git config --system credential.https://github.com.helper '!pi-orb-git-credential'

# The persistent orb filesystem is mounted here (Docker volume).
VOLUME /workspace
EXPOSE 8080

ENV PI_ORB_WORK_DIR=/workspace
ENV HOME=/workspace/home
ENV RUSTUP_HOME=/workspace/home/.rustup
ENV CARGO_HOME=/workspace/home/.cargo
ENV PATH=/workspace/home/.cargo/bin:$PATH

# Node 24 strips types natively; no build step.
CMD ["node", "apps/orb-runtime/src/main.ts"]
