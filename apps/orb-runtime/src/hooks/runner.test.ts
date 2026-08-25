import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeHookStatus } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { afterEach, describe, expect, it } from "vitest";
import { FakeHookSpawner } from "../testkit/hooks.ts";
import { runDst } from "../testkit/sim.ts";
import {
  BootHookRunner,
  discoverHook,
  hookEnvironment,
  RESUME_BLOCKING_WINDOW_MS,
  SETUP_DEADLINE_MS,
} from "./runner.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Orb {
  readonly workDir: string;
  readonly repoDir: string;
  readonly home: string;
}

function makeOrb(): Orb {
  const workDir = mkdtempSync(join(tmpdir(), "pi-orb-hooks-"));
  roots.push(workDir);
  const repoDir = join(workDir, "repo");
  const home = join(workDir, "home");
  mkdirSync(join(repoDir, ".agents"), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { workDir, repoDir, home };
}

function writeHook(orb: Orb, name: string, executable = true): string {
  const path = join(orb.repoDir, ".agents", name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

function makeRunner(
  orb: Orb,
  spawner: FakeHookSpawner,
  task: SimulationTask,
  overrides: { incarnation?: string; environment?: Record<string, string> } = {},
): BootHookRunner {
  return new BootHookRunner({
    repoDir: orb.repoDir,
    home: orb.home,
    workDir: orb.workDir,
    incarnation: overrides.incarnation ?? "0",
    task,
    spawner,
    environment: overrides.environment ?? { PATH: "/usr/bin", PI_ORB_ID: "orb-a" },
  });
}

const readStatusFile = (orb: Orb, hook: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(orb.home, ".cache", "pi-orb", "logs", `${hook}.status.json`), "utf8"),
  );

describe("boot hook environment", () => {
  it("removes identity from setup and keeps it for resume", () => {
    const base = {
      PATH: "/usr/bin",
      PI_ORB_RUNTIME_TOKEN: "secret",
      PI_ORB_CONTROL_PLANE_URL: "http://cp",
      PI_ORB_HOST_INCARNATION: "3",
    };
    const setup = hookEnvironment(base, "setup");
    expect(setup["PI_ORB_RUNTIME_TOKEN"]).toBeUndefined();
    expect(setup["PI_ORB_CONTROL_PLANE_URL"]).toBeUndefined();
    expect(setup["PI_ORB_HOST_INCARNATION"]).toBe("3");
    expect(setup["PI_ORB"]).toBe("1");
    expect(setup["PI_ORB_HOOK"]).toBe("setup");

    const resume = hookEnvironment(base, "resume");
    expect(resume["PI_ORB_RUNTIME_TOKEN"]).toBe("secret");
    expect(resume["PI_ORB_CONTROL_PLANE_URL"]).toBe("http://cp");
    expect(resume["PI_ORB_HOOK"]).toBe("resume");
  });

  it("never hands Tailscale material to either hook", () => {
    const base = {
      PI_ORB_TAILSCALE_AUTH_KEY: "tskey-secret",
      PI_ORB_TAILSCALE_HOSTNAME: "pi-orb-a",
      PI_ORB_PREVIEW_HOST: "pi-orb-a.tail.ts.net",
    };
    for (const hook of ["setup", "resume"] as const) {
      const env = hookEnvironment(base, hook);
      expect(env["PI_ORB_TAILSCALE_AUTH_KEY"]).toBeUndefined();
      expect(env["PI_ORB_TAILSCALE_HOSTNAME"]).toBeUndefined();
      expect(env["PI_ORB_PREVIEW_HOST"]).toBeUndefined();
    }
  });

  it("never sets AMP_ORB", () => {
    expect(hookEnvironment({}, "setup")["AMP_ORB"]).toBeUndefined();
  });
});

describe("boot hook discovery", () => {
  it("distinguishes absent, executable, and present-but-not-executable", () => {
    const orb = makeOrb();
    expect(discoverHook(orb.repoDir, "setup").kind).toBe("absent");
    writeHook(orb, "setup", false);
    expect(discoverHook(orb.repoDir, "setup").kind).toBe("not_executable");
    chmodSync(join(orb.repoDir, ".agents", "setup"), 0o755);
    expect(discoverHook(orb.repoDir, "setup").kind).toBe("executable");
  });
});

describe("boot hook runner", () => {
  const task = new NoSimulationTask("hook-test", false);

  it("does nothing when neither hook exists", async () => {
    const orb = makeOrb();
    const spawner = new FakeHookSpawner();
    const runner = makeRunner(orb, spawner, task);
    expect(await runner.runSetup()).toBeNull();
    expect(await runner.runResume()).toBeNull();
    expect(spawner.runs).toHaveLength(0);
    expect(runner.report()).toEqual({});
  });

  it("reports a present but non-executable hook instead of skipping it", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup", false);
    const spawner = new FakeHookSpawner();
    const runner = makeRunner(orb, spawner, task);
    const status = await runner.runSetup();
    expect(status?.outcome).toBe("hook_not_executable");
    expect(spawner.runs).toHaveLength(0);
    expect(readStatusFile(orb, "setup")["outcome"]).toBe("hook_not_executable");
  });

  it("runs setup with the scrubbed environment and the repository root as cwd", async () => {
    const orb = makeOrb();
    const path = writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    const runner = makeRunner(orb, spawner, task, {
      environment: { PATH: "/usr/bin", PI_ORB_RUNTIME_TOKEN: "secret" },
    });
    const running = runner.runSetup();
    const run = spawner.runOf("setup");
    expect(run.request.executable).toBe(path);
    expect(run.request.cwd).toBe(orb.repoDir);
    expect(run.request.env["PI_ORB_RUNTIME_TOKEN"]).toBeUndefined();
    expect(run.request.logPath).toBe(join(orb.home, ".cache", "pi-orb", "logs", "setup.log"));
    run.emit("installing");
    run.exit(0);
    expect((await running)?.outcome).toBe("ok");
  });

  it("records a non-zero exit with its code and the captured tail", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    const runner = makeRunner(orb, spawner, task, { incarnation: "7" });
    const running = runner.runSetup();
    const run = spawner.runOf("setup");
    run.emit("apt-get: not found");
    run.exit(127);
    const status = await running;
    expect(status).toMatchObject({
      hook: "setup",
      outcome: "failed",
      exitCode: 127,
      incarnation: "7",
    });
    const persisted = readStatusFile(orb, "setup");
    expect(persisted["tail"]).toEqual(["apt-get: not found"]);
    expect(persisted["incarnation"]).toBe("7");
  });

  it("mirrors hook output to the runtime's log stream", async () => {
    const orb = makeOrb();
    writeHook(orb, "resume");
    const spawner = new FakeHookSpawner();
    const logged: string[] = [];
    const runner = new BootHookRunner({
      repoDir: orb.repoDir,
      home: orb.home,
      workDir: orb.workDir,
      incarnation: "0",
      task,
      spawner,
      environment: {},
      log: (line) => logged.push(line),
    });
    const running = runner.runResume();
    const run = spawner.runOf("resume");
    run.emit("authenticating");
    run.exit(0);
    await running;
    expect(logged).toContain("hook resume: authenticating");
  });

  it("reports a spawn failure rather than crashing the boot", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    spawner.spawnError = "EACCES";
    const runner = makeRunner(orb, spawner, task);
    expect((await runner.runSetup())?.outcome).toBe("failed");
  });

  it("runs setup once per incarnation and resume on every start", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    writeHook(orb, "resume");
    const spawner = new FakeHookSpawner();

    // Each leg drives whatever the runner actually spawned to a clean exit.
    const boot = async (incarnation: string): Promise<void> => {
      const runner = makeRunner(orb, spawner, task, { incarnation });
      const setup = runner.runSetup();
      spawner.runs.at(-1)?.exit(0);
      await setup;
      const resume = runner.runResume();
      spawner.runs.at(-1)?.exit(0);
      await resume;
    };

    await boot("0");
    // Same incarnation, second boot: resume runs again, setup does not.
    await boot("0");
    const counts = (hook: string): number =>
      spawner.runs.filter((run) => run.request.env["PI_ORB_HOOK"] === hook).length;
    expect(counts("setup")).toBe(1);
    expect(counts("resume")).toBe(2);

    // Compute replacement: the new incarnation runs setup again.
    await boot("1");
    expect(counts("setup")).toBe(2);
    expect(counts("resume")).toBe(3);
  });

  it("carries the last outcome across a runtime restart within an incarnation", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    const first = makeRunner(orb, spawner, task);
    const running = first.runSetup();
    spawner.runOf("setup").exit(3);
    await running;

    const second = makeRunner(orb, spawner, task);
    expect(await second.runSetup()).toBeNull();
    expect(second.report().setup).toMatchObject({ outcome: "failed", exitCode: 3 });
  });
});

