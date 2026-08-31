import { statSync } from "node:fs";
import { dirname, join } from "node:path";
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
import {
  HOOK_ENV_FILE_ENV,
  HOOK_NAME_ENV,
  type HookEnvReport,
  hookEnvPath,
  ORB_MARKER_ENV,
  parseHookEnvFile,
} from "./env-file.ts";
import { NodeHookFileStore } from "./files.ts";
import type { HookFileStore, HookName, HookProcess, HookSpawner } from "./ports.ts";

/** Amp's value (`docs/orb-setup-hook.md`); setup blocks readiness for at most this long. */
export const SETUP_DEADLINE_MS = 20 * 60_000;
/** Amp's value; after this the resume hook keeps running while the agent proceeds. */
export const RESUME_BLOCKING_WINDOW_MS = 10_000;
/** How much hook output the status file keeps for the health report and the log. */
export const STATUS_TAIL_LINES = 20;

export const HOOK_DIRECTORY = ".agents";

/** Both hooks' output and status files, under the persistent `$HOME`. */
export const hookLogDir = (home: string): string => join(home, ".cache", "pi-orb", "logs");
export const hookLogPath = (home: string, hook: HookName): string =>
  join(hookLogDir(home), `${hook}.log`);
export const hookStatusPath = (home: string, hook: HookName): string =>
  join(hookLogDir(home), `${hook}.status.json`);
/** What the runtime made of the env file, beside the hooks' own verdicts. */
export const hookEnvStatusPath = (home: string): string =>
  join(hookLogDir(home), "env.status.json");
/** The "setup has run for this incarnation" marker, under the persistent workspace. */
export const hookStampPath = (workDir: string): string =>
  join(workDir, ".pi-orb", "setup-incarnation");

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
  envFile: string,
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
  env[HOOK_ENV_FILE_ENV] = envFile;
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
  /** Where the status files and the incarnation stamp land; the real disk by default. */
  readonly files?: HookFileStore;
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

/** Everything one finished hook run hands to `record`. */
interface HookRunRecord {
  readonly outcome: RuntimeHookStatus["outcome"];
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly logPath: string;
  readonly tail: readonly string[];
}

/**
 * How one hook run ended. `ranHook` separates "the script reached a verdict"
 * from "we never got it started", which is what decides whether an
 * incarnation's single setup has been spent.
 */
type HookRunOutcome =
  | { readonly kind: "settled"; readonly status: RuntimeHookStatus; readonly ranHook: boolean }
  | { readonly kind: "backgrounded" }
  | { readonly kind: "aborted" };

/**
 * Runs `.agents/setup` once per compute incarnation and `.agents/resume` on
 * every start (`docs/orb-setup-hook.md`). A hook failure is recorded and
 * surfaced but never fails the boot: a broken script must not make an orb
 * unreachable, since the agent is the tool that fixes it.
 */
export class BootHookRunner {
  private readonly options: BootHookRunnerOptions;
  private readonly files: HookFileStore;
  private readonly statuses = new Map<HookName, RuntimeHookStatus>();
  /** Whichever hook process is alive right now; terminated with the orb. */
  private inFlight: HookProcess | null = null;
  /** Set by `shutdown`, so a killed hook is never mistaken for a failed one. */
  private shuttingDown = false;
  /**
   * The still-unfinished verdict of a backgrounded resume. Boot deliberately
   * does not wait for it — that is what "backgrounded" means — but it is a
   * native-promise continuation that writes files, so it needs a handle a
   * simulated owner can await until it has settled (docs/testing.md).
   */
  private lateVerdict: Promise<void> = Promise.resolve();
  /** What the hooks' env file turned into, once it has been merged. */
  private envApplied: HookEnvReport | null = null;
  /** Dashboard-managed project-secret names a hook must not shadow. */
  private readonly managedEnvironmentNames = new Set<string>();

  constructor(options: BootHookRunnerOptions) {
    this.options = options;
    this.files = options.files ?? new NodeHookFileStore();
    for (const hook of ["setup", "resume"] as const) {
      const persisted = this.readStatus(hook);
      // The status files live in the persistent home and therefore outlive the
      // compute they describe. A verdict from a previous incarnation says
      // nothing about this one — and reporting it would put a failure banner
      // on an orb whose hooks are fine, or gone.
      if (persisted !== null && persisted.incarnation === options.incarnation) {
        this.statuses.set(hook, persisted);
      } else if (persisted !== null) {
        this.clearStatus(hook);
      }
    }
  }

