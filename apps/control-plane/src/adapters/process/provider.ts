import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  RUNTIME_TOKEN_ENV,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { err, ok, type Result, ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
} from "../../domain/ports.ts";

export interface ProcessOrbHostProviderOptions {
  readonly stateDirectory: string;
  readonly runtimeEntryPoint: string;
  readonly controlPlaneUrl: string;
  readonly nodeExecutable?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly restartDelayMs?: number;
}

interface HostMetadata {
  readonly v: 1;
  readonly orbId: string;
  readonly repositoryUrl: string;
  readonly runtimeToken: string;
  readonly port: number;
  readonly desiredState: "running" | "stopped";
}

interface ManagedChild {
  readonly child: ChildProcess;
  intentional: boolean;
}

function hostError(
  operation: OrbHostProviderError["operation"],
  code: OrbHostProviderError["code"],
  message: string,
  retryable: boolean,
): OrbHostProviderError {
  return {
    type: "orb_host_provider_error",
    provider: "process",
    operation,
    code,
    message,
    retryable,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ProcessOrbHostProvider implements OrbHostProvider {
  readonly kind = "process";
  private readonly children = new Map<string, ManagedChild>();
  private readonly locks = new Map<string, Promise<void>>();
  private closing = false;

  private readonly options: ProcessOrbHostProviderOptions;

  constructor(options: ProcessOrbHostProviderOptions) {
    this.options = options;
  }

  private hostDirectory(orbId: string): string {
    return join(this.options.stateDirectory, encodeURIComponent(orbId));
  }

  private metadataPath(orbId: string): string {
    return join(this.hostDirectory(orbId), "host.json");
  }

  private readMetadata(
    operation: OrbHostProviderError["operation"],
    orbId: string,
  ): Result<HostMetadata | null, OrbHostProviderError> {
    try {
      const path = this.metadataPath(orbId);
      if (!existsSync(path)) return ok(null);
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HostMetadata>;
      if (
        parsed.v !== 1 ||
        parsed.orbId !== orbId ||
        typeof parsed.repositoryUrl !== "string" ||
        typeof parsed.runtimeToken !== "string" ||
        typeof parsed.port !== "number" ||
        (parsed.desiredState !== "running" && parsed.desiredState !== "stopped")
      ) {
        return err(
          hostError(
            operation,
            "operation_failed",
            `invalid process host metadata for ${orbId}`,
            false,
          ),
        );
      }
      return ok(parsed as HostMetadata);
    } catch (error) {
      return err(hostError(operation, "unavailable", String(error), true));
    }
  }

  private writeMetadata(
    operation: OrbHostProviderError["operation"],
    metadata: HostMetadata,
  ): Result<void, OrbHostProviderError> {
    try {
      mkdirSync(this.options.stateDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.options.stateDirectory, 0o700);
      const directory = this.hostDirectory(metadata.orbId);
      const workspace = join(directory, "workspace");
      mkdirSync(join(workspace, "home"), { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      chmodSync(join(workspace, "home"), 0o700);
      const path = this.metadataPath(metadata.orbId);
      const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
      return ok(undefined);
    } catch (error) {
      return err(hostError(operation, "unavailable", String(error), true));
    }
  }

  private async withLock<T>(
    orbId: string,
    operation: () => Promise<Result<T, OrbHostProviderError>>,
  ): Promise<Result<T, OrbHostProviderError>> {
    const previous = this.locks.get(orbId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(orbId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(orbId) === queued) this.locks.delete(orbId);
    }
  }

  private allocatePort(signal: AbortSignal): Promise<Result<number, OrbHostProviderError>> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(err(hostError("provision", "cancelled", "port allocation cancelled", true)));
        return;
      }
      const server = createServer();
      const abort = (): void => {
        server.close(() =>
          resolve(err(hostError("provision", "cancelled", "port allocation cancelled", true))),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      server.once("error", (error) => {
        signal.removeEventListener("abort", abort);
        resolve(err(hostError("provision", "unavailable", String(error), true)));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => {
          signal.removeEventListener("abort", abort);
          resolve(
            port > 0
              ? ok(port)
              : err(
                  hostError(
                    "provision",
                    "operation_failed",
                    "failed to allocate runtime port",
                    true,
                  ),
                ),
          );
        });
      });
    });
  }

  private childEnvironment(metadata: HostMetadata): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment[TAILSCALE_AUTH_KEY_ENV];
    delete environment[TAILSCALE_HOSTNAME_ENV];
    delete environment[PREVIEW_HOST_ENV];
    Object.assign(environment, this.options.extraEnv ?? {}, {
      PI_ORB_ID: metadata.orbId,
      PI_ORB_REPOSITORY_URL: metadata.repositoryUrl,
      PI_ORB_WORK_DIR: join(this.hostDirectory(metadata.orbId), "workspace"),
      // Do not inherit the control-plane user's home: process-backed orbs must
      // have the same per-orb durable home contract as Docker and GCE.
      HOME: join(this.hostDirectory(metadata.orbId), "workspace", "home"),
      PI_ORB_RUNTIME_PORT: String(metadata.port),
      [RUNTIME_TOKEN_ENV]: metadata.runtimeToken,
      [CONTROL_PLANE_URL_ENV]: this.options.controlPlaneUrl,
    });
    return environment;
  }

  private launch(
    operation: OrbHostProviderError["operation"],
    metadata: HostMetadata,
  ): Promise<Result<void, OrbHostProviderError>> {
    if (this.closing)
      return Promise.resolve(err(hostError(operation, "cancelled", "provider is closing", true)));
    const existing = this.children.get(metadata.orbId);
    if (
      existing !== undefined &&
      existing.child.exitCode === null &&
      existing.child.signalCode === null
    ) {
      return Promise.resolve(ok(undefined));
    }
    try {
      const directory = this.hostDirectory(metadata.orbId);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stdout = openSync(join(directory, "runtime.log"), "a", 0o600);
      const stderr = openSync(join(directory, "runtime.err.log"), "a", 0o600);
      const child = spawn(
        this.options.nodeExecutable ?? process.execPath,
        [this.options.runtimeEntryPoint],
        {
          env: this.childEnvironment(metadata),
          detached: process.platform !== "win32",
          stdio: ["ignore", stdout, stderr, "ipc"],
        },
      );
      closeSync(stdout);
      closeSync(stderr);
      const managed: ManagedChild = { child, intentional: false };
      this.children.set(metadata.orbId, managed);
      child.once("exit", () => {
        if (this.children.get(metadata.orbId) !== managed) return;
        this.children.delete(metadata.orbId);
        if (managed.intentional || this.closing) return;
        setTimeout(() => {
          const latest = this.readMetadata("start", metadata.orbId);
          if (latest.isOk() && latest.value?.desiredState === "running" && !this.closing) {
            void this.launch("start", latest.value);
          }
        }, this.options.restartDelayMs ?? 250);
      });
      return new Promise((resolve) => {
        child.once("spawn", () => resolve(ok(undefined)));
        child.once("error", (error) => {
          if (this.children.get(metadata.orbId) === managed) this.children.delete(metadata.orbId);
          resolve(err(hostError(operation, "unavailable", String(error), true)));
        });
      });
    } catch (error) {
      return Promise.resolve(err(hostError(operation, "unavailable", String(error), true)));
    }
  }

  private ref(orbId: string): OrbHostRef {
    return { provider: "process", resourceId: orbId };
  }

  provision(
    task: SimulationTask,
    request: ProvisionOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<ProvisionedOrbHost, OrbHostProviderError> {
    const run = this.withLock(request.orbId, async () => {
      if (context.signal.aborted)
        return err(hostError("provision", "cancelled", "provision cancelled", true));
      const found = this.readMetadata("provision", request.orbId);
      if (found.isErr()) return err(found.error);
      let metadata = found.value;
      if (metadata === null) {
        const port = await this.allocatePort(context.signal);
        if (port.isErr()) return err(port.error);
        metadata = {
          v: 1,
          orbId: request.orbId,
          repositoryUrl: request.bootstrap.repositoryUrl,
          runtimeToken: randomBytes(32).toString("hex"),
          port: port.value,
          desiredState: "running",
        };
        const written = this.writeMetadata("provision", metadata);
        if (written.isErr()) return err(written.error);
        task.log(`provisioned process host ${request.orbId}`);
      } else if (metadata.desiredState === "stopped") {
        metadata = { ...metadata, desiredState: "running" };
        const written = this.writeMetadata("provision", metadata);
        if (written.isErr()) return err(written.error);
      }
      const launched = await this.launch("provision", metadata);
      if (launched.isErr()) return err(launched.error);
      return ok({ ref: this.ref(request.orbId), runtimeTokenHash: sha256(metadata.runtimeToken) });
    });
    return new ResultAsync(run);
  }

  start(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return new ResultAsync(
      this.withLock(ref.resourceId, async () => {
        if (context.signal.aborted)
          return err(hostError("start", "cancelled", "start cancelled", true));
        const found = this.readMetadata("start", ref.resourceId);
        if (found.isErr()) return err(found.error);
        if (found.value === null)
          return err(
            hostError(
              "start",
              "invalid_state",
              `process host ${ref.resourceId} does not exist`,
              false,
            ),
          );
        const metadata = { ...found.value, desiredState: "running" as const };
        const written = this.writeMetadata("start", metadata);
        if (written.isErr()) return err(written.error);
        return this.launch("start", metadata);
      }),
    );
  }

  private terminate(orbId: string): Promise<void> {
    const managed = this.children.get(orbId);
    if (managed === undefined) return Promise.resolve();
    managed.intentional = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(force);
        resolve();
      };
      managed.child.once("exit", finish);
      const force = setTimeout(() => {
        try {
          if (managed.child.pid !== undefined && process.platform !== "win32")
            process.kill(-managed.child.pid, "SIGKILL");
          else managed.child.kill("SIGKILL");
        } catch {
          finish();
        }
      }, 2_000);
      try {
        if (managed.child.pid !== undefined && process.platform !== "win32")
          process.kill(-managed.child.pid, "SIGTERM");
        else managed.child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  stop(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return new ResultAsync(
      this.withLock(ref.resourceId, async () => {
        if (context.signal.aborted)
          return err(hostError("stop", "cancelled", "stop cancelled", true));
        const found = this.readMetadata("stop", ref.resourceId);
        if (found.isErr()) return err(found.error);
        if (found.value === null) return ok(undefined);
        const written = this.writeMetadata("stop", { ...found.value, desiredState: "stopped" });
        if (written.isErr()) return err(written.error);
        await this.terminate(ref.resourceId);
        return ok(undefined);
      }),
    );
  }

  destroy(
    _task: SimulationTask,
    orbId: string,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return new ResultAsync(
      this.withLock(orbId, async () => {
        if (context.signal.aborted)
          return err(hostError("destroy", "cancelled", "destroy cancelled", true));
        const found = this.readMetadata("destroy", orbId);
        if (found.isErr()) return err(found.error);
        if (found.value !== null) {
          const written = this.writeMetadata("destroy", {
            ...found.value,
            desiredState: "stopped",
          });
          if (written.isErr()) return err(written.error);
        }
        await this.terminate(orbId);
        try {
          rmSync(this.hostDirectory(orbId), { recursive: true, force: true });
          return ok(undefined);
        } catch (error) {
          return err(hostError("destroy", "unavailable", String(error), true));
        }
      }),
    );
  }

  observe(
    _task: SimulationTask,
    ref: OrbHostRef,
    _context: OperationContext,
  ): ResultAsync<OrbHostObservation | null, OrbHostProviderError> {
    const found = this.readMetadata("observe", ref.resourceId);
    if (found.isErr()) return new ResultAsync(Promise.resolve(err(found.error)));
    if (found.value === null) return new ResultAsync(Promise.resolve(ok(null)));
    const managed = this.children.get(ref.resourceId);
    const running =
      managed !== undefined && managed.child.exitCode === null && managed.child.signalCode === null;
    return new ResultAsync(
      Promise.resolve(
        ok({
          ref: this.ref(found.value.orbId),
          orbId: found.value.orbId,
          state: running ? "running" : "stopped",
          ...(running
            ? { runtimeAddress: { baseUrl: `http://127.0.0.1:${found.value.port}` } }
            : {}),
        }),
      ),
    );
  }

  listManagedHosts(
    task: SimulationTask,
    context: OperationContext,
  ): ResultAsync<OrbHostObservation[], OrbHostProviderError> {
    try {
      if (!existsSync(this.options.stateDirectory)) {
        return new ResultAsync(Promise.resolve(ok([])));
      }
      const directories = readdirSync(this.options.stateDirectory, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
      );
      const run = async (): Promise<Result<OrbHostObservation[], OrbHostProviderError>> => {
        const observations: OrbHostObservation[] = [];
        for (const directory of directories) {
          const orbId = decodeURIComponent(directory.name);
          const observed = await this.observe(task, this.ref(orbId), context);
          if (observed.isErr()) return err(observed.error);
          if (observed.value !== null) observations.push(observed.value);
        }
        return ok(observations);
      };
      return new ResultAsync(run());
    } catch (error) {
      return new ResultAsync(
        Promise.resolve(err(hostError("list", "unavailable", String(error), true))),
      );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.children.keys()].map((orbId) => this.terminate(orbId)));
  }
}
