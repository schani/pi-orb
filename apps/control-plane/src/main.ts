import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_OPENAI_INFERENCE_URL_ENV,
  MOCK_OPENAI_OAUTH_URL_ENV,
  readMockOpenAiEnv,
} from "@pi-orb/mock-openai";
import type { SystemView } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { okAsync } from "neverthrow";
import { openControlPlaneDatabase } from "./adapters/database.ts";
import { DockerOrbHostProvider } from "./adapters/docker/provider.ts";
import { RestGceApiTransport } from "./adapters/gce/api.ts";
import { isDigestPinnedImage } from "./adapters/gce/image-pin.ts";
import { GceOrbHostProvider } from "./adapters/gce/provider.ts";
import {
  type GithubOAuthConfig,
  GithubOAuthHttpClient,
  GithubUpstreamRefresher,
} from "./adapters/github-oauth/client.ts";
import { OAuthUpstreamRefresher } from "./adapters/oauth/refresher.ts";
import { readIssuerUrl } from "./adapters/oidc/issuer-url.ts";
import {
  CryptoMintIdSource,
  NodeCryptoSigningKeyGenerator,
  OidcTokenSigner,
} from "./adapters/oidc/signer.ts";
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
import { CompositeAuthGate, SerializedAuthGate } from "./domain/auth-gates.ts";
import { CODEX_PROVIDER, GITHUB_PROVIDER } from "./domain/broker.ts";
import {
  DEFAULT_BROKER_CONSTANTS,
  DEFAULT_ISSUER_CONSTANTS,
  DEFAULT_LIFECYCLE_CONSTANTS,
} from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { GithubAuthGate } from "./domain/github-auth.ts";
import { requestOrbArchive } from "./domain/lifecycle.ts";
import { logEvent } from "./domain/log.ts";
import {
  orphanSweepLoop,
  pollLoop,
  projectDeletionLoop,
  type ReconcileTaskRunner,
  reconcileLoop,
} from "./domain/loops.ts";
import type { BrokerDeps, ControlPlaneDeps, SigningKeyDeps } from "./domain/ports.ts";
import { ensureActiveSigningKey } from "./domain/signing-keys.ts";
import { MintDenialLog } from "./domain/workload-identity.ts";
import { registerIssuerRoutes } from "./http/issuer-routes.ts";
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

/**
 * Every deployment role this binary knows how to be. `all` is the local
 * single-process composition; the cloud deployment runs one service per other
 * role (docs/deployment.md, docs/workload-identity.md).
 */
const ROLES: readonly string[] = ["all", "browser", "runtime", "ops", "issuer"];

/**
 * This build's version, read once. `/api/v1/system` states it on every
 * dashboard, and the answer cannot change while the process lives, so it is
 * never re-read per request.
 */
