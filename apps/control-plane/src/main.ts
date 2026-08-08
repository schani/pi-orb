import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_OPENAI_INFERENCE_URL_ENV,
  MOCK_OPENAI_OAUTH_URL_ENV,
  readMockOpenAiEnv,
} from "@pi-orb/mock-openai";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { openControlPlaneDatabase } from "./adapters/database.ts";
import { DockerOrbHostProvider } from "./adapters/docker/provider.ts";
import { RestGceApiTransport } from "./adapters/gce/api.ts";
import { GceOrbHostProvider } from "./adapters/gce/provider.ts";
import {
  type GithubOAuthConfig,
  GithubOAuthHttpClient,
  GithubUpstreamRefresher,
} from "./adapters/github-oauth/client.ts";
import { OAuthUpstreamRefresher } from "./adapters/oauth/refresher.ts";
import { PiAuthGate } from "./adapters/pi-auth/gate.ts";
import { PiOrbNameGenerator } from "./adapters/pi-name-generator.ts";
import { ProcessOrbHostProvider } from "./adapters/process/provider.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { FileSecretStore } from "./adapters/secrets/file-store.ts";
import { GsmSecretStore } from "./adapters/secrets/gsm-store.ts";
import {
  FetchTailscaleApiTransport,
  HttpTailscaleAuthKeyMinter,
  type TailscaleHostOptions,
} from "./adapters/tailscale/client.ts";
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

/**
 * The production task: real time, and `task.log` on stdout so the reconciler's
 * event log reaches Cloud Logging (docs/lifecycle.md). `noSimulation` cannot be
 * used for the background loops because it hardwires logging *off* — which is
 * why the 2026-08-05 incident had no app-level logs at all
 * (`docs/postmortems/2026-08-05-unreachable-restart-livelock.md`).
 * Checkpoints, failpoints and blockpoints stay silent: they are
 * simulation-control primitives, and one of them fires on every history commit.
 */
class ControlPlaneTask extends NoSimulationTask {
  constructor(name: string) {
    super(name, true);
  }
  override checkpoint(): Promise<void> {
    return Promise.resolve();
  }
  override failpoint(): Promise<void> {
    return Promise.resolve();
  }
  override blockpoint(): void {
    // Nothing to do outside a simulation.
  }
}

