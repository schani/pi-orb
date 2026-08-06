import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
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
   * endpoint, docs/credentials.md). When omitted, containers use
   * `http://host.docker.internal:<port>` via the `host-gateway` host entry.
   */
  readonly controlPlaneUrl?: string;
  /** Port for the gateway-derived control-plane URL. */
  readonly controlPlanePort: number;
  /** Extra environment passed to every orb container (e.g. E2E mock-OpenAI URLs). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

const ORB_LABEL = "pi-orb.orb-id";

/** Port the orb runtime listens on inside the container (apps/orb-runtime). */
export const RUNTIME_PORT = 8080;

/**
 * Hostname orb containers use for the control plane, mapped to the Docker
 * `host-gateway` special value (Docker 20.10+). It resolves to the real host on
 * Docker Desktop and to the bridge gateway — i.e. the host — on Linux, so it is
 * one uniform mechanism rather than a macOS special case.
 */
export const DOCKER_HOST_ALIAS = "host.docker.internal";

/**
 * Host-loopback port the runtime port is published on, from `docker inspect`'s
 * `NetworkSettings.Ports` map. Docker Desktop (macOS) makes container bridge IPs
 * unreachable from the host, so the published loopback mapping is the only
 * address a host-run control plane can dial. The mapping is ephemeral — Docker
 * re-picks the host port on every container start — which is fine because
 * `runtimeAddress` is re-read at observe time and never persisted
 * (docs/host-provider.md).
 */
export function publishedRuntimePort(info: Record<string, unknown>): string | null {
  const networkSettings = (info["NetworkSettings"] ?? {}) as Record<string, unknown>;
  const ports = (networkSettings["Ports"] ?? {}) as Record<string, unknown>;
  const bindings = ports[`${RUNTIME_PORT}/tcp`];
  if (!Array.isArray(bindings)) return null;
  for (const binding of bindings) {
    if (typeof binding !== "object" || binding === null) continue;
    const entry = binding as Record<string, unknown>;
    const hostIp = entry["HostIp"];
    const hostPort = entry["HostPort"];
    if (typeof hostPort !== "string" || hostPort === "") continue;
    // Only IPv4 bindings reachable on loopback; `""` means all interfaces.
    if (hostIp === "127.0.0.1" || hostIp === "0.0.0.0" || hostIp === "") return hostPort;
  }
  return null;
}

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
 * at this boundary. The runtime address prefers the published host-loopback
 * mapping, falling back to the bridge IP and then the container name on the
 * shared Docker network.
 */
export class DockerOrbHostProvider implements OrbHostProvider {
  readonly kind = "docker";
  private readonly options: DockerOrbHostProviderOptions;

  constructor(options: DockerOrbHostProviderOptions) {
    this.options = options;
  }

  /**
   * The broker URL orb containers use. Unless configured explicitly, containers
   * reach the control plane through `host.docker.internal`, published into the
   * container by `--add-host=host.docker.internal:host-gateway`. The bridge
   * gateway IP this used to inspect is the host only on Linux; on Docker Desktop
   * it is the VM's internal gateway where nothing listens, so the runtime's
   * credential-broker call hangs and the orb never reaches `running`.
   */
  private controlPlaneUrl(): string {
    const { controlPlaneUrl, controlPlanePort } = this.options;
    return controlPlaneUrl ?? `http://${DOCKER_HOST_ALIAS}:${controlPlanePort}`;
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

  /**
   * The single place a runtime address is derived from `docker inspect`, shared
   * by every observation path. Prefers the published host-loopback mapping
   * (the only address that works on Docker Desktop), then the bridge-network IP,
   * then the container name (which resolves when the control plane shares the
   * Docker network).
   */
  private runtimeBaseUrl(info: Record<string, unknown>, name: string): string {
    const published = publishedRuntimePort(info);
    if (published !== null) return `http://127.0.0.1:${published}`;
    const networkSettings = (info["NetworkSettings"] ?? {}) as Record<string, unknown>;
    const networks = (networkSettings["Networks"] ?? {}) as Record<string, unknown>;
    const networkInfo = (networks[this.options.network] ?? {}) as Record<string, unknown>;
    const ip = typeof networkInfo["IPAddress"] === "string" ? networkInfo["IPAddress"] : "";
    const host = ip !== "" ? ip : name;
    return `http://${host}:${RUNTIME_PORT}`;
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
    const observation: OrbHostObservation = {
      ref: { provider: "docker", resourceId: name },
      orbId,
      state,
      ...(state === "running"
        ? { runtimeAddress: { baseUrl: this.runtimeBaseUrl(info, name) } }
        : {}),
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
          // Publish the runtime port on an ephemeral host-loopback port: bridge
          // IPs are unreachable from the host on Docker Desktop (macOS), and on
          // Linux a loopback publication is harmless.
          "--publish",
          `127.0.0.1:0:${RUNTIME_PORT}`,
          // Reach the host-run control plane from inside the container.
          `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`,
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
          `${CONTROL_PLANE_URL_ENV}=${this.controlPlaneUrl()}`,
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
