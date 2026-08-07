# pi-orb

pi-orb runs Pi coding agents in isolated, Docker-backed **orbs**, with a web UI for persistent conversations that can be stopped and resumed. A deliberately unsandboxed process backend is available for trusted Docker-free testing. It is currently an unauthenticated local-development prototype and must not be exposed publicly.

Design documentation starts at [DESIGN.md](DESIGN.md), which indexes the topical design docs under `docs/`. The actionable backlog is [TODO.md](TODO.md).

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

### Docker-free local backend

The embedded PGlite database and test-only process host provider let the control plane and orb-process supervisor run without Docker or an external PostgreSQL service:

```sh
npm run dev:local
```

State defaults to `~/.pi-orb/local`; override the independent paths with `PI_ORB_PGLITE_PATH` and `PI_ORB_PROCESS_STATE_DIR`. Orb runtimes are unsandboxed child processes and must only run trusted repositories. Run the normal web dev server separately with `npm run dev --workspace @pi-orb/web`, then open http://localhost:5173.

### Frontend only

For UI work, run Vite with its in-process protocol fixture; Docker, PostgreSQL, the control plane, and the orb runtime are not needed:

```sh
npm run dev:frontend
```

Open http://localhost:5173. The seeded orb streams an echo for each message, simulates `!`/`!!` shell commands, and keeps fixture history in memory until Vite restarts. See [docs/web-ui.md](docs/web-ui.md).
