import { homedir } from "node:os";
import { join } from "node:path";
import type { MockOpenAiConfig } from "@pi-orb/mock-openai";
import { HOSTING_MAX_FILE_BYTES, HOSTING_TRANSFER_TIMEOUT_MS } from "@pi-orb/protocol";
import { err, ok, okAsync, Result } from "neverthrow";
import type { ControlPlaneDatabase } from "./adapters/database.ts";
import { openControlPlaneDatabase } from "./adapters/database.ts";
import { RestGceApiTransport } from "./adapters/gce/api.ts";
import { readGceImageIdentity } from "./adapters/gce/image-pin.ts";
import { GceOrbHostProvider } from "./adapters/gce/provider.ts";
import { type GithubOAuthConfig, GithubOAuthHttpClient } from "./adapters/github-oauth/client.ts";
import { createGcsHostedByteStore, createGcsTokenProvider } from "./adapters/hosting/gcs.ts";
import { OAuthUpstreamRefresher } from "./adapters/oauth/refresher.ts";
import { PiAuthGate } from "./adapters/pi-auth/gate.ts";
import { PiActivityHeadlineGenerator } from "./adapters/pi-headline-generator.ts";
import { PiOrbNameGenerator } from "./adapters/pi-name-generator.ts";
import { FetchRuntimeClient } from "./adapters/runtime-client/fetch-client.ts";
import { GsmSecretStore } from "./adapters/secrets/gsm-store.ts";
import type {
  HttpTailscaleAuthKeyMinter,
  TailscaleHostOptions,
} from "./adapters/tailscale/client.ts";
import {
  FetchTailscaleApiTransport,
  HttpTailscaleAuthKeyMinter as TailscaleMinter,
} from "./adapters/tailscale/client.ts";
import { uploadRequest } from "./adapters/workspace-upload-http.ts";
import { CompositeAuthGate, SerializedAuthGate } from "./domain/auth-gates.ts";
import { bindUserBroker, CODEX_PROVIDER } from "./domain/broker.ts";
import { DEFAULT_BROKER_CONSTANTS } from "./domain/constants.ts";
import { ControlState } from "./domain/control-state.ts";
import { GithubAuthGate } from "./domain/github-auth.ts";
import type { HostedByteStore } from "./domain/hosting-ports.ts";
import type { MaintenanceError } from "./domain/maintenance.ts";
import type {
  BrokerDeps,
  ControlPlaneDeps,
  CredentialSecretStore,
  OrbHostProvider,
} from "./domain/ports.ts";
import { UserScope } from "./domain/user-scope.ts";
import { lifecycleConstantsForHost } from "./lifecycle-config.ts";

export function createGceLifecycleHost(
  read: (name: string, fallback: string) => string,
  specGeneration: number,
  extra: { extraEnv?: Record<string, string>; tailscale?: TailscaleHostOptions } = {},
): GceOrbHostProvider {
  const image = readGceImageIdentity((name) => read(name, ""));
  return new GceOrbHostProvider(new RestGceApiTransport(), {
    projectId: read("PI_ORB_GCP_PROJECT", ""),
    zone: read("PI_ORB_GCE_ZONE", "us-central1-a"),
    machineType: read("PI_ORB_GCE_MACHINE_TYPE", "n2d-highmem-2"),
    subnetwork: read("PI_ORB_GCE_SUBNETWORK", "regions/us-central1/subnetworks/pi-orb-us-central1"),
    serviceAccount: read("PI_ORB_GCE_SERVICE_ACCOUNT", ""),
    imageResource: image.ok ? image.imageResource : "",
    imageId: image.ok ? image.imageId : "",
    workspaceImageResource: image.ok ? image.workspaceImageResource : "",
    workspaceImageId: image.ok ? image.workspaceImageId : "",
    controlPlaneUrl: read("PI_ORB_BROKER_URL", ""),
    specGeneration,
    ...extra,
  });
}
export function composeLifecycleDeps(input: {
  database: ControlPlaneDatabase;
  hostProvider: OrbHostProvider;
  secrets: CredentialSecretStore;
  hostedBytes: HostedByteStore;
  authDir: string;
  brokerForUser: (userId: string) => BrokerDeps;
  githubOauth: GithubOAuthConfig | null;
  mockOpenAi: MockOpenAiConfig | null;
  mockOpenAiForUser?: ((userId: string) => MockOpenAiConfig | null) | undefined;
  nameInferenceUrl: string;
  tailscaleForProvider: boolean;
  tailscaleClient: HttpTailscaleAuthKeyMinter | null;
}): ControlPlaneDeps {
  const {
    database,
    hostProvider,
    secrets,
    hostedBytes,
    authDir,
    brokerForUser,
    githubOauth,
    mockOpenAi,
    nameInferenceUrl,
    tailscaleForProvider,
    tailscaleClient,
  } = input;
  const adapters = input;
  const nameGenerator = new PiOrbNameGenerator(
    brokerForUser,
    nameInferenceUrl === "" ? null : nameInferenceUrl,
  );
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
    headlineGenerator: new PiActivityHeadlineGenerator(
      brokerForUser,
      nameInferenceUrl === "" ? null : nameInferenceUrl,
    ),
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
  return deps;
}

