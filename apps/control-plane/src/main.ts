import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MOCK_OPENAI_INFERENCE_URL_ENV,
  MOCK_OPENAI_OAUTH_URL_ENV,
  readMockOpenAiEnv,
} from "@pi-orb/mock-openai";
import { NoSimulationTask, noSimulation } from "determined";
import Fastify from "fastify";
import { DockerOrbHostProvider } from "./adapters/docker/provider.ts";
import { OAuthUpstreamRefresher } from "./adapters/oauth/refresher.ts";
import { PgClient } from "./adapters/pg/client.ts";
import { PgCredentialPointerStore } from "./adapters/pg/credential-pointers.ts";
import { runMigrations } from "./adapters/pg/migrate.ts";
import { PgControlPlaneStore } from "./adapters/pg/store.ts";
import { PiAuthGate } from "./adapters/pi-auth/gate.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { FileSecretStore } from "./adapters/secrets/file-store.ts";
import { DEFAULT_BROKER_CONSTANTS, DEFAULT_LIFECYCLE_CONSTANTS } from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { pollLoop, reconcileLoop } from "./domain/loops.ts";
import type { BrokerDeps, ControlPlaneDeps } from "./domain/ports.ts";
import { registerLiveProxy } from "./http/live-proxy.ts";
import { registerRoutes } from "./http/routes.ts";
import { registerRuntimeRoutes } from "./http/runtime-routes.ts";

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

  // E2E mode: when the fake-OpenAI URLs are set, the auth gate and every orb
  // container route Codex OAuth/inference to the mock (PI-CODEX-E2E.md).
  const mockOpenAi = readMockOpenAiEnv(process.env);
  if (mockOpenAi !== null) {
    bootTask.log("E2E mode: Codex OAuth/inference routed to", mockOpenAi.oauthBaseUrl);
  }
  const broker: BrokerDeps = {
    pointers: new PgCredentialPointerStore(db),
    secrets: new FileSecretStore(join(authDir, "broker-secrets")),
    upstream: new OAuthUpstreamRefresher(
      mockOpenAi !== null ? { oauthBaseUrl: mockOpenAi.oauthBaseUrl } : {},
    ),
    constants: DEFAULT_BROKER_CONSTANTS,
  };
  const deps: ControlPlaneDeps = {
    store: new PgControlPlaneStore(db),
    hostProvider: new DockerOrbHostProvider({
      image: runtimeImage,
      network: dockerNetwork,
      authDir,
      ...(mockOpenAi !== null
        ? {
            extraEnv: {
              [MOCK_OPENAI_OAUTH_URL_ENV]: mockOpenAi.oauthBaseUrl,
              [MOCK_OPENAI_INFERENCE_URL_ENV]: mockOpenAi.inferenceBaseUrl,
              PI_OFFLINE: "1",
            },
          }
        : {}),
    }),
    runtimeClient: new FetchRuntimeClient(),
    authGate: new PiAuthGate(authDir, mockOpenAi, broker),
    control: new ControlState(),
    constants: DEFAULT_LIFECYCLE_CONSTANTS,
  };

  // Which route families this process registers (DESIGN.md §15.1): the cloud
  // deployment splits "browser" and "runtime" into separate services; local
  // development serves both from one process.
  const role = env("PI_ORB_ROLE", "all");
  const app = Fastify({ logger: false });
  const httpTask = new NoSimulationTask("http", false);
  if (role === "all" || role === "browser") {
    await registerLiveProxy(app, httpTask, deps);
    registerRoutes(app, httpTask, deps);
  }
  if (role === "all" || role === "runtime") {
    registerRuntimeRoutes(app, httpTask, { store: deps.store, broker });
  }

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
