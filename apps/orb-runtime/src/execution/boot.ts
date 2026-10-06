import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  type ExecutionReady,
  type ExecutionResource,
  type RuntimeHealth,
  validateRepositoryUrl,
} from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { err, ok, Result, ResultAsync } from "neverthrow";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { configurePersistentHome } from "../domain/home.ts";
import { configurePersistentRust } from "../domain/rust.ts";
import { BootHookRunner } from "../hooks/runner.ts";
import { NodeHookSpawner } from "../hooks/spawner.ts";
import { initialCheckoutCommands } from "../initial-checkout.ts";
import { awaitInitialCheckoutCommit } from "../pending-initial-checkout.ts";
import { fetchProjectSecretSnapshotAtBoot } from "../project-secrets/endpoint.ts";
import { repositoryResources } from "../repository-resources.ts";
import { checkTestLaunchFailure } from "../test-launch-failure.ts";
import { executionContext } from "./server.ts";

interface BootError {
  readonly type: "execution_boot_error";
  readonly code: string;
  readonly message: string;
}
interface BootOptions {
  readonly orbId: string;
  readonly workDir: string;
  readonly repositoryUrl: string;
  readonly incarnation: string;
  readonly skillsDir: string;
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
    if (!existsSync(cwd)) {
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
    const commit = await git(["rev-parse", "HEAD"], cwd);
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
    }
    await this.hooks.runResume();
    await this.hooks.applyHookEnv(o.environment);
    const env = new NodeExecutionEnv({ cwd });
    const instructions: ExecutionResource[] = [];
    const repository = repositoryResources(cwd);
    if (repository.isErr())
      return err({
        type: "execution_boot_error",
        code: "resource_discovery_failed",
        message: repository.error,
      });
    instructions.push(...repository.value.instructions);
    const skills: ExecutionResource[] = [];
    for (const path of repository.value.skills) {
      const resource = await this.resource(env, path);
      if (!resource)
        return err({
          type: "execution_boot_error",
          code: "resource_discovery_failed",
          message: "repository skill could not be read",
        });
      skills.push(resource);
    }
    for (const root of [o.skillsDir]) {
      const paths = Result.fromThrowable(
        () => this.skillPaths(root, 0),
        () => [] as string[],
      )();
      if (paths.isOk())
        for (const path of paths.value.slice(0, 128)) {
          const resource = await this.resource(env, path);
          if (resource) skills.push(resource);
        }
    }
    this.snapshot = {
      cwd,
      incarnation: o.incarnation,
      pid: process.pid,
      checkoutCommit: commit.value,
      hooks: this.hooks.report(),
      instructions,
      skills,
      resources: [...instructions, ...skills],
    };
    return ok(undefined);
  }
  private skillPaths(root: string, depth: number): string[] {
    if (depth > 4 || !existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? this.skillPaths(join(root, entry.name), depth + 1)
        : entry.isFile() && entry.name === "SKILL.md"
          ? [join(root, entry.name)]
          : [],
    );
  }
  private async resource(env: NodeExecutionEnv, path: string): Promise<ExecutionResource | null> {
    const info = await env.fileInfo(path, executionContext());
    if (!info.ok || info.value.size > 256 * 1024 || info.value.kind !== "file") return null;
    const result = await env.readTextFile(path, executionContext());
    return result.ok ? { path, content: result.value } : null;
  }
}
