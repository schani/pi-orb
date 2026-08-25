import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_PLANE_URL_ENV,
  PREVIEW_HOST_ENV,
  RUNTIME_TOKEN_ENV,
  type RuntimeHookStatus,
  type RuntimeHooks,
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
} from "@pi-orb/protocol";
import type { SimulationTask } from "determined";
import { Result } from "neverthrow";
import type { HookName, HookProcess, HookSpawner } from "./ports.ts";

/** Amp's value (`docs/orb-setup-hook.md`); setup blocks readiness for at most this long. */
export const SETUP_DEADLINE_MS = 20 * 60_000;
/** Amp's value; after this the resume hook keeps running while the agent proceeds. */
export const RESUME_BLOCKING_WINDOW_MS = 10_000;
/** How much hook output the status file keeps for the health report and the log. */
export const STATUS_TAIL_LINES = 20;

export const HOOK_DIRECTORY = ".agents";

/** Set in every orb process so a script can branch on the platform (`PI_ORB=1`). */
export const ORB_MARKER_ENV = "PI_ORB";
export const HOOK_NAME_ENV = "PI_ORB_HOOK";

/**
 * Removed from a hook's environment. `PI_ORB_RUNTIME_TOKEN` and
 * `PI_ORB_CONTROL_PLANE_URL` are removed from setup only, which is what makes
 * "setup has no identity" mechanical rather than advisory: without them the
 * brokered helpers and `pi-orb id-token` fail closed. Tailscale material is
 * removed from both — a hook has no business joining or re-keying the tailnet.
 */
export const SETUP_SCRUBBED_ENV = [CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV] as const;
export const HOOK_SCRUBBED_ENV = [
  TAILSCALE_AUTH_KEY_ENV,
  TAILSCALE_HOSTNAME_ENV,
  PREVIEW_HOST_ENV,
] as const;

export function hookEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  hook: HookName,
): Record<string, string> {
  const scrubbed = new Set<string>([
    ...HOOK_SCRUBBED_ENV,
    ...(hook === "setup" ? SETUP_SCRUBBED_ENV : []),
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || scrubbed.has(key)) continue;
    env[key] = value;
  }
  env[ORB_MARKER_ENV] = "1";
  env[HOOK_NAME_ENV] = hook;
  return env;
}

export type HookDiscovery =
  | { readonly kind: "absent" }
  | { readonly kind: "executable"; readonly path: string }
  | { readonly kind: "not_executable"; readonly path: string };

/**
 * "Forgot `chmod +x`" and "no hook" must not look the same: a present but
 * non-executable file is a reported failure, never a silent skip.
 */
export function discoverHook(repoDir: string, hook: HookName): HookDiscovery {
  const path = join(repoDir, HOOK_DIRECTORY, hook);
  const stat = Result.fromThrowable(
    () => statSync(path),
    () => undefined,
  )();
  if (stat.isErr()) return { kind: "absent" };
  if (!stat.value.isFile() || (stat.value.mode & 0o111) === 0) {
    return { kind: "not_executable", path };
  }
  return { kind: "executable", path };
}

export interface BootHookRunnerOptions {
  /** Repository root; hooks are discovered under it and run with it as cwd. */
  readonly repoDir: string;
  /** Persistent `$HOME`; holds the log and status files. */
  readonly home: string;
  /** Persistent workspace root; holds the incarnation stamp. */
  readonly workDir: string;
  readonly incarnation: string;
  readonly task: SimulationTask;
  readonly spawner: HookSpawner;
  /** The runtime's own environment, the base both hook environments derive from. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The runtime's log stream; hook output is mirrored here line by line. */
  readonly log?: (line: string) => void;
  /**
   * Called only when setup is actually about to run, so the runtime reports
   * the `setup_running` readiness phase for exactly as long as it holds. A
   * skipped or absent hook must not flicker that phase past the control plane.
   */
  readonly onSetupStart?: () => void;
}

/**
 * Runs `.agents/setup` once per compute incarnation and `.agents/resume` on
 * every start (`docs/orb-setup-hook.md`). A hook failure is recorded and
 * surfaced but never fails the boot: a broken script must not make an orb
 * unreachable, since the agent is the tool that fixes it.
 */
export class BootHookRunner {
  private readonly options: BootHookRunnerOptions;
  private readonly statuses = new Map<HookName, RuntimeHookStatus>();
  /** A resume still running past its blocking window; terminated on shutdown. */
  private background: HookProcess | null = null;

