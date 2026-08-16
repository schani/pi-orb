import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { OrbHostProviderError } from "../../domain/errors.ts";
import type {
  OperationContext,
  OrbHostObservation,
  OrbHostProvider,
  OrbHostRef,
  ProvisionedOrbHost,
  ProvisionOrbHostRequest,
  StartOrbHostRequest,
} from "../../domain/ports.ts";
import { specFingerprintOf } from "../spec-fingerprint.ts";

export interface ProcessOrbHostProviderOptions {
  readonly stateDirectory: string;
  readonly runtimeEntryPoint: string;
  readonly controlPlaneUrl: string;
  readonly nodeExecutable?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly restartDelayMs?: number;
  /**
   * Grace between SIGTERM and SIGKILL, and after SIGKILL before disposal
   * reports uncertainty instead of absence. Defaults to 2s.
   */
  readonly terminateGraceMs?: number;
  /**
   * Test-composition-only seam: awaited when a crash-relaunch timer fires,
   * before the relaunch takes the per-orb lock. Lets tests order a discard
   * against an in-flight relaunch deterministically.
   */
  readonly onCrashRelaunch?: (orbId: string) => Promise<void>;
  readonly specGeneration?: number;
}

interface HostMetadata {
  readonly v: 1;
  readonly orbId: string;
  readonly incarnation: number;
  readonly repositoryUrl: string;
  readonly specFingerprint: string | null;
  readonly runtimeToken: string;
  readonly port: number;
  /** Process-group leader PID, persisted so disposal survives provider restart. */
  readonly processGroupId: number | null;
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

export interface ProcessRow {
  readonly pid: number;
  readonly processGroupId: number;
}

/**
 * The live (non-zombie) rows of `ps -o pid=,pgid=,stat= …` output. Pure so the
 * classification is unit-testable without depending on real process timing.
 *
 * A zombie — state column starting with `Z` — is definitively dead even though
 * `kill(pid, 0)` and `kill(-pgid, 0)` still answer for it until the parent
 * reaps it. Rows are also carried with their group so callers can filter,
 * which keeps the answer correct even where `ps -g` does not filter itself.
 * Anything unparseable is ignored rather than guessed at.
 */
export function liveProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const [pid, processGroupId, state] = fields;
    if (pid === undefined || processGroupId === undefined || state === undefined) continue;
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(processGroupId)) continue;
    if (state.startsWith("Z")) continue;
    rows.push({ pid: Number(pid), processGroupId: Number(processGroupId) });
  }
  return rows;
}

export class ProcessOrbHostProvider implements OrbHostProvider {
  readonly kind = "process";
  readonly specGeneration: number;
  private readonly children = new Map<string, ManagedChild>();
  private readonly locks = new Map<string, Promise<void>>();
  private closing = false;

  private readonly options: ProcessOrbHostProviderOptions;

  constructor(options: ProcessOrbHostProviderOptions) {
    this.options = options;
    this.specGeneration = options.specGeneration ?? 0;
  }