export interface MaintenanceComposition {
  deps: ControlPlaneDeps;
  close(): Promise<Result<void, MaintenanceError>>;
}
export async function composeMaintenanceLifecycle(
  environment: Record<string, string | undefined>,
): Promise<Result<MaintenanceComposition, MaintenanceError>> {
  const read = (name: string, fallback: string) => environment[name] || fallback;
  const invalid = (): MaintenanceError => ({ type: "maintenance_error", code: "invalid" });
  const image = readGceImageIdentity((name) => read(name, ""));
  const generation = Number(read("PI_ORB_HOST_SPEC_GENERATION", ""));
  if (
    !image.ok ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    read("PI_ORB_HOST_PROVIDER", "") !== "gce" ||
    !read("DATABASE_URL", "") ||
    !read("PI_ORB_GCP_PROJECT", "") ||
    !read("PI_ORB_GCE_SERVICE_ACCOUNT", "") ||
    !read("PI_ORB_BROKER_URL", "") ||
    !read("PI_ORB_HOSTING_BUCKET", "")
  )
    return err(invalid());
  const database = openControlPlaneDatabase({
    kind: "postgresql",
    connectionString: read("DATABASE_URL", ""),
  });
  if (database.isErr()) return err({ type: "maintenance_error", code: "store" });
  const db = database.value;
  const built = Result.fromThrowable(() => {
    const secrets = new GsmSecretStore({
      projectId: read("PI_ORB_GCP_PROJECT", ""),
      secretPrefix: read("PI_ORB_CREDENTIAL_SECRET_PREFIX", "pi-orb-credential"),
    });
    const brokerForUser = (userId: string) =>
      bindUserBroker(
        {
          pointers: db.pointers,
          secrets,
          upstreams: { [CODEX_PROVIDER]: new OAuthUpstreamRefresher() },
          constants: DEFAULT_BROKER_CONSTANTS,
        },
        userId,
      );
    const tailscaleClientId = read("PI_ORB_TAILSCALE_OAUTH_CLIENT_ID", "");
    const tailscaleClientSecret = read("PI_ORB_TAILSCALE_OAUTH_CLIENT_SECRET", "");
    const tailnetDnsName = read("PI_ORB_TAILSCALE_TAILNET_DNS_NAME", "");
    const tailscaleClient =
      tailscaleClientId && tailscaleClientSecret && tailnetDnsName
        ? new TailscaleMinter(new FetchTailscaleApiTransport(), {
            clientId: tailscaleClientId,
            clientSecret: tailscaleClientSecret,
          })
        : null;
    const hostProvider = createGceLifecycleHost(
      read,
      generation,
      tailscaleClient === null ? {} : { tailscale: { minter: tailscaleClient, tailnetDnsName } },
    );
    const deps = composeLifecycleDeps({
      database: db,
      hostProvider,
      secrets,
      hostedBytes: createGcsHostedByteStore({
        bucket: read("PI_ORB_HOSTING_BUCKET", ""),
        auth: createGcsTokenProvider(),
      }),
      authDir: join(homedir(), ".pi-orb", "auth"),
      brokerForUser,
      githubOauth: null,
      mockOpenAi: null,
      nameInferenceUrl: "",
      tailscaleForProvider: tailscaleClient !== null,
      tailscaleClient,
    });
    return deps;
  }, invalid)();
  if (built.isErr()) {
    await db.close();
    return err(built.error);
  }
  const deps = built.value;
  let closing: Promise<Result<void, MaintenanceError>> | undefined;
  return ok({
    deps,
    close: () =>
      (closing ??= (async () => {
        const result = await db.close();
        return result.isErr()
          ? err({ type: "maintenance_error", code: "store" } as MaintenanceError)
          : ok(undefined);
      })()),
  });
}