  constructor(options: BootHookRunnerOptions) {
    this.options = options;
    for (const hook of ["setup", "resume"] as const) {
      const persisted = this.readStatus(hook);
      if (persisted !== null) this.statuses.set(hook, persisted);
    }
  }

  /** The latest outcome of each hook, for the health report. Empty on a clean orb. */
  report(): RuntimeHooks {
    const setup = this.statuses.get("setup");
    const resume = this.statuses.get("resume");
    return {
      ...(setup !== undefined ? { setup } : {}),
      ...(resume !== undefined ? { resume } : {}),
    };
  }

  /**
   * Runs setup unless this incarnation already ran it. Resolves with the
   * outcome, or null when there is no hook or it already ran — in both cases
   * boot continues immediately.
   */
  async runSetup(): Promise<RuntimeHookStatus | null> {
    if (this.stampedIncarnation() === this.options.incarnation) return null;
    const discovery = discoverHook(this.options.repoDir, "setup");
    if (discovery.kind === "absent") {
      // Nothing ran, but this incarnation is settled: a runtime restart must
      // not re-scan for a hook the agent added after boot.
      this.stampIncarnation();
      return null;
    }
    this.options.onSetupStart?.();
    const status = await this.run("setup", discovery, SETUP_DEADLINE_MS, "kill");
    this.stampIncarnation();
    return status;
  }

  /**
   * Runs resume, waiting at most the blocking window. A hook still running
   * then continues in the background with its output still captured; its
   * status is recorded when it eventually exits.
   */
  async runResume(): Promise<RuntimeHookStatus | null> {
    const discovery = discoverHook(this.options.repoDir, "resume");
    if (discovery.kind === "absent") return null;
    return this.run("resume", discovery, RESUME_BLOCKING_WINDOW_MS, "background");
  }

  /** Terminates a resume that outlived its blocking window. */
  shutdown(): void {
    this.background?.killGroup();
    this.background = null;
  }

  private async run(
    hook: HookName,
    discovery: Exclude<HookDiscovery, { kind: "absent" }>,
    deadlineMs: number,
    onDeadline: "kill" | "background",
  ): Promise<RuntimeHookStatus | null> {
    const startedAt = this.options.task.wallNow();
    const logPath = this.logPath(hook);
    if (discovery.kind !== "executable") {
      return this.record(hook, {
        outcome: "hook_not_executable",
        exitCode: null,
        startedAt,
        endedAt: startedAt,
        logPath,
        tail: [`${discovery.path} is present but not executable (chmod +x it)`],
      });
    }

    const prepared = Result.fromThrowable(
      () => mkdirSync(this.logDir(), { recursive: true }),
      (error) => (error instanceof Error ? error.message : String(error)),
    )();
    if (prepared.isErr()) {
      return this.record(hook, {
        outcome: "failed",
        exitCode: null,
        startedAt,
        endedAt: this.options.task.wallNow(),
        logPath,
        tail: [`could not prepare the hook log directory: ${prepared.error}`],
      });
    }

    const spawned = this.options.spawner.spawn({
      executable: discovery.path,
      cwd: this.options.repoDir,
      env: hookEnvironment(this.options.environment, hook),
      logPath,
      onLine: (line) => this.options.log?.(`hook ${hook}: ${line}`),
    });
    if (spawned.isErr()) {
      return this.record(hook, {
        outcome: "failed",
        exitCode: null,
        startedAt,
        endedAt: this.options.task.wallNow(),
        logPath,
        tail: [spawned.error.message],
      });
    }
    const process = spawned.value;

    const deadline = this.options.task.createDeadline(deadlineMs, `${hook} hook deadline`);
    const expired = new Promise<"expired">((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve("expired"), { once: true });
    });
    const raced = await Promise.race([
      process.exited.then((exit) => ({ kind: "exited" as const, exit })),
      expired.then(() => ({ kind: "expired" as const })),
    ]);
    deadline.cancel();

    if (raced.kind === "expired") {
      if (onDeadline === "background") {
        // The agent proceeds; the hook keeps running with its output captured
        // and records its own outcome when it exits (docs/orb-setup-hook.md).
        this.background = process;
        void process.exited.then((exit) => {
          this.background = null;
          this.record(hook, {
            outcome: exit.code === 0 ? "ok" : "failed",
            exitCode: exit.code,
            startedAt,
            endedAt: this.options.task.wallNow(),
            logPath,
            tail: process.tail(),
          });
        });
        return null;
      }
      process.killGroup();
      return this.record(hook, {
        outcome: "timeout",
        exitCode: null,
        startedAt,
        endedAt: this.options.task.wallNow(),
        logPath,
        tail: process.tail(),
      });
    }

