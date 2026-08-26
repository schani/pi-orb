import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeHookStatus } from "@pi-orb/protocol";
import { NoSimulationTask, type SimulationTask } from "determined";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_FAILPOINTS } from "../testkit/failpoints.ts";
import { FakeHookFileStore, FakeHookSpawner } from "../testkit/hooks.ts";
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
  overrides: {
    incarnation?: string;
    environment?: Record<string, string>;
    files?: FakeHookFileStore;
  } = {},
): BootHookRunner {
  return new BootHookRunner({
    repoDir: orb.repoDir,
    home: orb.home,
    workDir: orb.workDir,
    incarnation: overrides.incarnation ?? "0",
    task,
    spawner,
    ...(overrides.files !== undefined ? { files: overrides.files } : {}),
    environment: overrides.environment ?? { PATH: "/usr/bin", PI_ORB_ID: "orb-a" },
  });
}

const statusPath = (orb: Orb, hook: string): string =>
  join(orb.home, ".cache", "pi-orb", "logs", `${hook}.status.json`);

const stampPath = (orb: Orb): string => join(orb.workDir, ".pi-orb", "setup-incarnation");

const readStatusFile = (orb: Orb, hook: string): Record<string, unknown> =>
  JSON.parse(readFileSync(statusPath(orb, hook), "utf8"));

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

  it("does not spend the incarnation's setup on a failure that never ran the hook", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    spawner.spawnError = "EAGAIN";
    const blocked = makeRunner(orb, spawner, task);
    expect((await blocked.runSetup())?.outcome).toBe("failed");

    // The next runtime start of the same incarnation must try again: nothing
    // about the hook itself was learned.
    const retried = makeRunner(orb, spawner, task);
    const running = retried.runSetup();
    spawner.runOf("setup").exit(0);
    expect((await running)?.outcome).toBe("ok");
  });

  it("re-checks a hook whose execute bit the user is about to fix", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup", false);
    const spawner = new FakeHookSpawner();
    expect((await makeRunner(orb, spawner, task).runSetup())?.outcome).toBe("hook_not_executable");
    chmodSync(join(orb.repoDir, ".agents", "setup"), 0o755);

    const fixed = makeRunner(orb, spawner, task);
    const running = fixed.runSetup();
    spawner.runOf("setup").exit(0);
    expect((await running)?.outcome).toBe("ok");
  });

  it("records nothing when a shutdown kills setup, and leaves the incarnation unstamped", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    const runner = makeRunner(orb, spawner, task);
    // The spawn happens before `runSetup` first awaits, so the stop below is
    // ordered after it without racing the hook's own 20-minute deadline.
    const running = runner.runSetup();
    expect(spawner.runs).toHaveLength(1);
    runner.shutdown();

    expect(await running).toBeNull();
    expect(spawner.runOf("setup").killed).toBe(true);
    // Stopping an orb is not a hook failure, and it must not consume the one
    // setup this compute gets.
    expect(runner.report()).toEqual({});
    expect(existsSync(join(orb.workDir, ".pi-orb", "setup-incarnation"))).toBe(false);
  });

  it("never reports a verdict from a previous incarnation", async () => {
    const orb = makeOrb();
    writeHook(orb, "setup");
    const spawner = new FakeHookSpawner();
    const first = makeRunner(orb, spawner, task, { incarnation: "0" });
    const running = first.runSetup();
    spawner.runOf("setup").exit(1);
    await running;

    // The status file lives in the persistent home and survives replacement;
    // the verdict it holds does not describe the new compute.
    const replaced = makeRunner(orb, spawner, task, { incarnation: "1" });
    expect(replaced.report()).toEqual({});
    const rerun = replaced.runSetup();
    spawner.runs.at(-1)?.exit(0);
    expect((await rerun)?.incarnation).toBe("1");
  });

  it("retires a verdict for a hook the checkout no longer has", async () => {
    const orb = makeOrb();
    writeHook(orb, "resume");
    const spawner = new FakeHookSpawner();
    const first = makeRunner(orb, spawner, task);
    const running = first.runResume();
    spawner.runOf("resume").exit(1);
    await running;
    rmSync(join(orb.repoDir, ".agents", "resume"));

    const second = makeRunner(orb, spawner, task);
    expect(await second.runResume()).toBeNull();
    expect(second.report()).toEqual({});
    expect(existsSync(join(orb.home, ".cache", "pi-orb", "logs", "resume.status.json"))).toBe(
      false,
    );
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
    await runDst({ name: "setup-hook-timeout", iterations: 40 }, async (sim) => {
      const orb = makeOrb();
      writeHook(orb, "setup");
      const spawner = new FakeHookSpawner();
      const statuses: (RuntimeHookStatus | null)[] = [];
      // The hook never exits, so the deadline is the only timer in the
      // simulation and is the only thing that can end the run.
      const result = await sim.runTasks([
        {
          name: "boot",
          f: async (task) => {
            const runner = makeRunner(orb, spawner, task);
            statuses.push(await runner.runSetup());
            expect(task.monotonicNow()).toBeGreaterThanOrEqual(SETUP_DEADLINE_MS);
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(spawner.runOf("setup").killed).toBe(true);
      expect(statuses[0]).toMatchObject({ outcome: "timeout", exitCode: null });
    });
  });

  it("stops blocking on resume after its window and records the late outcome", async () => {
    await runDst({ name: "resume-hook-background", iterations: 40 }, async (sim) => {
      const orb = makeOrb();
      writeHook(orb, "resume");
      const spawner = new FakeHookSpawner();
      const runners: BootHookRunner[] = [];
      let unblockedAt = -1;
      // One task and one timer — the blocking window itself. A second task
      // sleeping "longer" would not be ordered after it: this scheduler
      // deliberately explores firing a later timer first (docs/testing.md), so
      // the hook must be ended by the observed unblocking, not by a race.
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
            expect(spawner.runOf("resume").killed).toBe(false);
            // Only now does the hook finish, well past the window it outlasted.
            spawner.runOf("resume").exit(1);
            // The late verdict is recorded by a native-promise continuation,
            // which needs a simulated owner until it has settled
            // (docs/testing.md); this task is that owner.
            await runner.whenLateVerdictSettled();
          },
        },
      ]);
      expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      expect(unblockedAt).toBeGreaterThanOrEqual(RESUME_BLOCKING_WINDOW_MS);
      expect(spawner.runOf("resume").killed).toBe(false);
      // The late verdict is still recorded, and replaces the "not known yet"
      // the agent was given.
      expect(runners[0]?.report().resume).toMatchObject({ outcome: "failed", exitCode: 1 });
    });
  });

  it("terminates a backgrounded resume on shutdown", async () => {
    await runDst({ name: "resume-hook-shutdown", iterations: 40 }, async (sim) => {
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

describe("boot hook crash windows", () => {
  interface RuntimeCrashWindow {
    readonly name: string;
    /** Drive one runtime process to the durable state a death there leaves. */
    readonly arrange: (
      task: SimulationTask,
      orb: Orb,
      spawner: FakeHookSpawner,
      files: FakeHookFileStore,
    ) => Promise<void>;
    /** What the persistent workspace and home hold while nothing is running. */
    readonly durablePaths: (orb: Orb) => readonly string[];
    /** Whether the next process of the same incarnation must run setup again. */
    readonly setupRerun: boolean;
  }

  const bootSetup = async (
    task: SimulationTask,
    orb: Orb,
    spawner: FakeHookSpawner,
    files: FakeHookFileStore,
  ): Promise<BootHookRunner> => {
    const runner = makeRunner(orb, spawner, task, { files });
    const setup = runner.runSetup();
    spawner.runs.at(-1)?.exit(0);
    await setup;
    return runner;
  };

  const windows: readonly RuntimeCrashWindow[] = [
    {
      // boot-hooks.status-before-write: the hook reached a verdict and nothing
      // on disk knows it.
      name: "status-before-write",
      arrange: async (task, orb, spawner, files) => {
        files.failNextStatusWrites(1);
        files.failNextStampWrites(1);
        await bootSetup(task, orb, spawner, files);
      },
      durablePaths: () => [],
      setupRerun: true,
    },
    {
      // boot-hooks.status-written / stamp-before-write: the verdict is durable
      // and nothing claims this compute has had its setup.
      name: "status-written",
      arrange: async (task, orb, spawner, files) => {
        files.failNextStampWrites(1);
        await bootSetup(task, orb, spawner, files);
      },
      durablePaths: (orb) => [statusPath(orb, "setup")],
      setupRerun: true,
    },
    {
      // boot-hooks.stamp-written: this incarnation has spent its setup.
      name: "stamp-written",
      arrange: async (task, orb, spawner, files) => {
        await bootSetup(task, orb, spawner, files);
      },
      durablePaths: (orb) => [stampPath(orb), statusPath(orb, "setup")],
      setupRerun: false,
    },
    {
      // boot-hooks.setup-deadline-kill: the hook outlasted its deadline, its
      // group was killed, and the incarnation is spent all the same.
      name: "setup-deadline-kill",
      arrange: async (task, orb, spawner, files) => {
        const runner = makeRunner(orb, spawner, task, { files });
        expect((await runner.runSetup())?.outcome).toBe("timeout");
        expect(spawner.runs.at(-1)?.killed).toBe(true);
      },
      durablePaths: (orb) => [stampPath(orb), statusPath(orb, "setup")],
      setupRerun: false,
    },
    {
      // boot-hooks.resume-window-expired: the agent proceeded, and the resume
      // hook died with the process before it could record anything.
      name: "resume-window-expired",
      arrange: async (task, orb, spawner, files) => {
        const runner = await bootSetup(task, orb, spawner, files);
        // The hook never exits, so only the blocking window can end the wait.
        expect(await runner.runResume()).toBeNull();
      },
      durablePaths: (orb) => [stampPath(orb), statusPath(orb, "setup")],
      setupRerun: false,
    },
  ];

  for (const window of windows) {
    it(`resumes within the incarnation after death at ${window.name}`, async () => {
      await runDst(
        { name: `boot-hooks-runtime-crash-${window.name}`, iterations: 20 },
        async (sim) => {
          const orb = makeOrb();
          writeHook(orb, "setup");
          writeHook(orb, "resume");
          const spawner = new FakeHookSpawner();
          // One disk across both processes: that is what a runtime restart
          // inside an incarnation keeps (docs/orb-setup-hook.md).
          const files = new FakeHookFileStore();
          const result = await sim.runTasks([
            {
              name: "boot",
              f: async (task) => {
                await window.arrange(task, orb, spawner, files);
                expect(files.paths()).toEqual([...window.durablePaths(orb)].sort());

                const next = makeRunner(orb, spawner, task, { files });
                const beforeSetup = spawner.runs.length;
                const setup = next.runSetup();
                const reran = spawner.runs.length > beforeSetup;
                if (reran) spawner.runs.at(-1)?.exit(0);
                await setup;
                expect(reran).toBe(window.setupRerun);

                // Resume runs on every start, whatever setup did.
                const beforeResume = spawner.runs.length;
                const resume = next.runResume();
                expect(spawner.runs.length).toBe(beforeResume + 1);
                spawner.runs.at(-1)?.exit(0);
                await resume;

                // Stamp and status agree with the report the control plane reads.
                expect(files.readText(stampPath(orb))?.trim()).toBe("0");
                const persisted = files.readText(statusPath(orb, "setup"));
                expect(persisted).not.toBeNull();
                expect(JSON.parse(persisted ?? "{}")).toMatchObject({
                  hook: "setup",
                  incarnation: "0",
                  outcome: next.report().setup?.outcome,
                });
                expect(next.report().resume).toMatchObject({ outcome: "ok", incarnation: "0" });
              },
            },
          ]);
          expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
        },
      );
    });
  }
});

describe("boot hook writes under disk failures", () => {
  it("never skips a setup its stamp did not record", async () => {
    // Counted across schedules, so a run in which the disk never actually
    // refused anything cannot pass as coverage.
    const refused = { stamp: 0, status: 0 };
    await runDst(
      {
        name: "hook-writes-under-fs-failpoints",
        iterations: 30,
        failpointProbabilities: {
          [HOOK_FAILPOINTS.stampWrite]: 0.3,
          [HOOK_FAILPOINTS.statusWrite]: 0.3,
        },
      },
      async (sim) => {
        const orb = makeOrb();
        writeHook(orb, "setup");
        writeHook(orb, "resume");
        const spawner = new FakeHookSpawner();
        const files = new FakeHookFileStore();
        const result = await sim.runTasks([
          {
            name: "boot",
            f: async (task) => {
              const first = makeRunner(orb, spawner, task, { files });
              const setup = first.runSetup();
              spawner.runs.at(-1)?.exit(0);
              expect((await setup)?.outcome).toBe("ok");
              // A disk that refused the status file must not cost the health
              // report its verdict: memory is what the control plane reads.
              expect(first.report().setup).toMatchObject({ outcome: "ok", incarnation: "0" });
              const resume = first.runResume();
              spawner.runs.at(-1)?.exit(0);
              await resume;
              expect(first.report().resume).toMatchObject({ outcome: "ok" });

              const stamped = files.readText(stampPath(orb)) !== null;
              if (!stamped) refused.stamp += 1;
              if (files.readText(statusPath(orb, "setup")) === null) refused.status += 1;
              const beforeSetup = spawner.runs.length;

              // Runtime restart inside the same incarnation.
              const second = makeRunner(orb, spawner, task, { files });
              const secondSetup = second.runSetup();
              const reran = spawner.runs.length > beforeSetup;
              if (reran) spawner.runs.at(-1)?.exit(0);
              await secondSetup;
              // The stamp is the only authority: it landed and setup is
              // skipped, or it did not and an idempotent hook runs again.
              // "Skipped without a stamp" is the one outcome that is not
              // recoverable, and it must never happen.
              expect(reran).toBe(!stamped);

              const beforeResume = spawner.runs.length;
              const secondResume = second.runResume();
              expect(spawner.runs.length).toBe(beforeResume + 1);
              spawner.runs.at(-1)?.exit(0);
              await secondResume;

              // Whatever survived is whole and describes this incarnation.
              const persisted = files.readText(statusPath(orb, "setup"));
              if (persisted !== null) {
                expect(JSON.parse(persisted)).toMatchObject({
                  hook: "setup",
                  incarnation: "0",
                });
              }
            },
          },
        ]);
        expect(result.isOk(), result.isErr() ? result.error.message : "").toBe(true);
      },
    );
    expect(refused.stamp).toBeGreaterThan(0);
    expect(refused.status).toBeGreaterThan(0);
  });
});