async function main(): Promise<void> {
  const databaseUrl = env("DATABASE_URL", "postgres://pi-orb:pi-orb@127.0.0.1:5433/pi_orb");
  const databaseKind = env("PI_ORB_DATABASE_KIND", "postgresql");
  const pglitePath = env(
    "PI_ORB_PGLITE_PATH",
    join(homedir(), ".pi-orb", "local", "control-plane.pglite"),
  );
  const port = Number(env("PORT", "7100"));
  const authDir = env("PI_ORB_AUTH_DIR", join(homedir(), ".pi-orb", "auth"));
  const runtimeImage = env("PI_ORB_RUNTIME_IMAGE", "pi-orb-runtime:dev");
  const dockerNetwork = env("PI_ORB_DOCKER_NETWORK", "pi-orb");

  mkdirSync(authDir, { recursive: true });

  const bootTask = new NoSimulationTask("boot", true);
  const openedDatabase = openControlPlaneDatabase(
    databaseKind === "pglite"
      ? { kind: "pglite", path: pglitePath }
      : { kind: "postgresql", connectionString: databaseUrl },
  );
  if (openedDatabase.isErr()) {
    bootTask.error("database open failed:", openedDatabase.error.message);
    process.exitCode = 1;
    return;
  }
  const database = openedDatabase.value;
  const role = env("PI_ORB_ROLE", "all");
  const browserRole = role === "all" || role === "browser";
  // "ops": the browser API surface for tooling, with no background loops,
  // no migrations, and no web assets — invoker-IAM keeps it private.
  const opsRole = role === "ops";
  // Only the single-instance browser role migrates; the runtime role's
  // queries fail retryably until the schema exists.
  if (browserRole) {
    const migrated = await database.migrate();
    if (migrated.isErr()) {
      bootTask.error("migration failed:", migrated.error.message);
      process.exitCode = 1;
      return;
    }
    if (migrated.value.length > 0) bootTask.log("applied migrations:", migrated.value.join(", "));
  }

  // E2E mode: when the fake-OpenAI URLs are set, the auth gate and every orb
  // container route Codex OAuth/inference to the mock (docs/PI-CODEX-E2E.md).
  const mockOpenAi = readMockOpenAiEnv(process.env);
  if (mockOpenAi !== null) {
    bootTask.log("E2E mode: Codex OAuth/inference routed to", mockOpenAi.oauthBaseUrl);
  }
  // Secret store: file-backed locally, Secret Manager in the cloud
  // (docs/credentials.md). The GSM parent secrets are created by OpenTofu.
  const secretStoreKind = env("PI_ORB_SECRET_STORE", "file");
  const secrets =
    secretStoreKind === "gsm"
      ? new GsmSecretStore({
          projectId: env("PI_ORB_GCP_PROJECT", ""),
          secretPrefix: env("PI_ORB_CREDENTIAL_SECRET_PREFIX", "pi-orb-credential"),
        })
      : new FileSecretStore(join(authDir, "broker-secrets"));
  // GitHub App credentials for the gh/user-token flow (docs/credentials.md).
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
    pointers: database.pointers,
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
  // Tailscale tier-1 port exposure (docs/ports.md). All three settings or
  // none: without the OAuth client there is no key to mint, and without the
  // tailnet DNS name there is no host to publish. Unset means orbs are
  // created exactly as before and the browser view carries no preview host.
  const tailscaleEnvNames = [
    "PI_ORB_TAILSCALE_OAUTH_CLIENT_ID",
    "PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET",
    "PI_ORB_TAILSCALE_TAILNET_DNS_NAME",
  ] as const;
  const [tailscaleClientId, tailscaleClientSecret, tailnetDnsName] = tailscaleEnvNames.map((name) =>
    env(name, ""),
  ) as [string, string, string];
  const tailscaleClient =
    tailscaleClientId !== "" && tailscaleClientSecret !== "" && tailnetDnsName !== ""
      ? new HttpTailscaleAuthKeyMinter(new FetchTailscaleApiTransport(), {
          clientId: tailscaleClientId,
          clientSecret: tailscaleClientSecret,
        })
      : null;
  const tailscale: TailscaleHostOptions | null =
    tailscaleClient === null ? null : { minter: tailscaleClient, tailnetDnsName };
  if (tailscale === null) {
    const missing = tailscaleEnvNames.filter((name) => env(name, "") === "");
    bootTask.log(`Tailscale port exposure disabled (${missing.join(", ")} unset)`);
  }
  const providerKind = env("PI_ORB_HOST_PROVIDER", "docker");
  const tailscaleForProvider = tailscale !== null && providerKind !== "process";
  if (tailscale !== null && !tailscaleForProvider) {
    bootTask.log("Tailscale port exposure disabled for process host provider");
  }
  const tailscaleOption = tailscaleForProvider ? { tailscale } : {};
  const viewConfig = tailscaleForProvider ? { tailnetDnsName } : {};
  // Forward-only script-repair fencing (docs/host-provider.md): the deploy
  // stamps a monotonic generation, and a revision refuses to repair a host
  // stamped by a newer one. Unset means 0, which is also what an apply that
  // forgets `-var deploy_generation=…` produces: such a revision repairs
  // nothing that a real deploy stamped, and the next real deploy repairs
  // forward. Never backward, at the cost of a delayed upgrade.
  const scriptGeneration = Number.parseInt(env("PI_ORB_SCRIPT_GENERATION", "0"), 10);
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
          scriptGeneration: Number.isFinite(scriptGeneration) ? scriptGeneration : 0,
          ...mockExtraEnv,
          ...tailscaleOption,
        })
      : providerKind === "process"
        ? new ProcessOrbHostProvider({
            stateDirectory: env(
              "PI_ORB_PROCESS_STATE_DIR",
              join(homedir(), ".pi-orb", "local", "process-hosts"),
            ),
            runtimeEntryPoint: fileURLToPath(
              new URL("../../orb-runtime/src/main.ts", import.meta.url),
            ),
            controlPlaneUrl: env("PI_ORB_BROKER_URL", `http://127.0.0.1:${port}`),
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
            ...tailscaleOption,
          });
  const nameInferenceUrl = env("PI_ORB_NAME_INFERENCE_URL", mockOpenAi?.inferenceBaseUrl ?? "");
  const nameGenerator = new PiOrbNameGenerator(
    broker,
    nameInferenceUrl === "" ? null : nameInferenceUrl,
  );
  const deps: ControlPlaneDeps = {
    store: database.store,
    hostProvider,
    resourceCleaner:
      tailscaleForProvider && tailscaleClient !== null
        ? {
            cleanupOrb: (_task, orbId, context) =>
              tailscaleClient.cleanupOrb(orbId, context.signal),
          }
        : { cleanupOrb: () => okAsync(undefined) },
    runtimeClient: new FetchRuntimeClient(),
    authGate:
      githubOauth !== null
        ? new CompositeAuthGate([
            new PiAuthGate(authDir, mockOpenAi, broker),
            new GithubAuthGate(broker, new GithubOAuthHttpClient(githubOauth)),
          ])
        : new PiAuthGate(authDir, mockOpenAi, broker),
    nameGenerator,
    nameLeaseMs: 60_000,
    control: new ControlState(),
    constants: DEFAULT_LIFECYCLE_CONSTANTS,
  };

  // Which route families this process registers (docs/credentials.md): the cloud
  // deployment splits "browser" and "runtime" into separate services; local
  // development serves both from one process.
  const app = Fastify({ logger: false });
  // Commands issued over HTTP log their transitions too (docs/lifecycle.md).
  const httpTask = new ControlPlaneTask("http");
  if (browserRole || opsRole) {
    await registerLiveProxy(app, httpTask, deps);
    registerRoutes(app, httpTask, deps, viewConfig);
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
    registerRuntimeRoutes(app, httpTask, {
      store: deps.store,
      broker,
      nameGenerator: deps.nameGenerator,
      nameLeaseMs: deps.nameLeaseMs,
    });
  }

  const stop = new AbortController();
  const shutdown = (): void => {
    bootTask.log("shutting down");
    stop.abort();
    void app.close().then(async () => {
      if (hostProvider instanceof ProcessOrbHostProvider) await hostProvider.close();
      const closed = await database.close();
      if (closed.isErr()) bootTask.error("database close failed:", closed.error.message);
    });
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
  // (docs/history-replication.md). Same domain code as the simulations, on real time.
  // Only the browser-role service runs them — it is the always-on one; the
  // scale-to-zero runtime service must not depend on background work.
  if (browserRole) {
    const loops: readonly Promise<void>[] = [
      pollLoop(new ControlPlaneTask("poller"), deps, stop.signal),
      reconcileLoop(new ControlPlaneTask("reconciler"), deps, stop.signal),
      orphanSweepLoop(new ControlPlaneTask("sweeper"), deps, stop.signal),
    ];
    await Promise.all(
      loops.map((loop) =>
        loop.catch((error: unknown) => {
          bootTask.error("background loop crashed:", error);
        }),
      ),
    );
  }
}

void main();
