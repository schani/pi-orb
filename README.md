# pi-orb

Persistent Pi and Claude coding conversations with isolated execution workspaces. Design: [DESIGN.md](DESIGN.md). Backlog: [TODO.md](TODO.md).

## Install on iPhone or iPad

Open the HTTPS app in Safari and choose **Share → Add to Home Screen → Add**, leaving **Open as Web App** enabled. Sign in again if prompted. Details: [docs/web-ui.md](docs/web-ui.md).

## Run locally

Requires Node.js and npm at the versions pinned in [package.json](package.json) ([docs/stack.md](docs/stack.md)). On Linux, `npm ci` also needs Python 3 and `build-essential` to compile `node-pty`; macOS uses its prebuilds.

### Docker-backed full service

Requires Docker.

```sh
npm ci
docker compose up -d
docker build -f apps/orb-runtime/Dockerfile -t pi-orb-runtime:dev .
```

In separate terminals:

```sh
PI_ORB_APP_ORIGIN=http://localhost:5173 npm run dev --workspace @pi-orb/control-plane
npm run dev --workspace @pi-orb/web
```

Open http://localhost:5173.

### Docker-free full service (process hosts)

Real control plane, embedded PGlite and unsandboxed process-hosted orb runtimes. Linux only; run only trusted repositories. The runtime image is not used, so `rustup` and Chromium must be installed on the host.

```sh
# Terminal 1: control plane + PGlite + process supervisor
PI_ORB_APP_ORIGIN=http://localhost:5173 npm run dev:local

# Terminal 2: web UI, proxied to the control plane
npm run dev --workspace @pi-orb/web
```

State defaults to `~/.pi-orb/local`; override with `PI_ORB_PGLITE_PATH` and `PI_ORB_PROCESS_STATE_DIR`. Provider details: [docs/host-provider.md](docs/host-provider.md).

### Frontend-only fixture

UI work without Docker, database, control plane or runtimes:

```sh
npm run dev:frontend
```

Fixture behavior, the restart rule and serving static builds: [docs/web-ui.md](docs/web-ui.md) ("Frontend development").

## Test

Commands, E2E backends and DST replay: [docs/testing.md](docs/testing.md).