    return this.record(hook, {
      outcome: raced.exit.code === 0 ? "ok" : "failed",
      exitCode: raced.exit.code,
      startedAt,
      endedAt: this.options.task.wallNow(),
      logPath,
      tail: process.tail(),
    });
  }

  private record(
    hook: HookName,
    partial: {
      readonly outcome: RuntimeHookStatus["outcome"];
      readonly exitCode: number | null;
      readonly startedAt: number;
      readonly endedAt: number;
      readonly logPath: string;
      readonly tail: readonly string[];
    },
  ): RuntimeHookStatus {
    const status: RuntimeHookStatus = {
      hook,
      outcome: partial.outcome,
      exitCode: partial.exitCode,
      incarnation: this.options.incarnation,
      startedAt: new Date(partial.startedAt).toISOString(),
      endedAt: new Date(partial.endedAt).toISOString(),
      logPath: partial.logPath,
    };
    this.statuses.set(hook, status);
    this.writeStatus(status, partial.tail.slice(-STATUS_TAIL_LINES));
    if (status.outcome !== "ok") {
      this.options.log?.(
        `hook ${hook}: ${status.outcome} exit_code=${status.exitCode ?? "none"} log=${status.logPath}`,
      );
    }
    return status;
  }

  private logDir(): string {
    return join(this.options.home, ".cache", "pi-orb", "logs");
  }

  private logPath(hook: HookName): string {
    return join(this.logDir(), `${hook}.log`);
  }

  private statusPath(hook: HookName): string {
    return join(this.logDir(), `${hook}.status.json`);
  }

  /**
   * Written beside the log so the outcome survives the runtime process and can
   * be read from an orb shell without the control plane.
   */
  private writeStatus(status: RuntimeHookStatus, tail: readonly string[]): void {
    Result.fromThrowable(
      () => {
        mkdirSync(this.logDir(), { recursive: true });
        writeFileSync(
          this.statusPath(status.hook),
          `${JSON.stringify({ ...status, tail }, null, 2)}\n`,
        );
      },
      (error) => (error instanceof Error ? error.message : String(error)),
    )().mapErr((message) =>
      this.options.log?.(`hook ${status.hook}: status write failed: ${message}`),
    );
  }

  private readStatus(hook: HookName): RuntimeHookStatus | null {
    return Result.fromThrowable(
      () => JSON.parse(readFileSync(this.statusPath(hook), "utf8")) as unknown,
      () => undefined,
    )()
      .map((parsed) => asHookStatus(parsed, hook))
      .unwrapOr(null);
  }

  private stampPath(): string {
    return join(this.options.workDir, ".pi-orb", "setup-incarnation");
  }

  /**
   * The durable "setup has run for this incarnation" marker. It lives in the
   * workspace, which survives the container layer, so a runtime restart does
   * not re-run a twenty-minute hook while a new incarnation always does.
   */
  private stampedIncarnation(): string | null {
    return Result.fromThrowable(
      () => readFileSync(this.stampPath(), "utf8").trim(),
      () => undefined,
    )().unwrapOr(null);
  }

  private stampIncarnation(): void {
    Result.fromThrowable(
      () => {
        mkdirSync(join(this.options.workDir, ".pi-orb"), { recursive: true });
        writeFileSync(this.stampPath(), `${this.options.incarnation}\n`);
      },
      (error) => (error instanceof Error ? error.message : String(error)),
    )().mapErr((message) => this.options.log?.(`hook setup: stamp write failed: ${message}`));
  }
}

function asHookStatus(parsed: unknown, hook: HookName): RuntimeHookStatus | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const outcome = record["outcome"];
  if (
    outcome !== "ok" &&
    outcome !== "failed" &&
    outcome !== "timeout" &&
    outcome !== "hook_not_executable"
  ) {
    return null;
  }
  const exitCode = record["exitCode"];
  const strings = ["incarnation", "startedAt", "endedAt", "logPath"] as const;
  for (const key of strings) if (typeof record[key] !== "string") return null;
  return {
    hook,
    outcome,
    exitCode: typeof exitCode === "number" ? exitCode : null,
    incarnation: record["incarnation"] as string,
    startedAt: record["startedAt"] as string,
    endedAt: record["endedAt"] as string,
    logPath: record["logPath"] as string,
  };
}
