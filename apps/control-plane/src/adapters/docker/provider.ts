import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, errAsync, ok, okAsync, Result, ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
} from "../../domain/ports.ts";

export interface DockerOrbHostProviderOptions {
  /** Orb runtime image, e.g. "pi-orb-runtime:dev". */
  readonly image: string;
  /** Docker network shared by orb containers (and the control plane when containerized). */
  readonly network: string;
  /**
   * Control-plane base URL as reachable *from orb containers* (the broker
   * endpoint, docs/credentials.md). When omitted, the provider resolves the
   * Docker network's gateway address and uses `http://<gateway>:<port>`.
   */
  readonly controlPlaneUrl?: string;
  /** Port for the gateway-derived control-plane URL. */
  readonly controlPlanePort: number;
  /** Extra environment passed to every orb container (e.g. E2E mock-OpenAI URLs). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

const ORB_LABEL = "pi-orb.orb-id";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Read the runtime token back from a container's `Config.Env` list. */
function tokenFromInspect(info: Record<string, unknown>): string | null {
  const config = info["Config"] as Record<string, unknown> | undefined;
  const env = config?.["Env"];
  if (!Array.isArray(env)) return null;
  for (const entry of env) {
    if (typeof entry === "string" && entry.startsWith(`${RUNTIME_TOKEN_ENV}=`)) {
      return entry.slice(RUNTIME_TOKEN_ENV.length + 1);
    }
  }
  return null;
}

interface DockerExecOk {
  stdout: string;
}

function providerError(
  operation: OrbHostProviderError["operation"],
  code: OrbHostProviderError["code"],
  message: string,
  retryable: boolean,
): OrbHostProviderError {
  return {
    type: "orb_host_provider_error",
    provider: "docker",
    operation,
    code,
    message,
    retryable,
  };
}

function containerName(orbId: string): string {
  return `pi-orb-${orbId}`;
}

function volumeName(orbId: string): string {
  return `pi-orb-data-${orbId}`;
}

function mapContainerState(state: string): OrbHostState {
  switch (state) {
    case "running":
      return "running";
    case "created":
    case "restarting":
      return "starting";
    case "removing":
      return "stopping";
    case "paused":
    case "exited":
      return "stopped";
    case "dead":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * Docker CLI host provider (docs/host-provider.md, docs/stack.md): one container plus one
 * persistent volume per orb, driven through `execFile` with every call caught
 * at this boundary. The runtime address uses the container name on the shared
 * Docker network.
 */
export class DockerOrbHostProvider implements OrbHostProvider {
  readonly kind = "docker";
  private readonly options: DockerOrbHostProviderOptions;
  private controlPlaneUrl: string | null = null;

  constructor(options: DockerOrbHostProviderOptions) {
    this.options = options;
    this.controlPlaneUrl = options.controlPlaneUrl ?? null;
  }

  /** The broker URL orb containers use; gateway-derived unless configured. */
  private resolveControlPlaneUrl(
    context: OperationContext,
  ): ResultAsync<string, OrbHostProviderError> {
    if (this.controlPlaneUrl !== null) return okAsync(this.controlPlaneUrl);
    return this.exec(
      "provision",
      [
        "network",
        "inspect",
        this.options.network,
        "--format",
        "{{(index .IPAM.Config 0).Gateway}}",
      ],
      context,
    ).andThen((result) => {
      const gateway = result.stdout.trim();
      if (gateway === "") {
        return errAsync(
          providerError("provision", "operation_failed", "docker network has no gateway", true),
        );
      }
      this.controlPlaneUrl = `http://${gateway}:${this.options.controlPlanePort}`;
      return okAsync(this.controlPlaneUrl);
    });
  }

  private exec(
    operation: OrbHostProviderError["operation"],
    args: string[],
    context: OperationContext,
  ): ResultAsync<DockerExecOk, OrbHostProviderError> {
    return ResultAsync.fromPromise(
      new Promise<DockerExecOk>((resolve, reject) => {
        execFile(
          "docker",
          args,
          { signal: context.signal, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(new Error(`docker ${args[0]}: ${stderr || error.message}`));
              return;
            }
            resolve({ stdout });
          },
        );
      }),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (context.signal.aborted) {
          return providerError(operation, "cancelled", message, true);
        }
        return providerError(operation, "unavailable", message, true);
      },
    );
  }

  private inspect(
    operation: OrbHostProviderError["operation"],
    name: string,
    context: OperationContext,
  ): ResultAsync<Record<string, unknown> | null, OrbHostProviderError> {
    const run = async (): Promise<Result<Record<string, unknown> | null, OrbHostProviderError>> => {
      const result = await this.exec(operation, ["inspect", "--type", "container", name], context);
      if (result.isErr()) {
        // Definitive absence vs uncertainty: docker reports "No such object".
        if (/no such (object|container)/i.test(result.error.message)) return ok(null);
        return err(result.error);
      }
      const parsed = Result.fromThrowable(
        () => JSON.parse(result.value.stdout) as unknown,
        () =>
          providerError(operation, "operation_failed", "unparseable docker inspect output", false),
      )();
      if (parsed.isErr()) return err(parsed.error);
      const first = Array.isArray(parsed.value) ? parsed.value[0] : undefined;
      if (typeof first !== "object" || first === null) return ok(null);
      return ok(first as Record<string, unknown>);
    };
    return new ResultAsync(run());
  }

  private toObservation(info: Record<string, unknown>): OrbHostObservation | null {
    const config = info["Config"] as Record<string, unknown> | undefined;
    const labels = (config?.["Labels"] ?? {}) as Record<string, unknown>;
    const orbId = labels[ORB_LABEL];
    if (typeof orbId !== "string") return null;
    const stateInfo = (info["State"] ?? {}) as Record<string, unknown>;
    const status = String(stateInfo["Status"] ?? "dead");
    const state = mapContainerState(status);
    const name = containerName(orbId);
    // Prefer the bridge-network IP so a host-run control plane can reach the
    // runtime; the container name works when the control plane shares the
    // Docker network.
    const networkSettings = (info["NetworkSettings"] ?? {}) as Record<string, unknown>;
    const networks = (networkSettings["Networks"] ?? {}) as Record<string, unknown>;
    const networkInfo = (networks[this.options.network] ?? {}) as Record<string, unknown>;
    const ip = typeof networkInfo["IPAddress"] === "string" ? networkInfo["IPAddress"] : "";
    const host = ip !== "" ? ip : name;
    const observation: OrbHostObservation = {
      ref: { provider: "docker", resourceId: name },
      orbId,
      state,
      ...(state === "running" ? { runtimeAddress: { baseUrl: `http://${host}:8080` } } : {}),
      ...(status === "dead" ? { failure: { code: "dead", message: "container is dead" } } : {}),
    };
    return observation;
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError> {
    const name = containerName(request.orbId);
    const ref: OrbHostRef = { provider: "docker", resourceId: name };
    const run = async (): Promise<Result<ProvisionedOrbHost, OrbHostProviderError>> => {
      const existing = await this.inspect("provision", name, context);
      if (existing.isErr()) return err(existing.error);
      if (existing.value !== null) {
        const existingToken = tokenFromInspect(existing.value);
        if (existingToken !== null) {
          // Idempotent: reuse the container (starting it if needed) and read
          // its token back — an existing incarnation is never re-minted.
          const observation = this.toObservation(existing.value);
          if (observation !== null && observation.state !== "running") {
            const started = await this.exec("provision", ["start", name], context);
            if (started.isErr()) return err(started.error);
          }
          return ok({ ref, runtimeTokenHash: sha256Hex(existingToken) });
        }
        // A container without a token predates the broker: replace it. The
        // data volume persists; only the compute incarnation rotates.
        const removed = await this.exec("provision", ["rm", "--force", name], context);
        if (removed.isErr()) return err(removed.error);
      }
      const controlPlaneUrl = await this.resolveControlPlaneUrl(context);
      if (controlPlaneUrl.isErr()) return err(controlPlaneUrl.error);
      const volume = await this.exec(
        "provision",
        ["volume", "create", "--label", `${ORB_LABEL}=${request.orbId}`, volumeName(request.orbId)],
        context,
      );
      if (volume.isErr()) return err(volume.error);
      const runtimeToken = randomBytes(32).toString("hex");
      const created = await this.exec(
        "provision",
        [
          "run",
          "--detach",
          "--name",
          name,
          "--label",
          `${ORB_LABEL}=${request.orbId}`,
          "--network",
          this.options.network,
          "--restart",
          "unless-stopped",
          "--volume",
          `${volumeName(request.orbId)}:/workspace`,
          "--env",
          `PI_ORB_ID=${request.orbId}`,
          "--env",
          `PI_ORB_REPOSITORY_URL=${request.bootstrap.repositoryUrl}`,
          "--env",
          `${RUNTIME_TOKEN_ENV}=${runtimeToken}`,
          "--env",
          `${CONTROL_PLANE_URL_ENV}=${controlPlaneUrl.value}`,
          ...Object.entries(this.options.extraEnv ?? {}).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          this.options.image,
        ],
        context,
      );
      if (created.isErr()) {
        // A concurrent provision may have won the name race; read the winner's
        // token back instead of reporting ours.
        if (/is already in use/i.test(created.error.message)) {
          const winner = await this.inspect("provision", name, context);
          if (winner.isErr()) return err(winner.error);
          const winnerToken = winner.value === null ? null : tokenFromInspect(winner.value);
          if (winnerToken === null) {
            return err(
              providerError("provision", "conflict", "racing container has no token", true),
            );
          }
          return ok({ ref, runtimeTokenHash: sha256Hex(winnerToken) });
        }
        return err(created.error);
      }
      task.log(`provisioned docker host ${name}`);
      return ok({ ref, runtimeTokenHash: sha256Hex(runtimeToken) });
    };
    return new ResultAsync(run());
  }

  start(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return this.exec("start", ["start", ref.resourceId], context).map(() => undefined);
  }

  stop(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const stopped = await this.exec("stop", ["stop", "--time", "10", ref.resourceId], context);
      if (stopped.isErr()) {
        // Stopping an absent or already-stopped container is idempotent success.
        if (/no such (object|container)|is not running/i.test(stopped.error.message)) {
          return ok(undefined);
        }
        return err(stopped.error);
      }
      return ok(undefined);
    };
    return new ResultAsync(run());
  }

  observe(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError> {
    return this.inspect("observe", ref.resourceId, context).map((info) =>
      info === null ? null : this.toObservation(info),
    );
  }

  listManagedHosts(
    _task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError> {
    const run = async (): Promise<Result<OrbHostObservation[], OrbHostProviderError>> => {
      const listed = await this.exec(
        "list",
        ["ps", "--all", "--filter", `label=${ORB_LABEL}`, "--format", "{{.Names}}"],
        context,
      );
      if (listed.isErr()) return err(listed.error);
      const names = listed.value.stdout.split("\n").filter((name) => name !== "");
      const observations: OrbHostObservation[] = [];
      for (const name of names) {
        const info = await this.inspect("list", name, context);
        if (info.isErr()) return err(info.error);
        if (info.value === null) continue;
        const observation = this.toObservation(info.value);
        if (observation !== null) observations.push(observation);
      }
      return ok(observations);
    };
    return new ResultAsync(run());
  }
}
