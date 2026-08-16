import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  previewHost,
  RUNTIME_TOKEN_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
  tailscaleHostname,
} from "@pi-orb/protocol";
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
  StartOrbHostRequest,
} from "../../domain/ports.ts";
import { specFingerprintOf } from "../spec-fingerprint.ts";
import type { TailscaleHostOptions } from "../tailscale/client.ts";

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
  /**
   * Tailscale port exposure (docs/ports.md). When absent the container is
   * created exactly as before and the runtime never sees the feature.
   */
  readonly tailscale?: TailscaleHostOptions;
  readonly specGeneration?: number;
}

const ORB_LABEL = "pi-orb.orb-id";
const INCARNATION_LABEL = "pi-orb.host-incarnation";
const SPEC_FINGERPRINT_LABEL = "pi-orb.host-spec-fingerprint";

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

function legacyContainerName(orbId: string): string {
  return `pi-orb-${orbId}`;
}

function containerName(orbId: string, incarnation: number): string {
  return `${legacyContainerName(orbId)}-i${incarnation}`;
}

function incarnationFromInspect(info: Record<string, unknown>): number | null {
  const config = info["Config"] as Record<string, unknown> | undefined;
  const labels = (config?.["Labels"] ?? {}) as Record<string, unknown>;
  const stamped = labels[INCARNATION_LABEL];
  if (stamped === undefined || stamped === null) return 0;
  if (typeof stamped !== "string" || !/^\d+$/.test(stamped)) return null;
  const incarnation = Number(stamped);
  return Number.isSafeInteger(incarnation) ? incarnation : null;
}

