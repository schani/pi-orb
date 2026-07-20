import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { NoSimulationTask, noSimulation } from "determined";
import { DEFAULT_LIFECYCLE_CONSTANTS } from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { pollLoop, reconcileLoop } from "./domain/loops.ts";
import type { ControlPlaneDeps } from "./domain/ports.ts";
import { DockerOrbHostProvider } from "./adapters/docker/provider.ts";
import { PgClient } from "./adapters/pg/client.ts";
import { runMigrations } from "./adapters/pg/migrate.ts";
import { PgControlPlaneStore } from "./adapters/pg/store.ts";
import { PiAuthGate } from "./adapters/pi-auth/gate.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { registerLiveProxy } from "./http/live-proxy.ts";
import { registerRoutes } from "./http/routes.ts";

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
};

async function main(): Promise<void> {
  const databaseUrl = env("DATABASE_URL", "postgres://pi-orb:pi-orb@127.0.0.1:5433/pi_orb");
  const port = Number(env("PORT", "7100"));
  const authDir = env("PI_ORB_AUTH_DIR", join(homedir(), ".pi-orb", "auth"));
  const runtimeImage = env("PI_ORB_RUNTIME_IMAGE", "pi-orb-runtime:dev");
  const dockerNetwork = env("PI_ORB_DOCKER_NETWORK", "pi-orb");

  mkdirSync(authDir, { recursive: true });

  const db = new PgClient(databaseUrl);
  const bootTask = new NoSimulationTask("boot", true);
  const migrated = await runMigrations(db);
  if (migrated.isErr()) {
    bootTask.error("migration failed:", migrated.error.message);
    process.exitCode = 1;
    return;
  }
  if (migrated.value.length > 0) bootTask.log("applied migrations:", migrated.value.join(", "));

  const deps: ControlPlaneDeps = {
    store: new PgControlPlaneStore(db),
    hostProvider: new DockerOrbHostProvider({
      image: runtimeImage,
      network: dockerNetwork,
      authDir,
    }),
    runtimeClient: new FetchRuntimeClient(),
    authGate: new PiAuthGate(authDir),
    control: new ControlState(),
    constants: DEFAULT_LIFECYCLE_CONSTANTS,
  };

  const app = Fastify({ logger: false });
  const httpTask = new NoSimulationTask("http", false);
  await registerLiveProxy(app, httpTask, deps);
  registerRoutes(app, httpTask, deps);

  const stop = new AbortController();
  const shutdown = (): void => {
    bootTask.log("shutting down");
    stop.abort();
    void app.close().then(() => db.end());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const listening = await app.listen({ port, host: "0.0.0.0" }).then(
    (address) => address,
    (error: unknown) => {
      bootTask.error("listen failed:", error);
      process.exitCode = 1;
      return null;
    },
  );
  if (listening === null) return;
  bootTask.log(`control plane listening on ${listening}`);

  // Background loops: history polling and lifecycle reconciliation
  // (DESIGN.md §8.2). Same domain code as the simulations, on real time.
  await noSimulation.runTasks([
    { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
    { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
  ]);
}

void main();
