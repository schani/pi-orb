import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { type ExecutionReady, type RuntimeHealth, validateRepositoryUrl } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { configurePersistentHome } from "../domain/home.ts";
import { configurePersistentRust } from "../domain/rust.ts";
import { applyGitIdentity } from "../git-identity/apply.ts";
import { BootHookRunner } from "../hooks/runner.ts";
import { NodeHookSpawner } from "../hooks/spawner.ts";
import { initialCheckoutCommands } from "../initial-checkout.ts";
import { fetchOwnerSkills } from "../owner-skills/endpoint.ts";
import { materializeOwnerSkills } from "../owner-skills/materialize.ts";
import { awaitInitialCheckoutCommit } from "../pending-initial-checkout.ts";
import { fetchProjectSecretSnapshotAtBoot } from "../project-secrets/endpoint.ts";
import { checkTestLaunchFailure } from "../test-launch-failure.ts";

interface BootError {
  readonly type: "execution_boot_error";
  readonly code: string;
  readonly message: string;
}
interface BootOptions {
  readonly orbId: string;
  readonly workDir: string;
  readonly repositoryUrl: string | null;
  readonly incarnation: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly broker: BrokerEnv | null;
}
const git = (args: string[], cwd: string) =>
  ResultAsync.fromPromise(
    promisify(execFile)("git", args, { cwd }),
    (): BootError => ({
      type: "execution_boot_error",
      code: "clone_failed",
      message: "git checkout failed",
    }),
  ).map((result) => result.stdout.trim());