/** The committed host-spec stamp, or null when the container carries none. */
function specFingerprintFromInspect(info: Record<string, unknown>): string | null {
  const config = info["Config"] as Record<string, unknown> | undefined;
  const labels = (config?.["Labels"] ?? {}) as Record<string, unknown>;
  const stamped = labels[SPEC_FINGERPRINT_LABEL];
  return typeof stamped === "string" ? stamped : null;
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
  readonly specGeneration: number;
  private readonly options: DockerOrbHostProviderOptions;

  constructor(options: DockerOrbHostProviderOptions) {
    this.options = options;
    this.specGeneration = options.specGeneration ?? 0;
  }

  desiredSpecFingerprint(input: {
    readonly orbId: string;
    readonly repositoryUrl: string;
  }): string {
    return specFingerprintOf({
      v: 1,
      image: this.options.image,
      network: this.options.network,
      controlPlaneUrl: this.controlPlaneUrl(),
      extraEnv: this.options.extraEnv ?? {},
      tailscale:
        this.options.tailscale === undefined
          ? null
          : {
              hostname: tailscaleHostname(input.orbId),
              previewHost: previewHost(input.orbId, this.options.tailscale.tailnetDnsName),
            },
      repositoryUrl: input.repositoryUrl,
    });
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
          // SIGKILL, not the default SIGTERM: a docker CLI wedged in a
          // distressed daemon-socket read can ignore SIGTERM (observed
          // 2026-08-16), leaving this promise unsettled and the calling
          // reconcile pass wedged forever. The timeout must guarantee that
          // the call settles.
          {
            signal: context.signal,
            timeout: 60_000,
            killSignal: "SIGKILL",
            maxBuffer: 8 * 1024 * 1024,
          },
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
    const incarnation = incarnationFromInspect(info);
    if (incarnation === null) return null;
    const stateInfo = (info["State"] ?? {}) as Record<string, unknown>;
    const status = String(stateInfo["Status"] ?? "dead");
    const state = mapContainerState(status);
    const inspectedName = info["Name"];
    const name =
      typeof inspectedName === "string" && inspectedName !== ""
        ? inspectedName.replace(/^\//, "")
        : containerName(orbId, incarnation);
    const observation: OrbHostObservation = {
      ref: { provider: "docker", resourceId: name },
      orbId,
      incarnation,
      specFingerprint: specFingerprintFromInspect(info),
      state,
      ...(state === "running"
        ? { runtimeAddress: { baseUrl: this.runtimeBaseUrl(info, name) } }
        : {}),
      ...(status === "dead" ? { failure: { code: "dead", message: "container is dead" } } : {}),
    };
    return observation;
  }

  /**
   * `docker run` arguments that join the new container to the tailnet, or an
   * empty list when the feature is off. A mint failure is reported retryable
   * whatever its cause: the reconciler simply provisions again rather than
   * failing the orb over a tailnet hiccup.
   */
  private async tailscaleEnv(
    orbId: string,
    incarnation: number,
    context: OperationContext,
  ): Promise<Result<string[], OrbHostProviderError>> {
    const tailscale = this.options.tailscale;
    if (tailscale === undefined) return ok([]);
    const key = await tailscale.minter.mintAuthKey(orbId, incarnation, context.signal);
    if (key.isErr()) {
      return err(
        providerError(
          "provision",
          "operation_failed",
          `tailscale auth key mint failed: ${key.error.message}`,
          true,
        ),
      );
    }
    return ok([
      "--env",
      `${TAILSCALE_AUTH_KEY_ENV}=${key.value}`,
      "--env",
      `${TAILSCALE_HOSTNAME_ENV}=${tailscaleHostname(orbId)}`,
      "--env",
      `${PREVIEW_HOST_ENV}=${previewHost(orbId, tailscale.tailnetDnsName)}`,
    ]);
  }

  /**
   * Enumerate this orb's containers by exact ownership label. Incarnation
   * strictness differs by caller: the discard fence needs a valid stamp on
   * every container (`"required"` — an unparseable stamp is an error, never a
   * guess), while deletion-grade destroy is authorized by ownership alone
   * (`"optional"` — a mangled incarnation label must not leave the orb
   * permanently undeletable).
   */
  private async listOrbContainers(
    operation: OrbHostProviderError["operation"],
    orbId: string,
    context: OperationContext,
    incarnations: "required" | "optional",
  ): Promise<Result<{ name: string; incarnation: number | null }[], OrbHostProviderError>> {
    const listed = await this.exec(
      operation,
      ["ps", "--all", "--filter", `label=${ORB_LABEL}=${orbId}`, "--format", "{{.Names}}"],
      context,
    );
    if (listed.isErr()) return err(listed.error);
    const result: { name: string; incarnation: number | null }[] = [];
    for (const name of listed.value.stdout.split("\n").filter((entry) => entry !== "")) {
      const inspected = await this.inspect(operation, name, context);
      if (inspected.isErr()) return err(inspected.error);
      if (inspected.value === null) continue;
      const labels = ((inspected.value["Config"] as Record<string, unknown> | undefined)?.[
        "Labels"
      ] ?? {}) as Record<string, unknown>;
      if (labels[ORB_LABEL] !== orbId) {
        return err(
          providerError(
            operation,
            "conflict",
            `container ${name} is not labeled for orb ${orbId}`,
            false,
          ),
        );
      }
      const incarnation = incarnationFromInspect(inspected.value);
      if (incarnation === null && incarnations === "required") {
        return err(
          providerError(operation, "conflict", `container ${name} has invalid incarnation`, false),
        );
      }
      result.push({ name, incarnation });
    }
    return ok(result);
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError> {
    const name = containerName(request.orbId, request.incarnation);
    const ref: OrbHostRef = { provider: "docker", resourceId: name };
    const specFingerprint = this.desiredSpecFingerprint({
      orbId: request.orbId,
      repositoryUrl: request.bootstrap.repositoryUrl,
    });
    const run = async (): Promise<Result<ProvisionedOrbHost, OrbHostProviderError>> => {
      const existing = await this.inspect("provision", name, context);
      if (existing.isErr()) return err(existing.error);
      if (existing.value !== null) {
        const existingToken = tokenFromInspect(existing.value);
        if (existingToken !== null) {
          // Idempotent: reuse the container (starting it if needed) and read
          // its token back — an existing incarnation is never re-minted. The
          // incarnation check comes first: a wrong-incarnation container must
          // never be started.
          const incarnation = incarnationFromInspect(existing.value);
          if (incarnation !== request.incarnation) {
            return err(
              providerError(
                "provision",
                "conflict",
                `container ${name} carries incarnation ${String(incarnation)}, expected ${request.incarnation}`,
                false,
              ),
            );
          }
          // The spec stamp is checked before any state change, exactly like
          // the incarnation: a stale-spec container must never be started —
          // resurrecting it in place is the mutation this design forbids.
          if (specFingerprintFromInspect(existing.value) !== specFingerprint) {
            return err(
              providerError("provision", "conflict", "container specification mismatch", false),
            );
          }
          const observation = this.toObservation(existing.value);
          if (observation !== null && observation.state !== "running") {
            const started = await this.exec("provision", ["start", name], context);
            if (started.isErr()) return err(started.error);
          }
          return ok({
            ref,
            incarnation,
            runtimeTokenHash: sha256Hex(existingToken),
            specFingerprint,
            specGeneration: this.specGeneration,
          });
        }
        // A container without a token predates the broker: replace it. The
        // data volume persists; only the compute incarnation rotates.
        const removed = await this.exec("provision", ["rm", "--force", name], context);
        if (removed.isErr()) return err(removed.error);
      }
      // Minted only for a container that is actually about to be created —
      // the reuse path above keeps whatever env its incarnation was born
      // with, exactly like the runtime token.
      const tailscaleEnv = await this.tailscaleEnv(request.orbId, request.incarnation, context);
      if (tailscaleEnv.isErr()) return err(tailscaleEnv.error);
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
          "--label",
          `${INCARNATION_LABEL}=${request.incarnation}`,
          "--label",
          `${SPEC_FINGERPRINT_LABEL}=${specFingerprint}`,
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
          `PI_ORB_HOST_INCARNATION=${request.incarnation}`,
          "--env",
          `${RUNTIME_TOKEN_ENV}=${runtimeToken}`,
          "--env",
          `${CONTROL_PLANE_URL_ENV}=${this.controlPlaneUrl()}`,
          ...tailscaleEnv.value,
          ...Object.entries(this.options.extraEnv ?? {}).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          // HOME is part of the durable orb filesystem contract. Keep this
          // after extraEnv so composition cannot redirect home to the
          // disposable container layer.
          "--env",
          "HOME=/workspace/home",
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
          const winnerInfo = winner.value;
          const winnerToken = winnerInfo === null ? null : tokenFromInspect(winnerInfo);
          if (winnerInfo === null || winnerToken === null) {
            return err(
              providerError("provision", "conflict", "racing container has no token", true),
            );
          }
          const incarnation = incarnationFromInspect(winnerInfo);
          if (incarnation !== request.incarnation) {
            return err(
              providerError(
                "provision",
                "conflict",
                `racing container ${name} has the wrong incarnation`,
                false,
              ),
            );
          }
          if (specFingerprintFromInspect(winnerInfo) !== specFingerprint) {
            return err(
              providerError("provision", "conflict", "racing specification mismatch", false),
            );
          }
          return ok({
            ref,
            incarnation,
            runtimeTokenHash: sha256Hex(winnerToken),
            specFingerprint,
            specGeneration: this.specGeneration,
          });
        }
        return err(created.error);
      }
      task.log(`provisioned docker host ${name}`);
      return ok({
        ref,
        incarnation: request.incarnation,
        runtimeTokenHash: sha256Hex(runtimeToken),
        specFingerprint,
        specGeneration: this.specGeneration,
      });
    };
    return new ResultAsync(run());
  }

  start(
    _task: SimulationTask,
    request: StartOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const inspected = await this.inspect("start", request.ref.resourceId, context);
      if (inspected.isErr()) return err(inspected.error);
      if (inspected.value === null) {
        return err(providerError("start", "invalid_state", "container is absent", false));
      }
      if (incarnationFromInspect(inspected.value) !== request.expectedIncarnation) {
        return err(providerError("start", "conflict", "container incarnation mismatch", false));
      }
      if (specFingerprintFromInspect(inspected.value) !== request.expectedSpecFingerprint) {
        return err(providerError("start", "conflict", "container specification mismatch", false));
      }
      const started = await this.exec("start", ["start", request.ref.resourceId], context);
      return started.map(() => undefined);
    };
    return new ResultAsync(run());
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

  discardCompute(
    _task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const listed = await this.listOrbContainers("discard", request.orbId, context, "required");
      if (listed.isErr()) return err(listed.error);
      for (const container of listed.value) {
        if (container.incarnation === null || container.incarnation > request.throughIncarnation) {
          continue;
        }
        const removed = await this.exec("discard", ["rm", "--force", container.name], context);
        if (removed.isErr() && !/no such (object|container)/i.test(removed.error.message)) {
          return err(removed.error);
        }
      }
      return ok(undefined);
    };
    return new ResultAsync(run());
  }

  destroy(
    _task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const run = async (): Promise<Result<void, OrbHostProviderError>> => {
      const listed = await this.listOrbContainers("destroy", orbId, context, "optional");
      if (listed.isErr()) return err(listed.error);
      for (const container of listed.value) {
        const removed = await this.exec("destroy", ["rm", "--force", container.name], context);
        if (removed.isErr() && !/no such (object|container)/i.test(removed.error.message)) {
          return err(removed.error);
        }
      }

      const volumeNameForOrb = volumeName(orbId);
      const inspectedVolume = await this.exec(
        "destroy",
        ["volume", "inspect", volumeNameForOrb],
        context,
      );
      if (inspectedVolume.isErr()) {
        if (/no such volume/i.test(inspectedVolume.error.message)) return ok(undefined);
        return err(inspectedVolume.error);
      }
      const parsed = Result.fromThrowable(
        () => JSON.parse(inspectedVolume.value.stdout) as unknown,
        () => providerError("destroy", "operation_failed", "unparseable volume inspect", false),
      )();
      if (parsed.isErr()) return err(parsed.error);
      const first = Array.isArray(parsed.value) ? parsed.value[0] : undefined;
      const labels =
        typeof first === "object" && first !== null
          ? (((first as Record<string, unknown>)["Labels"] ?? {}) as Record<string, unknown>)
          : {};
      if (labels[ORB_LABEL] !== orbId) {
        return err(
          providerError(
            "destroy",
            "conflict",
            `volume ${volumeNameForOrb} is not labeled for orb ${orbId}`,
            false,
          ),
        );
      }
      const volume = await this.exec(
        "destroy",
        ["volume", "rm", "--force", volumeNameForOrb],
        context,
      );
      if (volume.isErr() && !/no such volume/i.test(volume.error.message)) return err(volume.error);
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

  diagnose(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<string | null, OrbHostProviderError> {
    return this.inspect("observe", ref.resourceId, context).map((info) => {
      if (info === null) return null;
      const state = (info["State"] ?? {}) as Record<string, unknown>;
      const status = String(state["Status"] ?? "unknown");
      const restartCount = Number(info["RestartCount"] ?? state["RestartCount"] ?? 0);
      const exitCode = Number(state["ExitCode"] ?? 0);
      return `container_status=${status} restart_count=${restartCount} exit_code=${exitCode}`;
    });
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
