# Orb runtime image (DESIGN.md §3.3, §17.7): Debian-based Node 24 with git.
# Build from the repository root:
#   docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/orb-runtime/package.json apps/orb-runtime/
RUN npm ci --workspace @pi-orb/orb-runtime --include-workspace-root=false --ignore-scripts

COPY packages/protocol/src packages/protocol/src
COPY apps/orb-runtime/src apps/orb-runtime/src

# The persistent orb filesystem is mounted here (Docker volume).
VOLUME /workspace
EXPOSE 8080

ENV PI_ORB_WORK_DIR=/workspace
ENV PI_ORB_AUTH_DIR=/var/lib/pi-orb/auth

# Node 24 strips types natively; no build step.
CMD ["node", "apps/orb-runtime/src/main.ts"]
