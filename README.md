# pi-orb

pi-orb runs Pi coding agents in isolated, Docker-backed **orbs**, with a web UI for persistent conversations that can be stopped and resumed. A deliberately unsandboxed process backend is available for trusted Docker-free testing. It is currently an unauthenticated local-development prototype and must not be exposed publicly.

Design documentation starts at [DESIGN.md](DESIGN.md), which indexes the topical design docs under `docs/`. The actionable backlog is [TODO.md](TODO.md).

## Run locally

There are three development compositions: the Docker-backed full service, the Docker-free full service using the process host provider, and a frontend-only fixture. The two Docker-free commands are intentionally different: use `dev:local` when backend/runtime behavior matters, and `dev:frontend` only for isolated UI work.

### Docker-backed full service

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

### Docker-free full service: process host provider

This is a real control plane plus real orb runtimes, not a frontend fixture. The embedded PGlite database and test-only process host provider let the control plane and orb-process supervisor run without Docker or an external PostgreSQL service. Because this backend inherits host executables rather than using the runtime image, `rustup` is an additional host prerequisite; toolchains are still installed into each orb's private persistent home. Run the backend and normal web server in separate terminals:

```sh
# Terminal 1: control plane + PGlite + unsandboxed orb-process supervisor
npm run dev:local

# Terminal 2: normal web UI, proxied to the control plane
npm run dev --workspace @pi-orb/web
```

Open http://localhost:5173. Projects, lifecycle operations, Pi sessions, runtime HTTP/WebSockets, replication, and model calls use the real application paths. State defaults to `~/.pi-orb/local`; override the independent paths with `PI_ORB_PGLITE_PATH` and `PI_ORB_PROCESS_STATE_DIR`. Orb runtimes are unsandboxed child processes and must only run trusted repositories.

### Docker-free frontend-only fixture

This is an alternative to the full service above, not its web-server command. For isolated UI work, run Vite with its in-process protocol fixture; Docker, PostgreSQL, the control plane, and the orb runtime are not started:

```sh
npm run dev:frontend
```

Open http://localhost:5173. The seeded orb streams a simulated echo for each message, simulates `!`/`!!` shell commands and turn notifications, and keeps fixture history only in memory until Vite restarts. It does not exercise the process host provider, Pi, SQLite replication, credentials, or model inference. See [docs/web-ui.md](docs/web-ui.md).
