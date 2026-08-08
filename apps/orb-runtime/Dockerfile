# Orb runtime image (DESIGN.md §3.3, §17.7): Debian-based Node 24 with git,
# the GitHub CLI (§15.3), and Tailscale for tier-1 port exposure
# (docs/ports.md). No systemd unit is enabled — the runtime process spawns
# tailscaled itself, in userspace-networking mode, so the container needs
# neither a TUN device nor NET_ADMIN. Build from the repository root:
#   docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep curl \
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
  && apt-get install -y --no-install-recommends gh tailscale \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/mock-openai/package.json packages/mock-openai/
COPY packages/luna/package.json packages/luna/
COPY apps/orb-runtime/package.json apps/orb-runtime/
RUN npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=false --ignore-scripts

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

# Node 24 strips types natively; no build step.
CMD ["node", "apps/orb-runtime/src/main.ts"]
