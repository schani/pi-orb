# Control-plane image (docs/deployment.md). Build from the repository root:
#   docker build -f apps/control-plane/Dockerfile -t pi-orb-control-plane:dev .

FROM node:26.13.0-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @pi-orb/web --include-workspace-root=false --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol/src packages/protocol/src
COPY apps/web ./apps/web
RUN npm run build --workspace @pi-orb/web

FROM node:26.13.0-bookworm-slim AS dependencies
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/apply-dependency-patches.mjs scripts/apply-dependency-patches.mjs
COPY patches/@earendil-works+pi-ai+1.4.0.patch patches/@earendil-works+pi-ai+1.4.0.patch
COPY patches/@earendil-works+pi-codemode+1.4.0.patch patches/@earendil-works+pi-codemode+1.4.0.patch
COPY patches/@earendil-works+pi-durable+1.4.0.patch patches/@earendil-works+pi-durable+1.4.0.patch
COPY patches/pi-codemode.* patches/
COPY packages/protocol/package.json packages/protocol/
COPY packages/mock-openai/package.json packages/mock-openai/
COPY packages/luna/package.json packages/luna/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm ci --workspace @pi-orb/control-plane --include-workspace-root=false --ignore-scripts \
  && node scripts/apply-dependency-patches.mjs
RUN --network=none rm -rf node_modules/node-pty/prebuilds \
  && npm_config_nodedir=/usr/local npm rebuild node-pty \
  && node -e "const pty = require('node-pty'); const child = pty.spawn('/bin/sh', ['-c', 'exit 0']); child.onExit(({ exitCode }) => process.exit(exitCode))"

FROM node:26.13.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app /app
RUN node -e "const pty = require('node-pty'); const child = pty.spawn('/bin/sh', ['-c', 'exit 0']); child.onExit(({ exitCode }) => process.exit(exitCode))"
COPY packages/protocol/src packages/protocol/src
COPY packages/mock-openai/src packages/mock-openai/src
COPY packages/luna/src packages/luna/src
COPY apps/control-plane/src apps/control-plane/src
COPY apps/orb-runtime/src apps/orb-runtime/src
COPY apps/orb-runtime/skills apps/orb-runtime/skills
COPY --from=web-build /app/apps/web/dist apps/web/dist
RUN node --input-type=module -e "await import('./apps/control-plane/src/adapters/spawn-models.ts')"

ENV PI_ORB_WEB_DIST=/app/apps/web/dist
EXPOSE 8080

# Node 26 strips types natively; no build step.
CMD ["node", "--import", "./apps/control-plane/src/startup-bootstrap.ts", "apps/control-plane/src/main.ts"]
