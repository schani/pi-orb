import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_OPENAI_INFERENCE_URL_ENV,
  MOCK_OPENAI_OAUTH_URL_ENV,
  type MockOpenAiConfig,
  readMockOpenAiEnv,
} from "@pi-orb/mock-openai";
import {
  HOSTING_MAX_FILE_BYTES,
  HOSTING_TRANSFER_TIMEOUT_MS,
  type SystemView,
} from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import Fastify from "fastify";
import { err, ok, okAsync } from "neverthrow";
import { openControlPlaneDatabase } from "./adapters/database.ts";
import { DockerOrbHostProvider } from "./adapters/docker/provider.ts";
import { RestGceApiTransport } from "./adapters/gce/api.ts";
import { readGceImageIdentity } from "./adapters/gce/image-pin.ts";
import { GceOrbHostProvider } from "./adapters/gce/provider.ts";
import {
  type GithubOAuthConfig,
  GithubOAuthHttpClient,
  GithubUpstreamRefresher,
} from "./adapters/github-oauth/client.ts";
import {
  createGoogleLoginProvider,
  createGoogleMachineVerifier,
} from "./adapters/google-application-auth.ts";
import { createFilesystemHostedByteStore } from "./adapters/hosting/filesystem.ts";
import { createGcsHostedByteStore, createGcsTokenProvider } from "./adapters/hosting/gcs.ts";
import { createMcpOAuthFetch, SdkMcpOAuth } from "./adapters/mcp-oauth.ts";
import { probeMcp } from "./adapters/mcp-probe.ts";
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
import { createReleaseActivationReader } from "./adapters/release-activation.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { createSealedAuthCookies } from "./adapters/sealed-auth-cookies.ts";
import { FileSecretStore } from "./adapters/secrets/file-store.ts";
import { GsmSecretStore } from "./adapters/secrets/gsm-store.ts";
import {
  FetchTailscaleApiTransport,
  HttpTailscaleAuthKeyMinter,
  type TailscaleHostOptions,
} from "./adapters/tailscale/client.ts";
import { CryptoUserIdSource } from "./adapters/user-id.ts";
import { uploadRequest } from "./adapters/workspace-upload-http.ts";
import {
  type ApplicationAuth,
  createApplicationAuth,
  type GoogleLoginProvider,
} from "./domain/application-auth.ts";
import { CompositeAuthGate, SerializedAuthGate } from "./domain/auth-gates.ts";
import {
  bindUserBroker,
  CODEX_PROVIDER,
  GITHUB_PROVIDER,
  type UserBrokerDeps,
} from "./domain/broker.ts";
import { DEFAULT_BROKER_CONSTANTS, DEFAULT_ISSUER_CONSTANTS } from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { GithubAuthGate } from "./domain/github-auth.ts";
import {
  readOrbBootContext,
  requestOrbArchive,
  requestOrbDeletion,
  requestOrbSleep,
} from "./domain/lifecycle.ts";
import { logEvent, logOrbEvent } from "./domain/log.ts";
import {
  hostingCleanupLoop,
  orphanSweepLoop,
  pollLoop,
  projectDeletionLoop,
  type ReconcileTaskRunner,
  reconcileLoop,
} from "./domain/loops.ts";
import { McpOAuth, type McpOAuthProtocol } from "./domain/mcp-oauth.ts";
import { mcpOAuthCleanupLoop } from "./domain/mcp-oauth-garbage.ts";
import { spawnOrb } from "./domain/orb-spawning.ts";
import type { BrokerDeps, ControlPlaneDeps, SigningKeyDeps } from "./domain/ports.ts";
import { getProjectSecretSnapshot } from "./domain/project-secrets.ts";
import { waitForReleaseActivation } from "./domain/release-activation.ts";
import { createSigningKeyBootstrapState, ensureActiveSigningKey } from "./domain/signing-keys.ts";
import { UserScope } from "./domain/user-scope.ts";
import { MintDenialLog } from "./domain/workload-identity.ts";
import { E2eReconcileCheckpoints } from "./e2e-reconcile-checkpoints.ts";
import { createConfiguredHostingAccessPolicy, readHostingConfiguration } from "./hosting-config.ts";
import { type AuthOutcomeSink, registerAuthRoutes } from "./http/auth-routes.ts";
import {
  type RequestPrincipalResolver,
  registerAuthenticatedBrowserRoutes,
} from "./http/browser-identity.ts";
import { registerHostingAccessGuard } from "./http/hosting-access.ts";
import {
  registerBrowserHostingRoutes,
  registerRuntimeHostingRoutes,
} from "./http/hosting-routes.ts";
import { registerIssuerRoutes } from "./http/issuer-routes.ts";
import { registerLiveProxy } from "./http/live-proxy.ts";
import { MCP_OAUTH_CALLBACK, registerMcpOAuthRoutes } from "./http/mcp-oauth-routes.ts";
import { registerMcpRoutes } from "./http/mcp-routes.ts";
import { registerRoutes } from "./http/routes.ts";
import { registerRuntimeRoutes } from "./http/runtime-routes.ts";
import { registerWebAssets } from "./http/web-assets.ts";
import { registerWorkspaceUploadRoutes } from "./http/workspace-upload-routes.ts";
import {
  createRequestPrincipalResolver,
  readRequestIdentityConfig,
} from "./identity-composition.ts";
import { lifecycleConstantsForHost } from "./lifecycle-config.ts";
import { migrationOwnerInput } from "./migrate.ts";