export class ExecutionBoot {
  snapshot: ExecutionReady | null = null;
  private hooks: BootHookRunner | null = null;
  private readonly runtimeInstanceId = randomUUID();
  private readonly bootAbort = new AbortController();
  private phase: "booting" | "cloning" | "setup_running" | "checking_project_secrets" = "booting";
  private error: BootError | null = null;
  private readonly options: BootOptions;
  constructor(options: BootOptions) {
    this.options = options;
  }
  health(): RuntimeHealth {
    const base = {
      v: 1 as const,
      orbId: this.options.orbId,
      runtimeInstanceId: this.runtimeInstanceId,
    };
    if (this.error)
      return {
        ...base,
        status: "failed",
        error: { code: this.error.code, message: this.error.message, retryable: true },
      };
    if (this.snapshot)
      return {
        ...base,
        status: "ready",
        sessionId: `execution-${this.options.orbId}`,
        checkoutCommit: this.snapshot.checkoutCommit,
        activity: "idle",
        hooks: this.hooks?.report() ?? {},
      };
    return {
      ...base,
      status: "initializing",
      phase: this.phase,
      hooks: this.hooks?.report() ?? {},
    };
  }
  async boot(): Promise<Result<void, BootError>> {
    const result = await this.steps();
    if (result.isErr()) this.error = result.error;
    return result;
  }
  shutdown(): void {
    this.bootAbort.abort();
    this.hooks?.shutdown();
  }
  private async steps(): Promise<Result<void, BootError>> {
    const o = this.options;
    const launchFailure = checkTestLaunchFailure(o.environment, o.workDir);
    if (launchFailure.error !== undefined) console.error(launchFailure.error);
    if (launchFailure.inject)
      return err({
        type: "execution_boot_error",
        code: "e2e_launch_failure",
        message: "test launch failure injected",
      });
    const home = configurePersistentHome(o.workDir, o.environment);
    if (home.isErr())
      return err({
        type: "execution_boot_error",
        code: "home_init_failed",
        message: home.error.message,
      });
    configurePersistentRust(home.value, o.environment);
    const cwd = join(o.workDir, "repo");
    this.phase = "cloning";
    if (o.repositoryUrl === null) {
      const workspace = Result.fromThrowable(
        () => mkdirSync(cwd, { recursive: true }),
        (): BootError => ({
          type: "execution_boot_error",
          code: "workspace_init_failed",
          message: "workspace preparation failed",
        }),
      )();
      if (workspace.isErr()) return err(workspace.error);
    } else if (!existsSync(cwd)) {
      const url = validateRepositoryUrl(o.repositoryUrl);
      if (url.isErr())
        return err({
          type: "execution_boot_error",
          code: "invalid_repository_url",
          message: url.error.message,
        });
      const temp = join(o.workDir, ".clone-tmp");
      const prepare = Result.fromThrowable(
        () => {
          rmSync(temp, { recursive: true, force: true });
          mkdirSync(o.workDir, { recursive: true });
        },
        (): BootError => ({
          type: "execution_boot_error",
          code: "clone_failed",
          message: "checkout preparation failed",
        }),
      )();
      if (prepare.isErr()) return prepare;
      const initial = await awaitInitialCheckoutCommit(o.environment, o.broker, o.incarnation, {
        signal: this.bootAbort.signal,
      });
      if (initial.isErr())
        return err({
          type: "execution_boot_error",
          code: initial.error.code,
          message: initial.error.message,
        });
      const cloned = await git(["clone", "--", url.value.url, temp], o.workDir);
      if (cloned.isErr()) return err(cloned.error);
      const pin = initialCheckoutCommands(initial.value);
      if (pin.isErr())
        return err({
          type: "execution_boot_error",
          code: "invalid_initial_commit",
          message: pin.error.message,
        });
      for (const command of pin.value) {
        const pinned = await git(command, temp);
        if (pinned.isErr()) return err(pinned.error);
      }
      const moved = Result.fromThrowable(
        () => renameSync(temp, cwd),
        (): BootError => ({
          type: "execution_boot_error",
          code: "clone_failed",
          message: "checkout installation failed",
        }),
      )();
      if (moved.isErr()) return moved;
    }
    const commit =
      o.repositoryUrl === null || !existsSync(join(cwd, ".git"))
        ? ok(null)
        : await git(["rev-parse", "HEAD"], cwd);
    if (commit.isErr()) return err(commit.error);
    this.hooks = new BootHookRunner({
      repoDir: cwd,
      home: home.value,
      workDir: o.workDir,
      incarnation: o.incarnation,
      task: new NoSimulationTask(`execution-hooks-${o.orbId}`, false),
      spawner: new NodeHookSpawner(),
      environment: o.environment,
      onSetupStart: () => {
        this.phase = "setup_running";
      },
    });
    await this.hooks.runSetup();
    this.phase = "checking_project_secrets";
    if (o.broker) {
      const secrets = await fetchProjectSecretSnapshotAtBoot(o.broker);
      if (secrets.isErr())
        return err({
          type: "execution_boot_error",
          code: "project_secrets_unavailable",
          message: secrets.error.message,
        });
      this.hooks.addManagedEnvironmentNames(Object.keys(secrets.value.values));
      Object.assign(o.environment, secrets.value.values);
      const identity = await applyGitIdentity(o.broker, home.value, o.environment);
      if (identity.isErr())
        return err({
          type: "execution_boot_error",
          code: "git_identity_unavailable",
          message: identity.error.message,
        });
    }
    await this.hooks.runResume();
    await this.hooks.applyHookEnv(o.environment);
    if (o.broker) {
      const fetched = await fetchOwnerSkills(o.broker);
      if (this.bootAbort.signal.aborted)
        return err({
          type: "execution_boot_error",
          code: "boot_cancelled",
          message: "execution boot cancelled",
        });
      const skills = fetched.andThen((snapshot) =>
        materializeOwnerSkills(join(o.workDir, "owner-skills"), snapshot.skills),
      );
      if (skills.isErr())
        return err({
          type: "execution_boot_error",
          code: "owner_skills_unavailable",
          message: skills.error.message,
        });
    }
    this.snapshot = {
      cwd,
      incarnation: o.incarnation,
      pid: process.pid,
      checkoutCommit: commit.value,
      hooks: this.hooks.report(),
    };
    return ok(undefined);
  }
}