  /** Protect dashboard-managed names before resume and the env-file merge. */
  addManagedEnvironmentNames(names: Iterable<string>): void {
    for (const name of names) this.managedEnvironmentNames.add(name);
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
      // not re-scan for a hook the agent added after boot. Any verdict on
      // disk describes a hook this checkout no longer has.
      this.clearStatus("setup");
      await this.stampIncarnation();
      return null;
    }
    this.options.onSetupStart?.();
    const outcome = await this.run("setup", discovery, SETUP_DEADLINE_MS, "kill");
    // The once-per-incarnation budget is spent only by a run that reached a
    // verdict about the hook itself. A missing execute bit is a user error
    // they will fix in place; a spawn or log-directory failure means the hook
    // never ran at all; a shutdown killed it mid-flight. Stamping any of those
    // would deny this compute its single setup forever.
    if (outcome.kind === "settled" && outcome.ranHook) await this.stampIncarnation();
    return outcome.kind === "settled" ? outcome.status : null;
  }

  /**
   * Runs resume, waiting at most the blocking window. A hook still running
   * then continues in the background with its output still captured; its
   * status is recorded when it eventually exits.
   */
  async runResume(): Promise<RuntimeHookStatus | null> {
    const discovery = discoverHook(this.options.repoDir, "resume");
    if (discovery.kind === "absent") {
      this.clearStatus("resume");
      return null;
    }
    // The previous start of this same incarnation left its own verdict on
    // disk. It describes that boot, not this one, and if this run outlives its
    // blocking window nothing would replace it — "not known yet" is the only
    // honest answer while the hook is in flight.
    this.clearStatus("resume");
    const outcome = await this.run("resume", discovery, RESUME_BLOCKING_WINDOW_MS, "background");
    return outcome.kind === "settled" ? outcome.status : null;
  }

  /**
   * Merges what the hooks wrote to `$HOME/.pi-orb/env` into `target` — the
   * runtime's own environment, which is what Pi's `bash -c` tool shells and
   * the terminal's PTYs inherit. It is the only way a hook can hand the agent
   * a variable: neither shell reads a profile (`docs/orb-setup-hook.md`).
   *
   * Call it once, after resume's blocking window and before the agent session
   * exists. A resume that finishes in the background afterwards can still
   * write the file; it takes effect on the next start.
   *
   * Returns null when no hook wrote one. A file the runtime cannot make sense
   * of is reported, never fatal: the orb still starts, exactly as a failed
   * hook does.
   */
  async applyHookEnv(target: Record<string, string | undefined>): Promise<HookEnvReport | null> {
    const path = hookEnvPath(this.options.home);
    const raw = this.files.readText(path);
    if (raw === null) return null;
    // The hook's umask decided the mode; the runtime owns it from here.
    this.files.hardenFile(path);
    const parsed = parseHookEnvFile(raw, this.managedEnvironmentNames);
    const applied: string[] = [];
    for (const [name, value] of parsed.entries) {
      target[name] = value;
      applied.push(name);
    }
    for (const name of parsed.ignored) {
      this.options.log?.(`hook env: ignored ${name}: the runtime owns it`);
    }
    for (const reason of parsed.malformed) {
      this.options.log?.(`hook env: ${reason} (${path})`);
    }
    const report: HookEnvReport = {
      path,
      applied,
      ignored: parsed.ignored,
      malformed: parsed.malformed,
    };
    this.envApplied = report;
    await this.writeEnvStatus(report);
    return report;
  }

  /**
   * The env file as it stands now, parsed and deny-listed exactly as the boot
   * merge parses it, but recorded nowhere: a terminal opened later merges this
   * so a variable written after the boot merge reaches the new shell, and a
   * second `env.status.json` for the same file would only contradict the first.
   */
  hookEnv(): ReadonlyMap<string, string> | null {
    const raw = this.files.readText(hookEnvPath(this.options.home));
    if (raw === null) return null;
    return parseHookEnvFile(raw, this.managedEnvironmentNames).entries;
  }

  /** What `applyHookEnv` did, for the agent's prompt fragment. Null before it ran. */
  envReport(): HookEnvReport | null {
    return this.envApplied;
  }

  /**
   * Terminates a hook still running when the orb stops — a resume past its
   * blocking window, or a setup a shutdown interrupted. Nothing a hook started
   * outlives the orb, and nothing the kill causes is recorded as the hook's
   * own verdict: the orb was stopped, the script did not fail.
   */
  shutdown(): void {
    this.shuttingDown = true;
    this.inFlight?.killGroup();
    this.inFlight = null;
  }

  /**
   * Settles once a backgrounded resume has recorded whatever it ended up
   * doing. Nothing in the boot path waits for this; it exists so a simulated
   * owner can (docs/testing.md).
   */
  async whenLateVerdictSettled(): Promise<void> {
    await this.lateVerdict;
  }

  private async run(
    hook: HookName,
    discovery: Exclude<HookDiscovery, { kind: "absent" }>,
    deadlineMs: number,
    onDeadline: "kill" | "background",
  ): Promise<HookRunOutcome> {
    const startedAt = this.options.task.wallNow();
    const logPath = this.logPath(hook);
    const settled = async (partial: HookRunRecord, ranHook: boolean): Promise<HookRunOutcome> => ({
      kind: "settled",
      status: await this.record(hook, partial),
      ranHook,
    });

    if (discovery.kind !== "executable") {
      return settled(
        {
          outcome: "hook_not_executable",
          exitCode: null,
          startedAt,
          endedAt: startedAt,
          logPath,
          tail: [`${discovery.path} is present but not executable (chmod +x it)`],
        },
        false,
      );
    }

    const prepared = this.files.ensureDir(this.logDir());
    if (prepared.isErr()) {
      return settled(
        {
          outcome: "failed",
          exitCode: null,
          startedAt,
          endedAt: this.options.task.wallNow(),
          logPath,
          tail: [`could not prepare the hook log directory: ${prepared.error.message}`],
        },
        false,
      );
    }

    // So a hook can simply append to `$PI_ORB_HOOK_ENV_FILE`. Failing to make
    // the directory is not a reason to refuse to run the hook: it may not want
    // to hand the agent anything at all.
    const envDir = this.files.ensureDir(dirname(hookEnvPath(this.options.home)));
    if (envDir.isErr()) {
      this.options.log?.(`hook ${hook}: env directory unavailable: ${envDir.error.message}`);
    }

    const spawned = this.options.spawner.spawn({
      executable: discovery.path,
      cwd: this.options.repoDir,
      env: hookEnvironment(this.options.environment, hook, hookEnvPath(this.options.home)),
      logPath,
      onLine: (line) => this.options.log?.(`hook ${hook}: ${line}`),
    });
    if (spawned.isErr()) {
      return settled(
        {
          outcome: "failed",
          exitCode: null,
          startedAt,
          endedAt: this.options.task.wallNow(),
          logPath,
          tail: [spawned.error.message],
        },
        false,
      );
    }
    const process = spawned.value;
    this.inFlight = process;
    void process.exited.then(() => {
      if (this.inFlight === process) this.inFlight = null;
    });

    const deadline = this.options.task.createDeadline(deadlineMs, `${hook} hook deadline`);
    const expired = new Promise<"expired">((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve("expired"), { once: true });
    });
    const raced = await Promise.race([
      process.exited.then((exit) => ({ kind: "exited" as const, exit })),
      expired.then(() => ({ kind: "expired" as const })),
    ]);
    deadline.cancel();
    // A shutdown is what ended this process, not the script.
    if (this.shuttingDown) return { kind: "aborted" };

    if (raced.kind === "expired") {
      if (onDeadline === "background") {
        // The agent proceeds; the hook keeps running with its output captured
        // and records its own outcome when it exits (docs/orb-setup-hook.md).
        await this.options.task.checkpoint("boot-hooks.resume-window-expired");
        this.lateVerdict = process.exited.then(async (exit) => {
          if (this.shuttingDown) return;
          await this.record(hook, {
            outcome: exit.code === 0 ? "ok" : "failed",
            exitCode: exit.code,
            startedAt,
            endedAt: this.options.task.wallNow(),
            logPath,
            tail: process.tail(),
          });
        });
        return { kind: "backgrounded" };
      }
      await this.options.task.checkpoint("boot-hooks.setup-deadline-kill");
      process.killGroup();
      return settled(
        {
          outcome: "timeout",
          exitCode: null,
          startedAt,
          endedAt: this.options.task.wallNow(),
          logPath,
          tail: process.tail(),
        },
        true,
      );
    }

    return settled(
      {
        outcome: raced.exit.code === 0 ? "ok" : "failed",
        exitCode: raced.exit.code,
        startedAt,
        endedAt: this.options.task.wallNow(),
        logPath,
        tail: process.tail(),
      },
      true,
    );
  }

  private async record(hook: HookName, partial: HookRunRecord): Promise<RuntimeHookStatus> {
    const status: RuntimeHookStatus = {
      hook,
      outcome: partial.outcome,
      exitCode: partial.exitCode,
      incarnation: this.options.incarnation,
      startedAt: new Date(partial.startedAt).toISOString(),
      endedAt: new Date(partial.endedAt).toISOString(),
      logPath: partial.logPath,
    };
    // In memory first: the health report is what the user and the control
    // plane read, and it must carry the verdict even when the disk refuses it.
    this.statuses.set(hook, status);
    await this.writeStatus(status, partial.tail.slice(-STATUS_TAIL_LINES));
    if (status.outcome !== "ok") {
      this.options.log?.(
        `hook ${hook}: ${status.outcome} exit_code=${status.exitCode ?? "none"} log=${status.logPath}`,
      );
    }
    return status;
  }

  private logDir(): string {
    return hookLogDir(this.options.home);
  }

  private logPath(hook: HookName): string {
    return hookLogPath(this.options.home, hook);
  }

  private statusPath(hook: HookName): string {
    return hookStatusPath(this.options.home, hook);
  }

  /**
   * Written beside the log so the outcome survives the runtime process and can
   * be read from an orb shell without the control plane.
   */
  private async writeStatus(status: RuntimeHookStatus, tail: readonly string[]): Promise<void> {
    await this.options.task.checkpoint("boot-hooks.status-before-write");
    const written = await this.files.writeText(
      this.options.task,
      this.statusPath(status.hook),
      `${JSON.stringify({ ...status, tail }, null, 2)}\n`,
    );
    if (written.isErr()) {
      this.options.log?.(`hook ${status.hook}: status write failed: ${written.error.message}`);
    }
    await this.options.task.checkpoint("boot-hooks.status-written");
  }

  /**
   * Written beside the hooks' own verdicts so "which variables did the agent
   * actually get?" is answerable from inside the orb. Names only, never
   * values: a hook's variable may itself be a credential.
   */
  private async writeEnvStatus(report: HookEnvReport): Promise<void> {
    await this.options.task.checkpoint("boot-hooks.status-before-write");
    const written = await this.files.writeText(
      this.options.task,
      hookEnvStatusPath(this.options.home),
      `${JSON.stringify({ ...report, incarnation: this.options.incarnation }, null, 2)}\n`,
    );
    if (written.isErr()) {
      this.options.log?.(`hook env: status write failed: ${written.error.message}`);
    }
    await this.options.task.checkpoint("boot-hooks.status-written");
  }

  /** Retire a verdict that no longer describes anything this boot could run. */
  private clearStatus(hook: HookName): void {
    this.statuses.delete(hook);
    this.files.remove(this.statusPath(hook));
  }

  private readStatus(hook: HookName): RuntimeHookStatus | null {
    const raw = this.files.readText(this.statusPath(hook));
    if (raw === null) return null;
    return Result.fromThrowable(
      () => JSON.parse(raw) as unknown,
      () => undefined,
    )()
      .map((parsed) => asHookStatus(parsed, hook))
      .unwrapOr(null);
  }

  private stampPath(): string {
    return hookStampPath(this.options.workDir);
  }

  /**
   * The durable "setup has run for this incarnation" marker. It lives in the
   * workspace, which survives the container layer, so a runtime restart does
   * not re-run a twenty-minute hook while a new incarnation always does.
   */
  private stampedIncarnation(): string | null {
    return this.files.readText(this.stampPath())?.trim() ?? null;
  }

  /**
   * A stamp that never lands costs this incarnation a re-run of an idempotent
   * hook on the next runtime start, which is the safe direction: the opposite
   * — claiming a setup that did not happen — is not recoverable.
   */
  private async stampIncarnation(): Promise<void> {
    await this.options.task.checkpoint("boot-hooks.stamp-before-write");
    const written = await this.files.writeText(
      this.options.task,
      this.stampPath(),
      `${this.options.incarnation}\n`,
    );
    if (written.isErr()) {
      this.options.log?.(`hook setup: stamp write failed: ${written.error.message}`);
    }
    await this.options.task.checkpoint("boot-hooks.stamp-written");
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
