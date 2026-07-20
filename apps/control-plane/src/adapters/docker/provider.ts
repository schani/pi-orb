import { execFile } from "node:child_process";
import type { SimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  OrbHostState,
  ProvisionOrbHostRequest,
} from "../../domain/ports.ts";

export interface DockerOrbHostProviderOptions {
  /** Orb runtime image, e.g. "pi-orb-runtime:dev". */
  readonly image: string;
  /** Docker network shared by orb containers (and the control plane when containerized). */
  readonly network: string;
  /** Host directory holding Pi's auth.json; mounted into every orb (DESIGN.md §15.1). */
  readonly authDir: string;
}

const ORB_LABEL = "pi-orb.orb-id";

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
 * Docker CLI host provider (DESIGN.md §5, §17.7): one container plus one
 * persistent volume per orb, driven through `execFile` with every call caught
 * at this boundary. The runtime address uses the container name on the shared
 * Docker network.
 */
export class DockerOrbHostProvider implements OrbHostProvider {
  readonly kind = "docker";
  private readonly options: DockerOrbHostProviderOptions;

  constructor(options: DockerOrbHostProviderOptions) {
    this.options = options;
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
  ): ResultAsync<OrbHostRef, OrbHostProviderError> {
    const name = containerName(request.orbId);
    const run = async (): Promise<Result<OrbHostRef, OrbHostProviderError>> => {
      const existing = await this.inspect("provision", name, context);
      if (existing.isErr()) return err(existing.error);
      if (existing.value !== null) {
        // Idempotent: reuse the container; start it if it is not running.
        const observation = this.toObservation(existing.value);
        if (observation !== null && observation.state !== "running") {
          const started = await this.exec("provision", ["start", name], context);
          if (started.isErr()) return err(started.error);
        }
        return ok({ provider: "docker", resourceId: name });
      }
      const volume = await this.exec(
        "provision",
        ["volume", "create", "--label", `${ORB_LABEL}=${request.orbId}`, volumeName(request.orbId)],
        context,
      );
      if (volume.isErr()) return err(volume.error);
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
          "--volume",
          `${this.options.authDir}:/var/lib/pi-orb/auth`,
          "--env",
          `PI_ORB_ID=${request.orbId}`,
          "--env",
          `PI_ORB_REPOSITORY_URL=${request.bootstrap.repositoryUrl}`,
          this.options.image,
        ],
        context,
      );
      if (created.isErr()) {
        // A concurrent provision may have won the name race; that is success.
        if (/is already in use/i.test(created.error.message)) {
          return ok({ provider: "docker", resourceId: name });
        }
        return err(created.error);
      }
      task.log(`provisioned docker host ${name}`);
      return ok({ provider: "docker", resourceId: name });
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
