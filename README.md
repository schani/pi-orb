# pi-orb

pi-orb runs Pi coding agents in isolated, Docker-backed **orbs**, with a web UI for persistent conversations that can be stopped and resumed. It is currently an unauthenticated local-development prototype and must not be exposed publicly.

## Run locally

Requires Node.js 24 and Docker.

```sh
npm ci
docker compose up -d
docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
```

Then run the control plane and web UI in separate terminals:

```sh
npm run dev --workspace @pi-orb/control-plane
npm run dev --workspace @pi-orb/web
```

Open http://localhost:5173.