describe("boot hook deadlines", () => {
  it("kills setup's process group at its deadline and continues the boot", async () => {
    await runDst({ name: "setup-hook-timeout", iterations: 5 }, async (sim) => {
      const orb = makeOrb();
      writeHook(orb, "setup");
      const spawner = new FakeHookSpawner();
      let status: RuntimeHookStatus | null = null;
      const result = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            const runner = makeRunner(orb, spawner, task);
            status = await runner.runSetup();
          },
        },
        {
          name: "clock",
          f: async (task) => {
            // The hook never exits; only the deadline can end it.
            await task.sleep(SETUP_DEADLINE_MS * 2, "outlast the setup deadline");
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(spawner.runOf("setup").killed).toBe(true);
      expect(status).toMatchObject({ outcome: "timeout", exitCode: null });
    });
  });

  it("stops blocking on resume after its window and records the late outcome", async () => {
    await runDst({ name: "resume-hook-background", iterations: 5 }, async (sim) => {
      const orb = makeOrb();
      writeHook(orb, "resume");
      const spawner = new FakeHookSpawner();
      const runners: BootHookRunner[] = [];
      let unblockedAt = -1;
      const result = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            const runner = makeRunner(orb, spawner, task);
            runners.push(runner);
            const status = await runner.runResume();
            unblockedAt = task.monotonicNow();
            // The agent proceeds with no outcome yet: the hook is still running.
            expect(status).toBeNull();
          },
        },
        {
          name: "slow hook",
          f: async (task) => {
            await task.sleep(RESUME_BLOCKING_WINDOW_MS * 3, "resume outlasts its window");
            spawner.runOf("resume").exit(1);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(unblockedAt).toBeGreaterThanOrEqual(RESUME_BLOCKING_WINDOW_MS);
      expect(unblockedAt).toBeLessThan(RESUME_BLOCKING_WINDOW_MS * 3);
      expect(spawner.runOf("resume").killed).toBe(false);
      expect(runners[0]?.report().resume).toMatchObject({ outcome: "failed", exitCode: 1 });
    });
  });

  it("terminates a backgrounded resume on shutdown", async () => {
    await runDst({ name: "resume-hook-shutdown", iterations: 5 }, async (sim) => {
      const orb = makeOrb();
      writeHook(orb, "resume");
      const spawner = new FakeHookSpawner();
      const result = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            const runner = makeRunner(orb, spawner, task);
            await runner.runResume();
            runner.shutdown();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(spawner.runOf("resume").killed).toBe(true);
    });
  });
});
