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
import { RestGceApiTransport } from "./adapters/gce/api.ts";
import { GceOrbHostProvider } from "./adapters/gce/provider.ts";
import {
  type GithubOAuthConfig,
  GithubOAuthHttpClient,
  GithubUpstreamRefresher,
} from "./adapters/github-oauth/client.ts";
import { OAuthUpstreamRefresher } from "./adapters/oauth/refresher.ts";
import { PgClient } from "./adapters/pg/client.ts";
import { PgCredentialPointerStore } from "./adapters/pg/credential-pointers.ts";
import { runMigrations } from "./adapters/pg/migrate.ts";
import { PgControlPlaneStore } from "./adapters/pg/store.ts";
import { PiAuthGate } from "./adapters/pi-auth/gate.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { FileSecretStore } from "./adapters/secrets/file-store.ts";
import { GsmSecretStore } from "./adapters/secrets/gsm-store.ts";
import { CompositeAuthGate } from "./domain/auth-gates.ts";
import { CODEX_PROVIDER, GITHUB_PROVIDER } from "./domain/broker.ts";
import { DEFAULT_BROKER_CONSTANTS, DEFAULT_LIFECYCLE_CONSTANTS } from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { GithubAuthGate } from "./domain/github-auth.ts";
import { orphanSweepLoop, pollLoop, reconcileLoop } from "./domain/loops.ts";
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
  const role = env("PI_ORB_ROLE", "all");
  const browserRole = role === "all" || role === "browser";
  // "ops": the browser API surface for tooling, with no background loops,
  // no migrations, and no web assets — invoker-IAM keeps it private.
  const opsRole = role === "ops";
  // Only the single-instance browser role migrates; the runtime role's
  // queries fail retryably until the schema exists.
  if (browserRole) {
    const migrated = await runMigrations(db);
    if (migrated.isErr()) {
      bootTask.error("migration failed:", migrated.error.message);
      process.exitCode = 1;
      return;
    }
    if (migrated.value.length > 0) bootTask.log("applied migrations:", migrated.value.join(", "));
  }

  // E2E mode: when the fake-OpenAI URLs are set, the auth gate and every orb
  // container route Codex OAuth/inference to the mock (PI-CODEX-E2E.md).
  const mockOpenAi = readMockOpenAiEnv(process.env);
  if (mockOpenAi !== null) {
    bootTask.log("E2E mode: Codex OAuth/inference routed to", mockOpenAi.oauthBaseUrl);
  }
  // Secret store: file-backed locally, Secret Manager in the cloud
  // (DESIGN.md §15.1). The GSM parent secrets are created by OpenTofu.
  const secretStoreKind = env("PI_ORB_SECRET_STORE", "file");
  const secrets =
    secretStoreKind === "gsm"
      ? new GsmSecretStore({
          projectId: env("PI_ORB_GCP_PROJECT", ""),
          secretPrefix: env("PI_ORB_CREDENTIAL_SECRET_PREFIX", "pi-orb-credential"),
        })
      : new FileSecretStore(join(authDir, "broker-secrets"));
  // GitHub App credentials for the gh/user-token flow (DESIGN.md §15.3).
  // Unset means "no GitHub integration": no gate, no refresher — tokens/github
  // answers auth_required and everything else is unchanged.
  const githubClientId = env("PI_ORB_GITHUB_CLIENT_ID", "");
  const githubClientSecret = env("PI_ORB_GITHUB_CLIENT_SECRET", "");
  const githubOauth: GithubOAuthConfig | null =
    githubClientId !== "" && githubClientSecret !== ""
      ? {
          clientId: githubClientId,
          clientSecret: githubClientSecret,
          ...(process.env["PI_ORB_GITHUB_OAUTH_URL"] !== undefined &&
          process.env["PI_ORB_GITHUB_OAUTH_URL"] !== ""
            ? { oauthBaseUrl: process.env["PI_ORB_GITHUB_OAUTH_URL"] }
            : {}),
          ...(process.env["PI_ORB_GITHUB_API_URL"] !== undefined &&
          process.env["PI_ORB_GITHUB_API_URL"] !== ""
            ? { apiBaseUrl: process.env["PI_ORB_GITHUB_API_URL"] }
            : {}),
        }
      : null;
  if (githubOauth === null) {
    bootTask.log("GitHub integration disabled (PI_ORB_GITHUB_CLIENT_ID/SECRET unset)");
  }
  const broker: BrokerDeps = {
    pointers: new PgCredentialPointerStore(db),
    secrets,
    upstreams: {
      [CODEX_PROVIDER]: new OAuthUpstreamRefresher(
        mockOpenAi !== null ? { oauthBaseUrl: mockOpenAi.oauthBaseUrl } : {},
      ),
      ...(githubOauth !== null
        ? { [GITHUB_PROVIDER]: new GithubUpstreamRefresher(githubOauth) }
        : {}),
    },
    constants: DEFAULT_BROKER_CONSTANTS,
  };
  const mockExtraEnv =
    mockOpenAi !== null
      ? {
          extraEnv: {
            [MOCK_OPENAI_OAUTH_URL_ENV]: mockOpenAi.oauthBaseUrl,
            [MOCK_OPENAI_INFERENCE_URL_ENV]: mockOpenAi.inferenceBaseUrl,
            PI_OFFLINE: "1",
          },
        }
      : {};
  const providerKind = env("PI_ORB_HOST_PROVIDER", "docker");
  const hostProvider =
    providerKind === "gce"
      ? new GceOrbHostProvider(new RestGceApiTransport(), {
          projectId: env("PI_ORB_GCP_PROJECT", ""),
          zone: env("PI_ORB_GCE_ZONE", "us-central1-a"),
          machineType: env("PI_ORB_GCE_MACHINE_TYPE", "n2d-highmem-4"),
          subnetwork: env(
            "PI_ORB_GCE_SUBNETWORK",
            "regions/us-central1/subnetworks/pi-orb-us-central1",
          ),
          serviceAccount: env("PI_ORB_GCE_SERVICE_ACCOUNT", ""),
          runtimeImage,
          controlPlaneUrl: env("PI_ORB_BROKER_URL", ""),
          ...mockExtraEnv,
        })
      : new DockerOrbHostProvider({
          image: runtimeImage,
          network: dockerNetwork,
          controlPlanePort: port,
          ...(process.env["PI_ORB_BROKER_URL"] !== undefined &&
          process.env["PI_ORB_BROKER_URL"] !== ""
            ? { controlPlaneUrl: process.env["PI_ORB_BROKER_URL"] }
            : {}),
          ...mockExtraEnv,
        });
  const deps: ControlPlaneDeps = {
    store: new PgControlPlaneStore(db),
    hostProvider,
    runtimeClient: new FetchRuntimeClient(),
    authGate:
      githubOauth !== null
        ? new CompositeAuthGate([
            new PiAuthGate(authDir, mockOpenAi, broker),
            new GithubAuthGate(broker, new GithubOAuthHttpClient(githubOauth)),
          ])
        : new PiAuthGate(authDir, mockOpenAi, broker),
    control: new ControlState(),
    constants: DEFAULT_LIFECYCLE_CONSTANTS,
  };

  // Which route families this process registers (DESIGN.md §15.1): the cloud
  // deployment splits "browser" and "runtime" into separate services; local
  // development serves both from one process.
  const app = Fastify({ logger: false });
  const httpTask = new NoSimulationTask("http", false);
  if (browserRole || opsRole) {
    await registerLiveProxy(app, httpTask, deps);
    registerRoutes(app, httpTask, deps);
    // Cloud deployment serves the built web UI from the same process; local
    // development keeps the vite dev server + proxy instead.
    const webDist = browserRole ? env("PI_ORB_WEB_DIST", "") : "";
    if (webDist !== "") {
      const fastifyStatic = (await import("@fastify/static")).default;
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
      // SPA fallback: any non-API GET renders the app shell.
      app.setNotFoundHandler((request, reply) => {
        if (request.method === "GET" && !request.url.startsWith("/api/")) {
          return reply.sendFile("index.html");
        }
        return reply.status(404).send({ error: { code: "not_found" } });
      });
    }
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
  // Only the browser-role service runs them — it is the always-on one; the
  // scale-to-zero runtime service must not depend on background work.
  if (browserRole) {
    await noSimulation.runTasks([
      { name: "poller", f: (task) => pollLoop(task, deps, stop.signal) },
      { name: "reconciler", f: (task) => reconcileLoop(task, deps, stop.signal) },
      { name: "sweeper", f: (task) => orphanSweepLoop(task, deps, stop.signal) },
    ]);
  }
}

void main();