const { version: CONTROL_PLANE_VERSION }: { version: string } = createRequire(import.meta.url)(
  "../package.json",
);

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
  const providerKind = env("PI_ORB_HOST_PROVIDER", "docker");
  const bootTask = new NoSimulationTask("boot", true);
  if (providerKind === "gce" && !isDigestPinnedImage(runtimeImage)) {
    // Refuse before any side effect — a misconfigured deploy must not migrate
    // the schema and then die.
    bootTask.error("PI_ORB_RUNTIME_IMAGE must be digest-pinned for GCE");
    process.exitCode = 1;
    return;
  }

  // Which route families this process registers (docs/credentials.md): the
  // cloud deployment splits "browser", "runtime", and the public "issuer" into
  // separate services; local development serves all of them from one process.
  // A hard allowlist: a typo must refuse to boot rather than come up healthy
  // and serve nothing but 404s.
  const role = env("PI_ORB_ROLE", "all");
  if (!ROLES.includes(role)) {
    bootTask.error(`PI_ORB_ROLE must be one of ${ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const browserRole = role === "all" || role === "browser";
  // "ops": the browser API surface for tooling, with no background loops,
  // no migrations, and no web assets — invoker-IAM keeps it private.
  const opsRole = role === "ops";
  const runtimeRole = role === "all" || role === "runtime";
  // "issuer": the deployment's only public unauthenticated surface, serving
  // OIDC discovery and JWKS and nothing else (docs/workload-identity.md).
  const issuerRole = role === "all" || role === "issuer";

  // The issuer URL is part of the security identity of every minted token, so
  // it is configuration and is validated before any side effect, exactly like
  // the digest pin above. Every role that mints or publishes the issuer's
  // metadata needs it; the others never look at it.
  const configuredIssuerUrl = readIssuerUrl(
    env("PI_ORB_OIDC_ISSUER_URL", ""),
    // Local development serves the issuer from the same process it mints in,
    // so the loopback origin it is already listening on is the truthful
    // default. A split deployment has no such default and must be told.
    role === "all" ? `http://127.0.0.1:${port}` : null,
  );
  if ((runtimeRole || issuerRole) && configuredIssuerUrl.isErr()) {
    bootTask.error(`PI_ORB_OIDC_ISSUER_URL ${configuredIssuerUrl.error}`);
    process.exitCode = 1;
    return;
  }
  const issuerUrl = configuredIssuerUrl.isOk() ? configuredIssuerUrl.value : "";

  mkdirSync(authDir, { recursive: true });
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
  // Only the single-instance browser role migrates; the runtime and issuer
  // roles' queries fail retryably until the schema exists.
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
  const e2eLaunchFailureMarker = env("PI_ORB_E2E_LAUNCH_FAILURE_MARKER", "");
  const e2eHostSpec = env("PI_ORB_E2E_HOST_SPEC", "");
  const runtimeExtraEnv: Record<string, string> = {
    ...(mockOpenAi === null
      ? {}
      : {
          [MOCK_OPENAI_OAUTH_URL_ENV]: mockOpenAi.oauthBaseUrl,
          [MOCK_OPENAI_INFERENCE_URL_ENV]: mockOpenAi.inferenceBaseUrl,
          PI_OFFLINE: "1",
        }),
    ...(e2eLaunchFailureMarker === ""
      ? {}
      : { PI_ORB_E2E_LAUNCH_FAILURE_MARKER: e2eLaunchFailureMarker }),
    // Test-composition-only effective launch input used to prove immutable
    // host-spec replacement end to end. It is inert outside E2E composition.
    ...(e2eHostSpec === "" ? {} : { PI_ORB_E2E_HOST_SPEC: e2eHostSpec }),
  };
  // E2E-only live spec switch: process-backed acceptance cannot restart the
  // control plane without also terminating its child compute. SIGHUP mutates
  // one effective launch input in place so the test can prove that a running
  // orb is untouched and its next Start replaces compute. No handler exists
  // in production compositions, where PI_ORB_E2E_HOST_SPEC is unset.
  if (e2eHostSpec !== "") {
    process.on("SIGHUP", () => {
      runtimeExtraEnv["PI_ORB_E2E_HOST_SPEC"] = `${runtimeExtraEnv["PI_ORB_E2E_HOST_SPEC"]}-next`;
      bootTask.log("E2E host specification advanced");
    });
  }
  const extraEnvOption =
    Object.keys(runtimeExtraEnv).length === 0 ? {} : { extraEnv: runtimeExtraEnv };
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
  const tailscaleForProvider = tailscale !== null && providerKind !== "process";
  if (tailscale !== null && !tailscaleForProvider) {
    bootTask.log("Tailscale port exposure disabled for process host provider");
  }
  const tailscaleOption = tailscaleForProvider ? { tailscale } : {};
  const viewConfig = tailscaleForProvider ? { tailnetDnsName } : {};
  // What the dashboard footer states. The host-provider fallback is the one
  // the composition below takes, so the footer names the provider actually
  // constructed rather than the string that was typed.
  const systemView: SystemView = {
    hostProvider:
      providerKind === "gce" ? "gce" : providerKind === "process" ? "process" : "docker",
    databaseKind: databaseKind === "pglite" ? "pglite" : "postgres",
    version: CONTROL_PLANE_VERSION,
  };
  // Forward-only immutable-spec replacement fence (docs/compute-replacement.md).
  // An unparsable or unset value folds to 0: such a revision replaces nothing
  // a real deploy stamped, and the next real deploy replaces forward.
  const specGeneration = Number.parseInt(env("PI_ORB_HOST_SPEC_GENERATION", "0"), 10) || 0;
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
          specGeneration,
          ...extraEnvOption,
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
            commandDirectory: fileURLToPath(new URL("../../orb-runtime/docker", import.meta.url)),
            controlPlaneUrl: env("PI_ORB_BROKER_URL", `http://127.0.0.1:${port}`),
            specGeneration,
            ...extraEnvOption,
          })
        : new DockerOrbHostProvider({
            image: runtimeImage,
            network: dockerNetwork,
            controlPlanePort: port,
            ...(process.env["PI_ORB_BROKER_URL"] !== undefined &&
            process.env["PI_ORB_BROKER_URL"] !== ""
              ? { controlPlaneUrl: process.env["PI_ORB_BROKER_URL"] }
              : {}),
            specGeneration,
            ...extraEnvOption,
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
    authGate: new SerializedAuthGate(
      githubOauth !== null
        ? new CompositeAuthGate([
            new PiAuthGate(authDir, mockOpenAi, broker),
            new GithubAuthGate(broker, new GithubOAuthHttpClient(githubOauth)),
          ])
        : new PiAuthGate(authDir, mockOpenAi, broker),
    ),
    nameGenerator,
    nameLeaseMs: 60_000,
    control: new ControlState(),
    constants: DEFAULT_LIFECYCLE_CONSTANTS,
    projectSecrets: { pointers: database.projectSecrets, secrets },
  };

  const app = Fastify({ logger: false });
  // Commands issued over HTTP log their transitions too (docs/lifecycle.md).
  const httpTask = new ControlPlaneTask("http");
  // Everything key management needs. Shared by the boot hook below and, on the
  // private roles, by the staged rotation routes.
  const signingKeyDeps: SigningKeyDeps = {
    keys: database.signingKeys,
    secrets,
    generator: new NodeCryptoSigningKeyGenerator(),
    constants: DEFAULT_ISSUER_CONSTANTS,
  };
  if (browserRole || opsRole) {
    await registerLiveProxy(app, httpTask, deps);
    // Staged rotation lives only on the private roles: the public issuer
    // publishes keys and must not be able to change them
    // (docs/workload-identity.md).
    registerRoutes(app, httpTask, deps, viewConfig, systemView, signingKeyDeps);
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
  if (runtimeRole) {
    registerRuntimeRoutes(app, httpTask, {
      archiveSelf: (task, orbId, caller) => requestOrbArchive(task, deps, orbId, caller),
      store: deps.store,
      broker,
      nameGenerator: deps.nameGenerator,
      nameLeaseMs: deps.nameLeaseMs,
      projectSecrets: deps.projectSecrets,
      mint: {
        store: deps.store,
        // The signer reads the active key row per signature and caches only
        // its material, so a rotation takes effect without a restart
        // (docs/workload-identity.md).
        signer: new OidcTokenSigner({
          keys: database.signingKeys,
          secrets,
          constants: DEFAULT_ISSUER_CONSTANTS,
        }),
        mintIds: new CryptoMintIdSource(),
        denials: new MintDenialLog(),
        constants: DEFAULT_ISSUER_CONSTANTS,
        issuerUrl,
      },
    });
  }
  if (issuerRole) {
    // Public, cacheable, secret-free: no auth gate, no orb data, no secret
    // store (docs/workload-identity.md).
    registerIssuerRoutes(app, httpTask, {
      keys: database.signingKeys,
      constants: DEFAULT_ISSUER_CONSTANTS,
      issuerUrl,
    });
  }

  /**
   * Boot key ensure for the roles that mint (docs/workload-identity.md).
   * Idempotent, so every instance runs it and the losers adopt the winner's
   * key.
   *
   * It deliberately does *not* fail the boot: the runtime service is also the
   * credential broker every running orb depends on, and taking it down over
   * issuer trouble would trade a feature outage for a fleet outage. Minting
   * then fails closed per request with typed retryable errors, and the next
   * boot or an operator's rotation repairs it.
   *
   * For the same reason it must not run *before* `app.listen`. A database that
   * refuses answers fast, but one that hangs — a saturated pool, a network
   * partition that drops packets instead of resetting — answers never, and an
   * awaited pre-listen hook would then keep every orb's credential broker from
   * ever accepting a connection. Identity is one feature; listening is the
   * whole service. So this runs after the socket is open, in the background,
   * on the task's clock.
   */
  const ensureSigningKeyInBackground = async (): Promise<void> => {
    let lastFailure = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await bootTask.sleep(500, "signing key retry");
      const ensured = await ensureActiveSigningKey(bootTask, signingKeyDeps, {
        now: bootTask.wallNow(),
      });
      if (ensured.isOk()) return;
      lastFailure = ensured.error.message;
    }
    // One durable edge, and only on the failing edge: a healthy boot that found
    // the key already active says nothing (docs/lifecycle.md). It is a
    // `lifecycle:` event rather than free-text stderr because "why could this
    // instance not sign?" is a question asked long afterwards, and the answer
    // has to be queryable beside the key events the ensure itself emits.
    logEvent(bootTask, "issuer-key-unavailable", { reason: lastFailure });
  };

  const stop = new AbortController();
  let appClosePromise: Promise<void> | null = null;
  let resourceClosePromise: Promise<void> | null = null;
  const closeApp = (): Promise<void> => {
    appClosePromise ??= app.close().catch((error: unknown) => {
      bootTask.error("HTTP server close failed:", error);
    });
    return appClosePromise;
  };
  const closeResources = (): Promise<void> => {
    resourceClosePromise ??= (async () => {
      await closeApp();
      if (hostProvider instanceof ProcessOrbHostProvider) await hostProvider.close();
      const closed = await database.close();
      if (closed.isErr()) bootTask.error("database close failed:", closed.error.message);
    })();
    return resourceClosePromise;
  };
  const shutdown = (): void => {
    if (stop.signal.aborted) return;
    bootTask.log("shutting down");
    stop.abort();
    // Stop accepting requests immediately, but the browser service keeps its
    // provider/database boundaries open until concurrent reconciliations drain.
    void closeApp();
    if (!browserRole) void closeResources();
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

  // Fire and forget: the socket is already accepting, and this repairs the
  // issuer behind it (see `ensureSigningKeyInBackground`).
  if (runtimeRole) void ensureSigningKeyInBackground();

  // Background loops: history polling and lifecycle reconciliation
  // (docs/history-replication.md). Same domain code as the simulations, on real time.
  // Only the browser-role service runs them — it is the always-on one; the
  // scale-to-zero runtime service must not depend on background work.
  if (browserRole) {
    const runReconcileTask: ReconcileTaskRunner = (orbId, operation) =>
      operation(new ControlPlaneTask(`reconciler:${orbId}`));
    const loops: readonly Promise<void>[] = [
      pollLoop(new ControlPlaneTask("poller"), deps, stop.signal),
      reconcileLoop(
        new ControlPlaneTask("reconcile-scheduler"),
        deps,
        stop.signal,
        runReconcileTask,
      ),
      projectDeletionLoop(new ControlPlaneTask("project-deletion"), deps, stop.signal),
      orphanSweepLoop(new ControlPlaneTask("sweeper"), deps, stop.signal),
    ];
    try {
      await Promise.all(loops);
    } catch (error) {
      bootTask.error("background loop crashed:", error);
      process.exitCode = 1;
      stop.abort();
      void closeApp();
      await Promise.allSettled(loops);
    }
    await closeResources();
  }
}

void main();
