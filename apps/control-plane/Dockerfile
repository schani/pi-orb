# Control-plane image (DESIGN.md §3.6): serves the API, the live proxy, the
# runtime broker routes, and the built web UI. Build from the repository root:
#   docker build -f apps/control-plane/Dockerfile -t pi-orb-control-plane:dev .

FROM node:24-bookworm-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @pi-orb/web --include-workspace-root=false --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/protocol/src packages/protocol/src
COPY apps/web ./apps/web
RUN npm run build --workspace @pi-orb/web

FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/mock-openai/package.json packages/mock-openai/
COPY apps/control-plane/package.json apps/control-plane/
RUN npm ci --workspace @pi-orb/control-plane --include-workspace-root=false --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/mock-openai/src packages/mock-openai/src
COPY apps/control-plane/src apps/control-plane/src
COPY --from=web-build /app/apps/web/dist apps/web/dist

ENV PI_ORB_WEB_DIST=/app/apps/web/dist
EXPOSE 8080

# Node 24 strips types natively; no build step.
CMD ["node", "apps/control-plane/src/main.ts"]