  desiredSpecFingerprint(input: {
    readonly orbId: string;
    readonly repositoryUrl: string;
  }): string {
    return specFingerprintOf({
      v: 1,
      runtimeEntryPoint: this.options.runtimeEntryPoint,
      nodeExecutable: this.options.nodeExecutable ?? process.execPath,
      controlPlaneUrl: this.options.controlPlaneUrl,
      extraEnv: this.options.extraEnv ?? {},
      repositoryUrl: input.repositoryUrl,
    });
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
      // Pre-incarnation process metadata is the one legacy internal resource
      // shape retained by the replacement contract: unstamped means 0, and no
      // persisted process group means there is nothing restart-verifiable to kill.
      const incarnation = parsed.incarnation ?? 0;
      const processGroupId = parsed.processGroupId ?? null;
      if (
        parsed.v !== 1 ||
        parsed.orbId !== orbId ||
        !Number.isSafeInteger(incarnation) ||
        incarnation < 0 ||
        typeof parsed.repositoryUrl !== "string" ||
        typeof parsed.runtimeToken !== "string" ||
        typeof parsed.port !== "number" ||
        (processGroupId !== null &&
          (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) ||
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
      return ok({
        v: 1,
        orbId,
        incarnation,
        repositoryUrl: parsed.repositoryUrl,
        specFingerprint: typeof parsed.specFingerprint === "string" ? parsed.specFingerprint : null,
        runtimeToken: parsed.runtimeToken,
        port: parsed.port,
        processGroupId,
        desiredState: parsed.desiredState,
      });
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
      PI_ORB_HOST_INCARNATION: String(metadata.incarnation),
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
        if (!this.forgetChild(metadata.orbId, managed)) return;
        if (managed.intentional || this.closing) return;
        setTimeout(() => {
          void (async (): Promise<void> => {
            await this.options.onCrashRelaunch?.(metadata.orbId);
            // The relaunch runs under the same per-orb lock as provision,
            // start, stop, and discard, and re-reads the metadata inside it:
            // a discard that won the race removed the file, so the relaunch
            // aborts instead of resurrecting a fenced incarnation.
            await this.withLock(metadata.orbId, async () => {
              const current = this.readMetadata("start", metadata.orbId);
              if (current.isErr()) return err(current.error);
              if (
                current.value === null ||
                current.value.desiredState !== "running" ||
                this.closing
              ) {
                return ok(undefined);
              }
              return this.launch("start", current.value);
            });
          })();
        }, this.options.restartDelayMs ?? 250);
      });
      return new Promise((resolve) => {
        child.once("spawn", () => {
          if (child.pid === undefined) {
            resolve(err(hostError(operation, "operation_failed", "child has no pid", true)));
            return;
          }
          // Every launch runs under the per-orb lock, so a discard cannot
          // interleave here — but if the metadata is gone anyway, rewriting
          // it would resurrect a fenced incarnation. Detect, kill what was
          // just spawned, and report the lost race instead.
          if (!existsSync(this.metadataPath(metadata.orbId))) {
            managed.intentional = true;
            if (this.children.get(metadata.orbId) === managed) {
              this.children.delete(metadata.orbId);
            }
            const kill = Result.fromThrowable(
              (pid: number) => process.kill(pid, "SIGKILL"),
              (error) => error as NodeJS.ErrnoException,
            );
            kill(process.platform === "win32" ? child.pid : -child.pid);
            resolve(
              err(hostError(operation, "conflict", "host metadata removed during launch", true)),
            );
            return;
          }
          const written = this.writeMetadata(operation, {
            ...metadata,
            processGroupId: child.pid,
          });
          resolve(written.isErr() ? err(written.error) : ok(undefined));
        });
        child.once("error", (error) => {
          if (this.children.get(metadata.orbId) === managed) this.children.delete(metadata.orbId);
          resolve(err(hostError(operation, "unavailable", String(error), true)));
        });
      });
    } catch (error) {
      return Promise.resolve(err(hostError(operation, "unavailable", String(error), true)));
    }
  }

  /**
   * Drop a child this provider no longer supervises and release the process
   * group it committed. Returns whether this call owned the entry — a later
   * `exit` event for an already-forgotten child must not touch anything.
   */
  private forgetChild(orbId: string, managed: ManagedChild): boolean {
    if (this.children.get(orbId) !== managed) return false;
    this.children.delete(orbId);
    const latest = this.readMetadata("start", orbId);
    if (
      latest.isOk() &&
      latest.value !== null &&
      latest.value.processGroupId === managed.child.pid
    ) {
      this.writeMetadata("start", { ...latest.value, processGroupId: null });
    }
    return true;
  }

  private ref(orbId: string, incarnation: number): OrbHostRef {
    return {
      provider: "process",
      resourceId: `${encodeURIComponent(orbId)}-i${incarnation}`,
    };
  }

  private identityFromRef(ref: OrbHostRef): { orbId: string; incarnation: number } | null {
    const match = /^(.*)-i(\d+)$/.exec(ref.resourceId);
    if (match?.[1] === undefined || match[2] === undefined) return null;
    const incarnation = Number(match[2]);
    if (!Number.isSafeInteger(incarnation)) return null;
    return { orbId: decodeURIComponent(match[1]), incarnation };
  }

  /** POC policy: refs without an incarnation suffix (legacy) are unsupported. */
  private invalidRefError(
    operation: OrbHostProviderError["operation"],
    resourceId: string,
  ): OrbHostProviderError {
    return hostError(operation, "conflict", `invalid process host ref ${resourceId}`, false);
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
      const specFingerprint = this.desiredSpecFingerprint({
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
      });
      if (metadata === null) {
        const port = await this.allocatePort(context.signal);
        if (port.isErr()) return err(port.error);
        metadata = {
          v: 1,
          orbId: request.orbId,
          incarnation: request.incarnation,
          repositoryUrl: request.bootstrap.repositoryUrl,
          specFingerprint,
          runtimeToken: randomBytes(32).toString("hex"),
          port: port.value,
          processGroupId: null,
          desiredState: "running",
        };
        const written = this.writeMetadata("provision", metadata);
        if (written.isErr()) return err(written.error);
        task.log(`provisioned process host ${request.orbId}`);
      } else if (metadata.incarnation !== request.incarnation) {
        return err(
          hostError(
            "provision",
            "conflict",
            `process host carries incarnation ${metadata.incarnation}, expected ${request.incarnation}`,
            false,
          ),
        );
      } else if (metadata.specFingerprint !== specFingerprint) {
        return err(hostError("provision", "conflict", "process specification mismatch", false));
      } else if (metadata.desiredState === "stopped") {
        metadata = { ...metadata, desiredState: "running" };
        const written = this.writeMetadata("provision", metadata);
        if (written.isErr()) return err(written.error);
      }
      const launched = await this.launch("provision", metadata);
      if (launched.isErr()) return err(launched.error);
      return ok({
        ref: this.ref(request.orbId, metadata.incarnation),
        incarnation: metadata.incarnation,
        runtimeTokenHash: sha256(metadata.runtimeToken),
        specFingerprint,
        specGeneration: this.specGeneration,
      });
    });
    return new ResultAsync(run);
  }

  start(
    _task: SimulationTask,
    request: StartOrbHostRequest,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const identity = this.identityFromRef(request.ref);
    if (identity === null) {
      return new ResultAsync(
        Promise.resolve(err(this.invalidRefError("start", request.ref.resourceId))),
      );
    }
    return new ResultAsync(
      this.withLock(identity.orbId, async () => {
        if (context.signal.aborted)
          return err(hostError("start", "cancelled", "start cancelled", true));
        const found = this.readMetadata("start", identity.orbId);
        if (found.isErr()) return err(found.error);
        if (found.value === null)
          return err(
            hostError(
              "start",
              "invalid_state",
              `process host ${request.ref.resourceId} does not exist`,
              false,
            ),
          );
        if (
          found.value.incarnation !== request.expectedIncarnation ||
          identity.incarnation !== request.expectedIncarnation
        ) {
          return err(hostError("start", "conflict", "process incarnation mismatch", false));
        }
        if (found.value.specFingerprint !== request.expectedSpecFingerprint) {
          return err(hostError("start", "conflict", "process specification mismatch", false));
        }
        const metadata = { ...found.value, desiredState: "running" as const };
        const written = this.writeMetadata("start", metadata);
        if (written.isErr()) return err(written.error);
        return this.launch("start", metadata);
      }),
    );
  }

  /**
   * The one SIGTERM → bounded group wait → SIGKILL → bounded group wait
   * ladder every termination path shares. Absence of the *whole group* is
   * the only success: probing the leader alone would report absence while a
   * group member survives, and returning before the post-SIGKILL probe would
   * report absence on hope. Uncertainty is a retryable error
   * (docs/compute-replacement.md).
   */
  private async killProcessGroup(
    operation: OrbHostProviderError["operation"],
    processGroupId: number,
  ): Promise<Result<void, OrbHostProviderError>> {
    const kill = Result.fromThrowable(
      (pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal),
      (error) => error as NodeJS.ErrnoException,
    );
    // On POSIX the negative pid addresses the whole group for signals and
    // for the signal-0 existence probe alike: ESRCH means every member is
    // gone. It still answers for an exited-but-unreaped leader, so absence
    // is confirmed by the zombie-aware group probe below rather than by the
    // signal-0 result alone.
    const target = process.platform === "win32" ? processGroupId : -processGroupId;
    const grace = this.options.terminateGraceMs ?? 2_000;
    /**
     * macOS has no `/proc`, so `ps` is the only way to tell a real group member
     * from an exited-but-unreaped zombie that `kill(-pgid, 0)` still answers
     * for. Without this the ladder's post-SIGKILL probe waits out the whole
     * grace whenever reaping lags under load and then reports a group that is
     * in fact gone as "still exists after SIGKILL".
     */
    const darwinGroupHasLiveMembers = (): Result<boolean, OrbHostProviderError> =>
      Result.fromThrowable(
        () =>
          spawnSync("ps", ["-o", "pid=,pgid=,stat=", "-g", String(processGroupId)], {
            encoding: "utf8",
          }),
        (error) => hostError(operation, "unavailable", String(error), true),
      )().andThen((probe) => {
        if (probe.error !== undefined) {
          return err(hostError(operation, "unavailable", String(probe.error), true));
        }
        // `ps` exits non-zero with empty output when nothing matches, which is
        // exactly the absence answer — only a failure to run is uncertainty.
        const stdout = typeof probe.stdout === "string" ? probe.stdout : "";
        return ok(liveProcessRows(stdout).some((row) => row.processGroupId === processGroupId));
      });
    const groupHasLiveMembers = (): Result<boolean, OrbHostProviderError> => {
      if (process.platform === "darwin") return darwinGroupHasLiveMembers();
      // Unknown platforms stay conservative: kill(-pgid, 0) is the only evidence.
      if (process.platform !== "linux") return ok(true);
      return Result.fromThrowable(
        () => {
          for (const entry of readdirSync("/proc", { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
            let stat: string;
            try {
              stat = readFileSync(`/proc/${entry.name}/stat`, "utf8");
            } catch {
              continue; // Process exited between directory enumeration and read.
            }
            // /proc/<pid>/stat fields: pid, (comm), state, ppid, pgrp. A
            // zombie is definitively dead even while an unreaping PID 1 keeps
            // its process-group identity visible to kill(-pgrp, 0).
            const match = /^\d+ \(.*\) ([A-Z]) \d+ (\d+) /.exec(stat);
            if (match !== null && Number(match[2]) === processGroupId && match[1] !== "Z") {
              return true;
            }
          }
          return false;
        },
        (error) => hostError(operation, "unavailable", String(error), true),
      )();
    };
    const groupGoneNow = (): Result<boolean, OrbHostProviderError> => {
      const exists = kill(target, 0);
      if (exists.isErr()) {
        if (exists.error.code === "ESRCH") return ok(true);
        // Darwin answers EPERM for a group whose every member is an unreaped
        // zombie. Only the state probe separates that from a real permission
        // problem, and a group with no live member is absent either way.
        if (exists.error.code !== "EPERM") {
          return err(hostError(operation, "unavailable", String(exists.error), true));
        }
      }
      return groupHasLiveMembers().map((live) => !live);
    };
    const groupGone = async (): Promise<Result<boolean, OrbHostProviderError>> => {
      const deadline = Date.now() + grace;
      for (;;) {
        const gone = groupGoneNow();
        if (gone.isErr() || gone.value) return gone;
        if (Date.now() >= deadline) return ok(false);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    /**
     * Signal delivery that tolerates a group which is already gone: ESRCH is
     * absence, and EPERM is the same zombie-group answer as above. Whether the
     * group is really gone is decided by the probe, never by the send.
     */
    const signalGroup = (signal: NodeJS.Signals): Result<void, OrbHostProviderError> => {
      const sent = kill(target, signal);
      if (sent.isOk() || sent.error.code === "ESRCH" || sent.error.code === "EPERM") {
        return ok(undefined);
      }
      return err(hostError(operation, "unavailable", String(sent.error), true));
    };
    const terminated = signalGroup("SIGTERM");
    if (terminated.isErr()) return err(terminated.error);
    const goneAfterTerm = await groupGone();
    if (goneAfterTerm.isErr()) return err(goneAfterTerm.error);
    if (goneAfterTerm.value) return ok(undefined);
    const killed = signalGroup("SIGKILL");
    if (killed.isErr()) return err(killed.error);
    const goneAfterKill = await groupGone();
    if (goneAfterKill.isErr()) return err(goneAfterKill.error);
    return goneAfterKill.value
      ? ok(undefined)
      : err(
          hostError(
            operation,
            "unavailable",
            `process group ${processGroupId} still exists after SIGKILL`,
            true,
          ),
        );
  }

  /**
   * Terminate every process this provider can know about for the orb: the
   * persisted process-group leader (which survives a provider restart) and
   * any live managed child — the latter matters when the persisted group is
   * null or stale, e.g. around a crash restart that has not committed its
   * new group yet. Resolves ok only once every addressed group is absent.
   *
   * Verified absence — not the child object's `exit` event — is what ends
   * this: the event fires when the runtime reaps, which can lag arbitrarily
   * under load. The child is therefore forgotten here, so observation and any
   * later termination reflect the ladder's answer instead of the reap's timing.
   */
  private async terminateOrbProcesses(
    operation: OrbHostProviderError["operation"],
    orbId: string,
    recordedProcessGroupId: number | null,
  ): Promise<Result<void, OrbHostProviderError>> {
    const managed = this.children.get(orbId);
    if (managed !== undefined) managed.intentional = true;
    const groups = new Set<number>();
    if (recordedProcessGroupId !== null) groups.add(recordedProcessGroupId);
    if (managed?.child.pid !== undefined) groups.add(managed.child.pid);
    for (const group of groups) {
      const killed = await this.killProcessGroup(operation, group);
      if (killed.isErr()) return killed;
    }
    if (managed !== undefined) this.forgetChild(orbId, managed);
    return ok(undefined);
  }

  stop(
    _task: SimulationTask,
    ref: OrbHostRef,
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    const identity = this.identityFromRef(ref);
    if (identity === null) {
      return new ResultAsync(Promise.resolve(err(this.invalidRefError("stop", ref.resourceId))));
    }
    return new ResultAsync(
      this.withLock(identity.orbId, async () => {
        if (context.signal.aborted)
          return err(hostError("stop", "cancelled", "stop cancelled", true));
        const found = this.readMetadata("stop", identity.orbId);
        if (found.isErr()) return err(found.error);
        if (found.value === null || found.value.incarnation !== identity.incarnation) {
          return ok(undefined);
        }
        const written = this.writeMetadata("stop", { ...found.value, desiredState: "stopped" });
        if (written.isErr()) return err(written.error);
        return this.terminateOrbProcesses("stop", identity.orbId, found.value.processGroupId);
      }),
    );
  }

  discardCompute(
    _task: SimulationTask,
    request: { orbId: string; throughIncarnation: number },
    context: OperationContext,
  ): ResultAsync<void, OrbHostProviderError> {
    return new ResultAsync(
      this.withLock(request.orbId, async () => {
        if (context.signal.aborted) {
          return err(hostError("discard", "cancelled", "discard cancelled", true));
        }
        const found = this.readMetadata("discard", request.orbId);
        if (found.isErr()) return err(found.error);
        if (found.value === null || found.value.incarnation > request.throughIncarnation) {
          return ok(undefined);
        }
        const terminated = await this.terminateOrbProcesses(
          "discard",
          request.orbId,
          found.value.processGroupId,
        );
        if (terminated.isErr()) return err(terminated.error);
        try {
          rmSync(this.metadataPath(request.orbId), { force: true });
          rmSync(join(this.hostDirectory(request.orbId), "runtime.log"), { force: true });
          rmSync(join(this.hostDirectory(request.orbId), "runtime.err.log"), { force: true });
          return ok(undefined);
        } catch (error) {
          return err(hostError("discard", "unavailable", String(error), true));
        }
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
        const terminated = await this.terminateOrbProcesses(
          "destroy",
          orbId,
          found.value?.processGroupId ?? null,
        );
        if (terminated.isErr()) return err(terminated.error);
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
    const identity = this.identityFromRef(ref);
    if (identity === null) {
      return new ResultAsync(Promise.resolve(err(this.invalidRefError("observe", ref.resourceId))));
    }
    const found = this.readMetadata("observe", identity.orbId);
    if (found.isErr()) return new ResultAsync(Promise.resolve(err(found.error)));
    if (found.value === null || found.value.incarnation !== identity.incarnation) {
      return new ResultAsync(Promise.resolve(ok(null)));
    }
    const managed = this.children.get(identity.orbId);
    const running =
      managed !== undefined && managed.child.exitCode === null && managed.child.signalCode === null;
    return new ResultAsync(
      Promise.resolve(
        ok({
          ref: this.ref(found.value.orbId, found.value.incarnation),
          orbId: found.value.orbId,
          incarnation: found.value.incarnation,
          specFingerprint: found.value.specFingerprint,
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
          const metadata = this.readMetadata("list", orbId);
          if (metadata.isErr()) return err(metadata.error);
          if (metadata.value === null) continue;
          const observed = await this.observe(
            task,
            this.ref(orbId, metadata.value.incarnation),
            context,
          );
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
    // Best-effort at shutdown: the ladder's verified-absence errors are moot
    // once the provider is gone.
    await Promise.all(
      [...this.children.keys()].map((orbId) => this.terminateOrbProcesses("stop", orbId, null)),
    );
  }
}