const env = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value !== undefined && value !== "" ? value : fallback;
};

const e2eReconcileCheckpoints = new E2eReconcileCheckpoints();

/**
 * The production task: real time, and `task.log` on stdout so the reconciler's
 * event log reaches Cloud Logging (docs/lifecycle.md). `noSimulation` cannot be
 * used for the background loops because it hardwires logging *off* — which is
 * why the 2026-08-05 incident had no app-level logs at all
 * (`docs/postmortems/2026-08-05-unreachable-restart-livelock.md`).
 * Checkpoints, failpoints and blockpoints stay silent: they are
 * simulation-control primitives, and one of them fires on every history commit.
 * The E2E-only reconciliation checkpoint is exposed when its explicit fixture
 * flag is set, so tests can synchronize completed passes without elapsed waits.
 */
class ControlPlaneTask extends NoSimulationTask {
  constructor(name: string) {
    super(name, true);
  }
  override checkpoint(...log: readonly unknown[]): Promise<void> {
    if (
      process.env["PI_ORB_E2E_RECONCILE_CHECKPOINTS"] === "1" &&
      log[0] === "reconcile.completed" &&
      typeof log[1] === "string" &&
      typeof log[2] === "number"
    ) {
      for (const requestId of e2eReconcileCheckpoints.complete(log[1], log[2])) {
        try {
          process.send?.({ type: "pi-orb.e2e.reconcile-completed", requestId }, () => undefined);
        } catch {
          // The parent may disconnect during teardown after the pass completed.
        }
      }
    }
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
 * This build's version, read once. `/api/v1/system` states it on every
 * dashboard, and the answer cannot change while the process lives, so it is
 * never re-read per request.
 */
const { version: CONTROL_PLANE_VERSION }: { version: string } = createRequire(import.meta.url)(
  "../package.json",
);

export async function main(
  adapters: {
    mcpOAuthProtocol?: (callback: string) => McpOAuthProtocol;
    googleLoginProvider?: GoogleLoginProvider;
    requestPrincipalResolverFactory?: (
      task: SimulationTask,
      users: import("./domain/identity.ts").UserStore,
    ) => RequestPrincipalResolver;
    mockOpenAiForUser?: (userId: string) => MockOpenAiConfig | null;
  } = {},
): Promise<void> {
  const bootTask = new NoSimulationTask("boot", true);
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
  const gceImage = readGceImageIdentity((name) => env(name, ""));
  if (providerKind === "gce" && !gceImage.ok) {
    bootTask.error(gceImage.message);
    process.exitCode = 1;
    return;
  }

  const activationBucket = env("PI_ORB_RELEASE_ACTIVATION_BUCKET", "");
  const requestIdentity = readRequestIdentityConfig(process.env);
  if (requestIdentity.isErr()) {
    bootTask.error(requestIdentity.error);
    process.exitCode = 1;
    return;
  }
  const hostingConfiguration = readHostingConfiguration(process.env, port, homedir());
  if (hostingConfiguration.isErr()) {
    bootTask.error(hostingConfiguration.error.message);
    process.exitCode = 1;
    return;
  }
  const hosting = hostingConfiguration.value;
  const hostingOrigin = hosting.filesOrigin;
  const appOrigin = hosting.appOrigin;
  const hostingAccessResult = createConfiguredHostingAccessPolicy(hosting);
  if (hostingAccessResult.isErr()) {
    bootTask.error(hostingAccessResult.error.message);
    process.exitCode = 1;
    return;
  }
  const hostingAccess = hostingAccessResult.value;

  // Issuer identity must match configured federation trust exactly.
  const configuredIssuerUrl = readIssuerUrl(
    env("PI_ORB_OIDC_ISSUER_URL", ""),
    requestIdentity.value.kind === "local" ? `http://127.0.0.1:${port}` : null,
  );
  if (configuredIssuerUrl.isErr()) {
    bootTask.error(`PI_ORB_OIDC_ISSUER_URL ${configuredIssuerUrl.error}`);
    process.exitCode = 1;
    return;
  }
  const issuerUrl = configuredIssuerUrl.value;
  const migrationOwner = migrationOwnerInput(process.env);
  if (requestIdentity.value.kind === "local" && migrationOwner.isErr()) {
    bootTask.error("migration owner configuration invalid");
    process.exitCode = 1;
    return;
  }

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
  // Production's release job migrates before consumers; local development initializes itself.
  if (requestIdentity.value.kind === "local") {
    const migrated = await database.migrate(migrationOwner._unsafeUnwrap());
    if (migrated.isErr()) {
      bootTask.error(`migration failed code=${migrated.error.code}`);
      const closed = await database.close();
      if (closed.isErr()) bootTask.error(`database close failed code=${closed.error.code}`);
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
  const brokerDeps: UserBrokerDeps = {
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
  const brokerForUser = (userId: string): BrokerDeps => bindUserBroker(brokerDeps, userId);
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
          onKeyEvent: ({ orbId, action, incarnation, keyId }) => {
            logOrbEvent(bootTask, orbId, `tailscale-key-${action}`, { incarnation, key_id: keyId });
          },
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
    ...(activationBucket === "" ? {} : { deploymentStatus: "awaiting-activation" as const }),
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
          machineType: env("PI_ORB_GCE_MACHINE_TYPE", "n2d-highmem-2"),
          subnetwork: env(
            "PI_ORB_GCE_SUBNETWORK",
            "regions/us-central1/subnetworks/pi-orb-us-central1",
          ),
          serviceAccount: env("PI_ORB_GCE_SERVICE_ACCOUNT", ""),
          imageResource: gceImage.ok ? gceImage.imageResource : "",
          imageId: gceImage.ok ? gceImage.imageId : "",
          workspaceImageResource: gceImage.ok ? gceImage.workspaceImageResource : "",
          workspaceImageId: gceImage.ok ? gceImage.workspaceImageId : "",
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
            skillsDir: fileURLToPath(new URL("../../orb-runtime/skills", import.meta.url)),
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
    brokerForUser,
    nameInferenceUrl === "" ? null : nameInferenceUrl,
  );
  const hostedBytes =
    hosting.store.kind === "gcs"
      ? createGcsHostedByteStore({
          bucket: hosting.store.bucket,
          auth: createGcsTokenProvider(),
        })
      : createFilesystemHostedByteStore({
          root: hosting.store.root,
        });
  const deps: ControlPlaneDeps = {
    workspaceUploadRuntime: (task) => ({
      status: (row) => uploadRequest(task, deps, row, "status"),
      finish: (row) => uploadRequest(task, deps, row, "finish"),
    }),
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
            new PiAuthGate(authDir, adapters.mockOpenAiForUser ?? mockOpenAi, brokerForUser),
            new GithubAuthGate(brokerForUser, new GithubOAuthHttpClient(githubOauth)),
          ])
        : new PiAuthGate(authDir, adapters.mockOpenAiForUser ?? mockOpenAi, brokerForUser),
    ),
    nameGenerator,
    nameLeaseMs: 60_000,
    control: new ControlState(),
    constants: lifecycleConstantsForHost(hostProvider.kind),
    projectSecrets: { pointers: database.projectSecrets, secrets },
    personalInstructions: database.personalInstructions,
    projectInstructions: database.projectInstructions,
    userScope: new UserScope(database.users),
    hosting: {
      store: database.hosting,
      bytes: hostedBytes,
      uploadLeaseMs: HOSTING_TRANSFER_TIMEOUT_MS + 30_000,
      maxFileBytes: HOSTING_MAX_FILE_BYTES,
    },
  };

  const e2eReconcileMessageHandler = (message: unknown): void => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "pi-orb.e2e.reconcile" ||
      !("orbId" in message) ||
      typeof message.orbId !== "string" ||
      !("requestId" in message) ||
      typeof message.requestId !== "string"
    )
      return;
    const key = `reconcile:${message.orbId}`;
    deps.control.nudgeNextAttemptAt(key);
    e2eReconcileCheckpoints.request(
      message.orbId,
      message.requestId,
      deps.control.getScheduleGeneration(key),
    );
  };
  if (process.env["PI_ORB_E2E_RECONCILE_CHECKPOINTS"] === "1") {
    process.on("message", e2eReconcileMessageHandler);
  }

  const app = Fastify({ logger: false });
  const oauthNetwork = createMcpOAuthFetch();
  const mcpOAuth = new McpOAuth(
    database.mcpOAuth,
    secrets,
    adapters.mcpOAuthProtocol?.(`${appOrigin}${MCP_OAUTH_CALLBACK}`) ??
      new SdkMcpOAuth(`${appOrigin}${MCP_OAUTH_CALLBACK}`, oauthNetwork.fetcher),
  );
  app.addHook("onClose", async () => {
    await oauthNetwork.close();
  });
  const httpTask = new ControlPlaneTask("http");
  registerHostingAccessGuard(app, hostingAccess, appOrigin, ({ reason, surface, requestId }) =>
    logEvent(httpTask, "auth-hosting-denied", { reason, surface, requestId }),
  );
  app.get("/health", async () => ({ status: "ok" }));
  // Key management dependencies are shared by the boot hook and authenticated rotation routes.
  const signingKeyDeps: SigningKeyDeps = {
    keys: database.signingKeys,
    secrets,
    generator: new NodeCryptoSigningKeyGenerator(),
    bootstrap: createSigningKeyBootstrapState(),
    constants: DEFAULT_ISSUER_CONSTANTS,
  };
  const identityConfig = requestIdentity.value;
  let applicationAuth: ApplicationAuth | undefined;
  const authOutcome: AuthOutcomeSink = ({ event, outcome, requestId }) =>
    logEvent(httpTask, `auth-${event}`, { outcome, requestId });
  if (identityConfig.kind === "google") {
    const cookies = createSealedAuthCookies(identityConfig.cookieSecret);
    const provider =
      adapters.googleLoginProvider === undefined
        ? createGoogleLoginProvider(identityConfig)
        : ok(adapters.googleLoginProvider);
    if (cookies.isErr() || provider.isErr()) {
      bootTask.error("application authentication initialization failed");
      process.exitCode = 1;
      await database.close();
      return;
    }
    applicationAuth = createApplicationAuth({
      task: httpTask,
      users: database.users,
      ids: new CryptoUserIdSource(),
      cookies: cookies.value,
      provider: provider.value,
      machine: createGoogleMachineVerifier(
        {
          audience: appOrigin,
          subject: identityConfig.machineSubject,
        },
        {
          onKeyProviderOutcome: ({ type }) => logEvent(httpTask, type, {}),
        },
      ),
      origins: [appOrigin, hostingOrigin],
    });
    registerAuthRoutes(app, identityConfig, applicationAuth, authOutcome);
  }
  const configuredPrincipalResolver = createRequestPrincipalResolver(
    httpTask,
    identityConfig,
    database.users,
    new CryptoUserIdSource(),
    applicationAuth,
  );
  if (configuredPrincipalResolver.isErr()) {
    bootTask.error(configuredPrincipalResolver.error);
    process.exitCode = 1;
    return;
  }
  const principalResolver =
    adapters.requestPrincipalResolverFactory?.(httpTask, database.users) ??
    configuredPrincipalResolver.value;
  registerAuthenticatedBrowserRoutes(
    app,
    principalResolver,
    async (browser) => {
      registerBrowserHostingRoutes(browser, httpTask, {
        store: deps.store,
        hosting: deps.hosting,
        filesOrigin: hostingOrigin,
        appOrigin,
      });
      await registerLiveProxy(browser, httpTask, deps);
      registerRoutes(browser, httpTask, deps, viewConfig, systemView, signingKeyDeps);
      registerMcpOAuthRoutes(browser, httpTask, database.mcp, mcpOAuth, appOrigin);
      registerMcpRoutes(browser, httpTask, database.mcp, async (projectId, config) => {
        const snapshot = await getProjectSecretSnapshot(httpTask, deps.projectSecrets, projectId);
        return snapshot.isErr()
          ? err("Project secrets unavailable")
          : probeMcp(config, snapshot.value.values);
      });
      registerWorkspaceUploadRoutes(browser, httpTask, deps);
    },
    applicationAuth === undefined || identityConfig.kind !== "google"
      ? undefined
      : {
          origins: identityConfig,
          auth: applicationAuth,
          outcome: authOutcome,
        },
  );
  // Static assets do not resolve an application user.
  const webDist = env("PI_ORB_WEB_DIST", "");
  if (webDist !== "") await registerWebAssets(app, webDist);
  await registerRuntimeHostingRoutes(app, httpTask, {
    store: deps.store,
    hosting: deps.hosting,
    filesOrigin: hostingOrigin,
    appOrigin,
  });
  registerRuntimeRoutes(app, httpTask, {
    appOrigin,
    spawn: (task, caller, orbId, request) => spawnOrb(task, deps, caller, orbId, request),
    sleepSelf: (task, orbId, caller, durationSeconds, sleepId) =>
      requestOrbSleep(task, deps, orbId, caller, durationSeconds, sleepId),
    readBootContext: (task, orbId, caller) => readOrbBootContext(task, deps, orbId, caller),
    archiveSelf: (task, orbId, caller) => requestOrbArchive(task, deps, orbId, caller),
    deleteSelf: (task, orbId, caller) => requestOrbDeletion(task, deps, orbId, caller),
    store: deps.store,
    brokerForUser,
    nameGenerator: deps.nameGenerator,
    nameLeaseMs: deps.nameLeaseMs,
    projectSecrets: deps.projectSecrets,
    personalInstructions: deps.personalInstructions,
    projectInstructions: deps.projectInstructions,
    mcp: database.mcp,
    mcpOAuth,
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
  // Public, cacheable, secret-free handlers have no secret-store dependency.
  registerIssuerRoutes(app, httpTask, {
    keys: database.signingKeys,
    constants: DEFAULT_ISSUER_CONSTANTS,
    issuerUrl,
  });

  /**
   * Boot key ensure (docs/workload-identity.md).
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
    process.off("message", e2eReconcileMessageHandler);
    stop.abort();
    // Stop accepting requests; keep provider/database boundaries open until reconciliations drain.
    void closeApp();
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
  void ensureSigningKeyInBackground();

  // Background loops: history polling and lifecycle reconciliation
  // (docs/history-replication.md). Same domain code as the simulations, on real time.
  if (activationBucket !== "") {
    const activated = await waitForReleaseActivation(
      new ControlPlaneTask("release-activation"),
      createReleaseActivationReader(activationBucket, createGcsTokenProvider()),
      specGeneration,
      stop.signal,
      (status) => {
        if (status === null) delete systemView.deploymentStatus;
        else systemView.deploymentStatus = status;
      },
    );
    if (!activated) {
      await closeResources();
      return;
    }
  }
  const runReconcileTask: ReconcileTaskRunner = (orbId, operation) =>
    operation(new ControlPlaneTask(`reconciler:${orbId}`));
  const loops: readonly Promise<void>[] = [
    pollLoop(new ControlPlaneTask("poller"), deps, stop.signal),
    reconcileLoop(new ControlPlaneTask("reconcile-scheduler"), deps, stop.signal, runReconcileTask),
    projectDeletionLoop(new ControlPlaneTask("project-deletion"), deps, stop.signal),
    orphanSweepLoop(new ControlPlaneTask("sweeper"), deps, stop.signal),
    hostingCleanupLoop(new ControlPlaneTask("hosting-cleanup"), deps, stop.signal),
    mcpOAuthCleanupLoop(
      new ControlPlaneTask("mcp-credential-cleanup"),
      database.mcpOAuth,
      secrets,
      stop.signal,
    ),
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

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
