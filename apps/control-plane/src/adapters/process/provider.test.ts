import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  liveProcessRows,
  ProcessOrbHostProvider,
  type ProcessOrbHostProviderOptions,
} from "./provider.ts";

const task = new NoSimulationTask("process provider test", false);
const context = { signal: new AbortController().signal };
const request = {
  orbId: "orb-1",
  incarnation: 0,
  bootstrap: { repositoryUrl: "https://github.com/o/r" },
};
const roots: string[] = [];
const providers: ProcessOrbHostProvider[] = [];
/** `launch()` requires the Linux pidfd supervisor (docs/host-provider.md). */
const launchIt = it.skipIf(process.platform !== "linux");

function fixture(root: string): string {
  const path = join(root, "runtime.mjs");
  writeFileSync(
    path,
    `import { createServer } from "node:http";
import { writeFileSync, renameSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
const crash = process.env.CRASH_ONCE_FILE;
if (crash && !existsSync(crash)) { writeFileSync(crash, "crashed"); process.exit(23); }
if (process.env.GROUP_MEMBER_PID_FILE) {
  // A group member that outlives the leader: it ignores SIGTERM and writes
  // its own pid only after the handler is installed, so the pid file's
  // existence proves the member is immune to the first ladder rung.
  spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.GROUP_MEMBER_PID_FILE, String(process.pid)); setInterval(() => {}, 1000);",
  ], { stdio: "ignore", env: process.env });
}
const observedTemp = process.env.OBSERVED_ENV_FILE + "." + process.pid + ".tmp";
writeFileSync(observedTemp, JSON.stringify({
  orbId: process.env.PI_ORB_ID,
  repositoryUrl: process.env.PI_ORB_REPOSITORY_URL,
  runtimeMode: process.env.PI_ORB_RUNTIME_MODE,
  initialCheckoutCommit: process.env.PI_ORB_INITIAL_CHECKOUT_COMMIT,
  awaitInitialCheckoutCommit: process.env.PI_ORB_AWAIT_INITIAL_CHECKOUT_COMMIT,
  incarnation: process.env.PI_ORB_HOST_INCARNATION,
  container: process.env.PI_ORB_CONTAINER,
  supervisorId: process.env.PI_ORB_SUPERVISOR_ID,
  workDir: process.env.PI_ORB_WORK_DIR,
  home: process.env.HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
  controlPlaneUrl: process.env.PI_ORB_CONTROL_PLANE_URL,
  skillsDir: process.env.PI_ORB_SKILLS_DIR,
  port: process.env.PI_ORB_RUNTIME_PORT,
  path: process.env.PATH,
  gitConfigCount: process.env.GIT_CONFIG_COUNT,
  gitConfigKey0: process.env.GIT_CONFIG_KEY_0,
  gitConfigValue0: process.env.GIT_CONFIG_VALUE_0,
  gitConfigKey1: process.env.GIT_CONFIG_KEY_1,
  gitConfigValue1: process.env.GIT_CONFIG_VALUE_1,
  pid: process.pid,
}));
renameSync(observedTemp, process.env.OBSERVED_ENV_FILE);
const server = createServer((_req, res) => { res.end("ok"); });
server.listen(Number(process.env.PI_ORB_RUNTIME_PORT), "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("disconnect", stop);
`,
  );
  return path;
}

it("publishes fixture JSON only after the complete write", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-atomic-fixture-"));
  roots.push(root);
  const observed = join(root, "observed.json");
  const preload = join(root, "interrupt-write.mjs");
  writeFileSync(
    preload,
    `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const write = fs.writeFileSync;
fs.writeFileSync = (path, data, ...args) => {
  write(path, "{");
  const partialVisible = fs.existsSync(process.env.OBSERVED_ENV_FILE);
  const result = write(path, data, ...args);
  setImmediate(() => process.send({ partialVisible, published: JSON.parse(fs.readFileSync(process.env.OBSERVED_ENV_FILE, "utf8")) }));
  return result;
};
syncBuiltinESMExports();
`,
  );
  const child = spawn(process.execPath, ["--import", preload, fixture(root)], {
    env: { OBSERVED_ENV_FILE: observed, PI_ORB_RUNTIME_PORT: "0" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const observation = await new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`fixture exited before publication: ${code}`)));
    });
    expect(observation).toEqual({
      partialVisible: false,
      published: expect.objectContaining({ pid: child.pid }),
    });
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
});

function readObserved<T = Record<string, string>>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function ownedFile(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-process-files-"));
  roots.push(root);
  return join(root, name);
}

function makeProvider(
  extraEnv: Record<string, string> = {},
  options: Partial<ProcessOrbHostProviderOptions> = {},
): {
  provider: ProcessOrbHostProvider;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pi-orb-process-"));
  roots.push(root);
  const provider = new ProcessOrbHostProvider({
    stateDirectory: join(root, "configured-state"),
    runtimeEntryPoint: fixture(root),
    controlPlaneUrl: "http://127.0.0.1:7100",
    skillsDir: "/opt/pi-orb/test-skills",
    restartDelayMs: 10,
    extraEnv,
    ...options,
  });
  providers.push(provider);
  return { provider, root };
}

/**
 * Liveness excluding zombies, matching what the provider's own group probe
 * counts as live: `kill(pid, 0)` keeps answering for an exited-but-unreaped
 * child, so the process state decides.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = /^\d+ \(.*\) ([A-Z]) /.exec(stat)?.[1];
    return state !== "Z";
  } catch {
    return false;
  }
}

async function eventually<T>(read: () => T | null, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true");
}

type ScheduleDeadline = (expire: () => void) => () => void;

async function withDiscardDeadline<T>(
  discard: () => PromiseLike<T>,
  diagnostics: () => string,
  schedule: ScheduleDeadline = (expire) => {
    const timer = setTimeout(expire, 3_000);
    return () => clearTimeout(timer);
  },
): Promise<T> {
  let expired = false;
  // Keep deadline creation at zero even if the injected schedule expires first.
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockImplementation(() => (expired ? 151 : 0));
  let cancel = () => {};
  try {
    cancel = schedule(() => {
      expired = true;
    });
    const result = await discard();
    if (expired) throw new Error(`discard drain deadline expired: ${diagnostics()}`);
    return result;
  } finally {
    clock.mockRestore();
    cancel();
  }
}

it("discard deadline owns missing-drain settlement and restores the clock", async () => {
  const originalNow = Date.now;
  let expire = () => {};
  const cancel = vi.fn();
  const schedule: ScheduleDeadline = (callback) => {
    expire = callback;
    return cancel;
  };
  let release = () => {};
  const settlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  let discardSettled = false;
  let helperSettled = false;
  const diagnostics = vi.fn(() => "receipt: null; supervisorStat: T; stderr: waiting");
  const pending = withDiscardDeadline(
    async () => {
      const deadline = Date.now() + 150;
      await settlement;
      expect(Date.now()).toBeGreaterThanOrEqual(deadline);
      discardSettled = true;
    },
    diagnostics,
    schedule,
  )
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => {
      helperSettled = true;
    });
  try {
    expect(Date.now()).toBe(0);
    expire();
    await new Promise(setImmediate);
    expect(helperSettled).toBe(false);
    expect(discardSettled).toBe(false);
    expect(Date.now()).toBe(151);
    release();
    expect(await pending).toEqual(
      new Error(
        "discard drain deadline expired: receipt: null; supervisorStat: T; stderr: waiting",
      ),
    );
    expect(discardSettled).toBe(true);
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(Date.now).toBe(originalNow);
  } finally {
    release();
    await pending;
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const closed = await Promise.allSettled(providers.splice(0).map((provider) => provider.close()));
  const removed = await Promise.allSettled(
    roots.splice(0).map(async (root) => rmSync(root, { recursive: true, force: true })),
  );
  expect([...closed, ...removed].filter((result) => result.status === "rejected")).toEqual([]);
});

describe("ProcessOrbHostProvider", () => {
  launchIt(
    "exposes execution credentials only for the exact current host incarnation",
    async () => {
      const { provider, root } = makeProvider();
      const provisioned = await provider.provision(task, request, context);
      expect(provisioned.isOk()).toBe(true);
      if (provisioned.isErr()) return;
      const binding = await provider.executionBinding(task, provisioned.value.ref, context);
      expect(binding.isOk()).toBe(true);
      if (binding.isErr()) return;
      expect(binding.value.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(binding.value.token.length).toBeGreaterThan(20);
      expect(binding.value.incarnation).toBe("0");
      expect(binding.value.cwd).toBe(join(root, "configured-state", "orb-1", "workspace", "repo"));
      const stale = await provider.executionBinding(
        task,
        { ...provisioned.value.ref, resourceId: "orb-1-i99" },
        context,
      );
      expect(stale.isErr()).toBe(true);
    },
  );
  launchIt.each(["pi", "claude"] as const)("launches %s with isolated env", async (harness) => {
    const observedEnv = ownedFile("observed.json");
    const commit = "b".repeat(40);
    vi.stubEnv("XDG_CONFIG_HOME", join(tmpdir(), "developer-config"));
    const { provider, root } = makeProvider({
      OBSERVED_ENV_FILE: observedEnv,
      PI_ORB_CONTAINER: "1",
      PI_ORB_RUNTIME_MODE: "wrong",
    });
    const provisioned = await provider.provision(
      task,
      {
        ...request,
        bootstrap: {
          ...request.bootstrap,
          harness,
          initialCheckoutCommit: commit,
          awaitInitialCheckoutCommit: true,
        },
      },
      context,
    );
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;

    const values = await eventually<Record<string, string>>(() => readObserved(observedEnv));
    expect(values.orbId).toBe(request.orbId);
    expect(values.runtimeMode).toBe(harness === "claude" ? "claude" : "execution");
    expect(values.initialCheckoutCommit).toBe(commit);
    expect(values.awaitInitialCheckoutCommit).toBe("1");
    expect(values.repositoryUrl).toBe(request.bootstrap.repositoryUrl);
    expect(values.incarnation).toBe(String(request.incarnation));
    expect(values.container).toBe("0");
    expect(values.supervisorId).toMatch(/^[a-f0-9]{64}$/);
    expect(values.controlPlaneUrl).toBe("http://127.0.0.1:7100");
    expect(values.skillsDir).toBe("/opt/pi-orb/test-skills");
    const expectedWorkDir = join(root, "configured-state", request.orbId, "workspace");
    expect(values.workDir).toBe(expectedWorkDir);
    expect(values.home).toBe(join(expectedWorkDir, "home"));
    // Boot writes git's XDG file; it must never be the developer's.
    expect(values.xdgConfigHome).toBeUndefined();
    expect(existsSync(join(expectedWorkDir, "home"))).toBe(true);
    expect(Number(values.port)).toBeGreaterThan(0);

    const observed = await provider.observe(task, provisioned.value.ref, context);
    expect(observed.isOk() && observed.value?.state).toBe("running");
    expect(observed.isOk() && Number.isFinite(observed.value?.lastStartedAt)).toBe(true);
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      `http://127.0.0.1:${values.port}`,
    );
  });

  launchIt("prepends an explicitly configured in-orb command directory to PATH", async () => {
    const observedEnv = ownedFile("observed.json");
    const commandDirectory = join(dirname(observedEnv), "commands");
    const { provider } = makeProvider({ OBSERVED_ENV_FILE: observedEnv }, { commandDirectory });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    const values = await eventually<Record<string, string>>(() => readObserved(observedEnv));
    expect(values.path?.split(":")[0]).toBe(commandDirectory);
    // The image's system gitconfig has no process-host equivalent, so the
    // GitHub credential helper travels in the environment with the shim.
    expect(values.gitConfigCount).toBe("1");
    expect(values.gitConfigKey0).toBe("credential.https://github.com.helper");
    expect(values.gitConfigValue0).toBe("!pi-orb-git-credential");
  });

  launchIt("appends the credential helper after inherited git configuration entries", async () => {
    const observedEnv = ownedFile("observed.json");
    const commandDirectory = join(dirname(observedEnv), "commands");
    const { provider } = makeProvider(
      {
        OBSERVED_ENV_FILE: observedEnv,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "inherited",
      },
      { commandDirectory },
    );
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    const values = await eventually<Record<string, string>>(() => readObserved(observedEnv));
    expect(values.gitConfigCount).toBe("2");
    expect(values.gitConfigKey0).toBe("user.name");
    expect(values.gitConfigValue0).toBe("inherited");
    expect(values.gitConfigKey1).toBe("credential.https://github.com.helper");
    expect(values.gitConfigValue1).toBe("!pi-orb-git-credential");
  });

  it("treats unstamped legacy metadata as incarnation zero", async () => {
    const { provider, root } = makeProvider();
    const hostDirectory = join(root, "configured-state", request.orbId);
    const workspace = join(hostDirectory, "workspace");
    const home = join(workspace, "home");
    const sentinel = join(workspace, "sentinel");
    mkdirSync(home, { recursive: true });
    writeFileSync(sentinel, "legacy workspace");
    writeFileSync(
      join(hostDirectory, "host.json"),
      `${JSON.stringify({
        v: 1,
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
        runtimeToken: "legacy-token",
        harness: "pi",
        port: 43210,
        supervisorId: "a".repeat(64),
        desiredState: "stopped",
      })}\n`,
    );

    const discarded = await provider.discardCompute(
      task,
      { orbId: request.orbId, throughIncarnation: 0 },
      context,
    );
    expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
    expect(existsSync(join(hostDirectory, "host.json"))).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toBe("legacy workspace");
  });

  launchIt("discards runtime metadata while retaining the workspace", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;
    await eventually(() => (existsSync(observedEnv) ? true : null));
    const hostDirectory = join(root, "configured-state", request.orbId);
    const workspace = join(hostDirectory, "workspace");
    const sentinel = join(workspace, "sentinel");
    writeFileSync(sentinel, "retained");

    const discarded = await provider.discardCompute(
      task,
      { orbId: request.orbId, throughIncarnation: 0 },
      context,
    );
    expect(discarded.isOk()).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
    expect(existsSync(join(hostDirectory, "host.json"))).toBe(false);
    const observed = await provider.observe(task, provisioned.value.ref, context);
    expect(observed.isOk() && observed.value).toBeNull();
    expect(
      (
        await provider.discardCompute(
          task,
          { orbId: request.orbId, throughIncarnation: 0 },
          context,
        )
      ).isOk(),
    ).toBe(true);
  });

  launchIt("a stale discard fence cannot remove a newer incarnation", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    const hostDirectory = join(root, "configured-state", request.orbId);
    const metadata = JSON.parse(readFileSync(join(hostDirectory, "host.json"), "utf8")) as {
      drainToken: string;
    };
    expect(JSON.parse(readFileSync(join(hostDirectory, "drained.json.ready"), "utf8"))).toEqual({
      launch: metadata.drainToken,
    });
    expect(
      (
        await provider.discardCompute(
          task,
          { orbId: request.orbId, throughIncarnation: 0 },
          context,
        )
      ).isOk(),
    ).toBe(true);

    const replacement = await provider.provision(task, { ...request, incarnation: 1 }, context);
    expect(replacement.isOk() && replacement.value.incarnation).toBe(1);
    expect(
      (
        await provider.discardCompute(
          task,
          { orbId: request.orbId, throughIncarnation: 0 },
          context,
        )
      ).isOk(),
    ).toBe(true);
    if (replacement.isOk()) {
      const observed = await provider.observe(task, replacement.value.ref, context);
      expect(observed.isOk() && observed.value?.incarnation).toBe(1);
      expect(observed.isOk() && observed.value?.state).toBe("running");
    }
  });

  launchIt("terminates the runtime and removes its complete state directory", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;
    await eventually(() => (existsSync(observedEnv) ? true : null));
    const hostDirectory = join(root, "configured-state", request.orbId);
    expect(existsSync(hostDirectory)).toBe(true);

    expect((await provider.destroy(task, request.orbId, context)).isOk()).toBe(true);
    expect(existsSync(hostDirectory)).toBe(false);
    const observed = await provider.observe(task, provisioned.value.ref, context);
    expect(observed.isOk() && observed.value).toBeNull();
    const second = await provider.destroy(task, request.orbId, context);
    expect(second.isOk(), JSON.stringify(second)).toBe(true);
  });

  launchIt("retains token and workspace metadata across stop and start", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    await eventually<Record<string, string>>(() => readObserved(observedEnv));

    const firstLifetime = readObserved(observedEnv)?.supervisorId;
    expect((await provider.stop(task, first.value.ref, context)).isOk()).toBe(true);
    const stopped = await provider.observe(task, first.value.ref, context);
    expect(stopped.isOk() && stopped.value?.state).toBe("stopped");
    expect(
      (
        await provider.start(
          task,
          {
            ref: first.value.ref,
            expectedIncarnation: first.value.incarnation,
            expectedSpecFingerprint: first.value.specFingerprint,
          },
          context,
        )
      ).isOk(),
    ).toBe(true);
    const reused = await provider.provision(task, request, context);
    expect(reused.isOk() && reused.value.runtimeTokenHash).toBe(first.value.runtimeTokenHash);
    expect(
      JSON.parse(readFileSync(join(root, "configured-state", request.orbId, "host.json"), "utf8"))
        .supervisorId,
    ).not.toBe(firstLifetime);
  });

  launchIt("discards the persisted process group after a provider restart", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;
    const values = await eventually(() => readObserved<{ pid: number }>(observedEnv));
    expect(processExists(values.pid)).toBe(true);

    const replacement = new ProcessOrbHostProvider({
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7100",
      skillsDir: "/opt/pi-orb/test-skills",
      restartDelayMs: 10,
      extraEnv: { OBSERVED_ENV_FILE: observedEnv },
    });
    providers.push(replacement);
    const discarded = await replacement.discardCompute(
      task,
      { orbId: request.orbId, throughIncarnation: 0 },
      context,
    );
    expect(discarded.isOk()).toBe(true);
    await eventually(() => (processExists(values.pid) ? null : true));
    expect(existsSync(join(root, "configured-state", request.orbId, "workspace"))).toBe(true);
  });

  launchIt("reuses durable metadata after the owning control-plane process restarts", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    await eventually<Record<string, string>>(() => readObserved(observedEnv));
    await provider.close();

    const replacement = new ProcessOrbHostProvider({
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7100",
      skillsDir: "/opt/pi-orb/test-skills",
      restartDelayMs: 10,
      extraEnv: { OBSERVED_ENV_FILE: observedEnv },
    });
    providers.push(replacement);
    const reused = await replacement.provision(task, request, context);
    expect(reused.isOk() && reused.value.runtimeTokenHash).toBe(first.value.runtimeTokenHash);
    // Same launch facts, same durable stamp: a restart must not look like a
    // spec change, which would replace every orb's compute on its next start.
    expect(reused.isOk() && reused.value.specFingerprint).toBe(first.value.specFingerprint);
  });

  launchIt("supervises an unexpectedly exited runtime in the control-plane process", async () => {
    const observedEnv = ownedFile("observed.json");
    const crashFile = join(dirname(observedEnv), "crash");
    let releaseRelaunch: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseRelaunch = resolve;
    });
    const { provider, root } = makeProvider(
      {
        OBSERVED_ENV_FILE: observedEnv,
        CRASH_ONCE_FILE: crashFile,
      },
      { onCrashRelaunch: () => gate },
    );
    const result = await provider.provision(task, request, context);
    expect(result.isOk()).toBe(true);
    const initialLifetime = JSON.parse(
      readFileSync(join(root, "configured-state", request.orbId, "host.json"), "utf8"),
    ).supervisorId;
    releaseRelaunch();
    await eventually<Record<string, string>>(() => readObserved(observedEnv));
    const metadata = JSON.parse(
      readFileSync(join(root, "configured-state", request.orbId, "host.json"), "utf8"),
    );
    expect(metadata.supervisorId).toBe(initialLifetime);
    expect(readObserved(observedEnv)?.supervisorId).toBe(initialLifetime);
    const listed = await provider.listManagedHosts(task, context);
    expect(listed.isOk() && listed.value[0]?.state).toBe("running");
  });

  launchIt("a discard racing the crash relaunch cannot resurrect fenced metadata", async () => {
    const observedEnv = ownedFile("observed.json");
    const crashFile = join(dirname(observedEnv), "crash");
    let signalRelaunch: () => void = () => undefined;
    const relaunchFired = new Promise<void>((resolve) => {
      signalRelaunch = resolve;
    });
    let releaseRelaunch: () => void = () => undefined;
    const relaunchGate = new Promise<void>((resolve) => {
      releaseRelaunch = resolve;
    });
    const { provider, root } = makeProvider(
      { OBSERVED_ENV_FILE: observedEnv, CRASH_ONCE_FILE: crashFile },
      {
        restartDelayMs: 1,
        onCrashRelaunch: () => {
          signalRelaunch();
          return relaunchGate;
        },
      },
    );
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);

    // The child crashes once; hold the relaunch in flight at its timer.
    await relaunchFired;
    // The discard runs to completion inside the forced interleaving window.
    const discarded = await provider.discardCompute(
      task,
      { orbId: request.orbId, throughIncarnation: 0 },
      context,
    );
    expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
    const hostDirectory = join(root, "configured-state", request.orbId);
    expect(existsSync(join(hostDirectory, "host.json"))).toBe(false);

    // Release the relaunch and let its lock section register before queueing
    // another lock user behind it (microtasks drain before immediates).
    releaseRelaunch();
    await new Promise((resolve) => setImmediate(resolve));
    // Idempotent discard queues behind the relaunch: once it returns, the
    // relaunch body has run and must have aborted against the removed file.
    const again = await provider.discardCompute(
      task,
      { orbId: request.orbId, throughIncarnation: 0 },
      context,
    );
    expect(again.isOk()).toBe(true);
    expect(existsSync(join(hostDirectory, "host.json"))).toBe(false);
    expect(existsSync(join(hostDirectory, "runtime.log"))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "discard never signals a reused supervisor PID",
    async () => {
      const { provider, root } = makeProvider();
      const provisioned = await provider.provision(task, request, context);
      expect(provisioned.isOk()).toBe(true);
      const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        detached: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => unrelated.once("spawn", resolve));
      const metadataPath = join(root, "configured-state", request.orbId, "host.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      writeFileSync(
        metadataPath,
        `${JSON.stringify({ ...metadata, processGroupId: unrelated.pid, processBirth: "not-this-birth" })}\n`,
      );
      try {
        const discarded = await provider.discardCompute(
          task,
          { orbId: request.orbId, throughIncarnation: 0 },
          context,
        );
        expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
        expect(unrelated.pid).toBeDefined();
        expect(processExists(Number(unrelated.pid))).toBe(true);
      } finally {
        unrelated.kill("SIGKILL");
      }
    },
  );

  launchIt(
    "discard kills a live managed child even when no process group is recorded",
    async () => {
      const observedEnv = ownedFile("observed.json");
      const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
      const provisioned = await provider.provision(task, request, context);
      expect(provisioned.isOk()).toBe(true);
      const values = await eventually(() => readObserved<{ pid: number }>(observedEnv));
      expect(processExists(values.pid)).toBe(true);

      // Simulate metadata that lost its process group (e.g. written around a
      // crash window): absence verification must fall back to the live child.
      const metadataPath = join(root, "configured-state", request.orbId, "host.json");
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, processGroupId: null })}\n`);

      const discarded = await provider.discardCompute(
        task,
        { orbId: request.orbId, throughIncarnation: 0 },
        context,
      );
      expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
      expect(processExists(values.pid)).toBe(false);
      expect(existsSync(metadataPath)).toBe(false);
    },
  );

  launchIt.each([false, true])(
    "discard kills group members that outlive the leader (delayed drain: %s)",
    async (delayed) => {
      const observedEnv = ownedFile("observed.json");
      const memberPidFile = join(dirname(observedEnv), "member.pid");
      const { provider, root } = makeProvider(
        { OBSERVED_ENV_FILE: observedEnv, GROUP_MEMBER_PID_FILE: memberPidFile },
        { terminateGraceMs: 150 },
      );
      let memberPid: number | null = null;
      let pausedSupervisor: number | null = null;
      try {
        const provisioned = await provider.provision(task, request, context);
        expect(provisioned.isOk()).toBe(true);
        memberPid = await eventually(() => {
          try {
            const pid = Number(readFileSync(memberPidFile, "utf8"));
            return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
          } catch {
            return null;
          }
        });
        expect(processExists(memberPid)).toBe(true);

        const directory = join(root, "configured-state", request.orbId);
        const metadataPath = join(directory, "host.json");
        const receiptPath = join(directory, "drained.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
          processGroupId: number;
          processBirth: string;
          drainToken: string;
        };
        const diagnostics = () => {
          const read = (path: string) => {
            try {
              return readFileSync(path, "utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw error;
            }
          };
          return JSON.stringify({
            metadata,
            supervisorStat: read(`/proc/${metadata.processGroupId}/stat`),
            receipt: read(receiptPath),
            stderr: read(join(directory, "runtime.err.log")),
          });
        };
        if (delayed) {
          pausedSupervisor = metadata.processGroupId;
          process.kill(pausedSupervisor, "SIGSTOP");
          await eventually(() =>
            readFileSync(`/proc/${metadata.processGroupId}/stat`, "utf8").includes(") T ")
              ? true
              : null,
          );
        }

        // Drive deadline expiry explicitly; successful drain follows the receipt,
        // not the scheduler's ability to kill, reap and fsync within the grace period.
        const discard = () =>
          provider.discardCompute(task, { orbId: request.orbId, throughIncarnation: 0 }, context);
        let discarded: Awaited<ReturnType<typeof discard>> | undefined;
        const originalNow = Date.now;
        if (delayed) {
          await expect(
            withDiscardDeadline(
              async () => {
                discarded = await discard();
              },
              diagnostics,
              (expire) => {
                queueMicrotask(expire);
                return () => {};
              },
            ),
          ).rejects.toThrow("discard drain deadline expired:");
        } else {
          discarded = await withDiscardDeadline(discard, diagnostics);
        }
        expect(Date.now).toBe(originalNow);
        expect(discarded, diagnostics()).toBeDefined();
        if (discarded === undefined) return;
        if (delayed) {
          expect(discarded.isErr(), diagnostics()).toBe(true);
          if (discarded.isErr()) {
            expect(discarded.error).toEqual({
              type: "orb_host_provider_error",
              provider: "process",
              operation: "discard",
              code: "unavailable",
              message: "execution supervisor loss: descendant cleanup is unknown",
              retryable: true,
            });
          }
          expect(existsSync(metadataPath), diagnostics()).toBe(true);
          expect(existsSync(receiptPath), diagnostics()).toBe(false);
          expect(processExists(memberPid), diagnostics()).toBe(true);
          process.kill(metadata.processGroupId, "SIGCONT");
          pausedSupervisor = null;
          await eventually(() => {
            if (!existsSync(receiptPath) || processExists(metadata.processGroupId)) return null;
            const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as { launch: string };
            return receipt.launch === metadata.drainToken ? true : null;
          }).catch((error: unknown) => {
            console.error(diagnostics());
            throw error;
          });
          expect(readFileSync(join(directory, "runtime.err.log"), "utf8")).toContain(
            "execution supervisor: descendants drained",
          );
          expect((await discard()).isOk(), diagnostics()).toBe(true);
        } else {
          expect(discarded.isOk(), diagnostics()).toBe(true);
        }
        expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toEqual({
          launch: metadata.drainToken,
        });
        expect(processExists(metadata.processGroupId), diagnostics()).toBe(false);
        expect(processExists(memberPid), diagnostics()).toBe(false);
        expect(existsSync(metadataPath)).toBe(false);
      } finally {
        if (pausedSupervisor !== null) process.kill(pausedSupervisor, "SIGCONT");
        if (memberPid !== null && processExists(memberPid)) {
          try {
            process.kill(memberPid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    },
  );
});

describe("ProcessOrbHostProvider host specification", () => {
  it("includes selected harness in immutable specification", () => {
    const provider = makeProvider().provider;
    const input = { orbId: "orb-1", repositoryUrl: "https://github.com/o/r" };
    expect(provider.desiredSpecFingerprint(input)).toBe(
      provider.desiredSpecFingerprint({ ...input, harness: "pi" }),
    );
    expect(provider.desiredSpecFingerprint({ ...input, harness: "claude" })).not.toBe(
      provider.desiredSpecFingerprint(input),
    );
  });
  const specInput = { orbId: request.orbId, repositoryUrl: request.bootstrap.repositoryUrl };

  /** Metadata predating the host-spec stamp, written straight to disk. */
  function seedLegacyMetadata(root: string, overrides: Record<string, unknown> = {}): string {
    const hostDirectory = join(root, "configured-state", request.orbId);
    mkdirSync(join(hostDirectory, "workspace", "home"), { recursive: true });
    writeFileSync(
      join(hostDirectory, "host.json"),
      `${JSON.stringify({
        v: 1,
        orbId: request.orbId,
        repositoryUrl: request.bootstrap.repositoryUrl,
        runtimeToken: "legacy-token",
        harness: "pi",
        port: 43_210,
        supervisorId: "a".repeat(64),
        desiredState: "stopped",
        ...overrides,
      })}\n`,
    );
    return hostDirectory;
  }

  it("is sensitive to every launch fact and blind to the spec generation", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-orb-process-"));
    roots.push(root);
    const base: ProcessOrbHostProviderOptions = {
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7100",
      skillsDir: "/opt/pi-orb/test-skills",
    };
    const fingerprint = (overrides: Partial<ProcessOrbHostProviderOptions> = {}): string =>
      new ProcessOrbHostProvider({ ...base, ...overrides }).desiredSpecFingerprint(specInput);

    const original = fingerprint();
    expect(fingerprint()).toBe(original);
    expect(fingerprint({ extraEnv: {} })).toBe(original);
    expect(fingerprint({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(original);
    expect(fingerprint({ extraEnv: { OPENAI_BASE_URL: "http://a" } })).not.toBe(
      fingerprint({ extraEnv: { OPENAI_BASE_URL: "http://b" } }),
    );
    expect(fingerprint({ runtimeEntryPoint: join(root, "other-runtime.mjs") })).not.toBe(original);
    expect(fingerprint({ controlPlaneUrl: "http://127.0.0.1:7200" })).not.toBe(original);
    expect(fingerprint({ commandDirectory: join(root, "commands") })).not.toBe(original);
    expect(fingerprint({ skillsDir: join(root, "skills") })).not.toBe(original);
    expect(
      new ProcessOrbHostProvider(base).desiredSpecFingerprint({
        ...specInput,
        repositoryUrl: "https://github.com/o/other",
      }),
    ).not.toBe(original);
    // The generation is a rollover fence, not part of the specification.
    expect(fingerprint({ specGeneration: 9 })).toBe(original);
  });

  launchIt("keeps the committed stamp while the live configuration moves on", async () => {
    // The SIGHUP contract at unit level: reloading configuration changes what
    // the provider *desires*, never what the running incarnation was born
    // with. Replacement happens on the next start, not underneath the orb.
    const observedEnv = ownedFile("observed.json");
    const extraEnv: Record<string, string> = { OBSERVED_ENV_FILE: observedEnv };
    const { provider } = makeProvider(extraEnv);
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk(), JSON.stringify(provisioned)).toBe(true);
    if (provisioned.isErr()) return;
    expect(provisioned.value.specFingerprint).toBe(provider.desiredSpecFingerprint(specInput));

    extraEnv["OPENAI_BASE_URL"] = "http://mock-openai";
    expect(provider.desiredSpecFingerprint(specInput)).not.toBe(provisioned.value.specFingerprint);

    const observed = await provider.observe(task, provisioned.value.ref, context);
    expect(observed.isOk() && observed.value?.specFingerprint).toBe(
      provisioned.value.specFingerprint,
    );
  });

  it("observes legacy unstamped metadata as having no fingerprint", async () => {
    const { provider, root } = makeProvider();
    seedLegacyMetadata(root);
    const observed = await provider.observe(
      task,
      { provider: "process", resourceId: `${request.orbId}-i0` },
      context,
    );
    expect(observed.isOk(), JSON.stringify(observed)).toBe(true);
    expect(observed.isOk() && observed.value?.incarnation).toBe(0);
    expect(observed.isOk() && observed.value?.specFingerprint).toBeNull();
  });

  it("start refuses metadata whose stamp differs from the expectation", async () => {
    const { provider, root } = makeProvider();
    seedLegacyMetadata(root, { specFingerprint: "committed-fingerprint" });
    const result = await provider.start(
      task,
      {
        ref: { provider: "process", resourceId: `${request.orbId}-i0` },
        expectedIncarnation: 0,
        expectedSpecFingerprint: "desired-fingerprint",
      },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
  });

  it("start refuses legacy unstamped metadata when a stamp is expected", async () => {
    const { provider, root } = makeProvider();
    seedLegacyMetadata(root);
    const result = await provider.start(
      task,
      {
        ref: { provider: "process", resourceId: `${request.orbId}-i0` },
        expectedIncarnation: 0,
        expectedSpecFingerprint: "desired-fingerprint",
      },
      context,
    );
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
  });

  launchIt("start accepts legacy unstamped metadata when no stamp is expected", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk(), JSON.stringify(first)).toBe(true);
    if (first.isErr()) return;
    expect((await provider.stop(task, first.value.ref, context)).isOk()).toBe(true);

    // Downgrade the committed metadata to its pre-stamp shape: a legacy
    // resource is the one thing a null expectation may start.
    const metadataPath = join(root, "configured-state", request.orbId, "host.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    delete metadata["specFingerprint"];
    writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);

    const started = await provider.start(
      task,
      {
        ref: first.value.ref,
        expectedIncarnation: first.value.incarnation,
        expectedSpecFingerprint: null,
      },
      context,
    );
    expect(started.isOk(), JSON.stringify(started)).toBe(true);
    const observed = await provider.observe(task, first.value.ref, context);
    expect(observed.isOk() && observed.value?.state).toBe("running");
    expect(observed.isOk() && Number.isFinite(observed.value?.lastStartedAt)).toBe(true);
  });

  launchIt("provision refuses metadata carrying a different stamp", async () => {
    const observedEnv = ownedFile("observed.json");
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk(), JSON.stringify(first)).toBe(true);
    if (first.isErr()) return;
    await provider.close();

    // Same orb, same incarnation, reconfigured control plane: the existing
    // compute may not be reused, and provisioning must not mutate it.
    const reconfigured = new ProcessOrbHostProvider({
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7200",
      skillsDir: "/opt/pi-orb/test-skills",
      restartDelayMs: 10,
      extraEnv: { OBSERVED_ENV_FILE: observedEnv },
    });
    providers.push(reconfigured);
    const result = await reconfigured.provision(task, request, context);
    expect(result.isErr() && result.error.code).toBe("conflict");
    expect(result.isErr() && result.error.retryable).toBe(false);
    const metadata = JSON.parse(
      readFileSync(join(root, "configured-state", request.orbId, "host.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata["specFingerprint"]).toBe(first.value.specFingerprint);
  });
});

describe("liveProcessRows", () => {
  it("keeps running processes and drops zombies", () => {
    const rows = liveProcessRows(
      ["  501 501 Ss", "  502 501 Z+", "  503 501 R", "  504 504 S"].join("\n"),
    );
    expect(rows).toEqual([
      { pid: 501, processGroupId: 501 },
      { pid: 503, processGroupId: 501 },
      { pid: 504, processGroupId: 504 },
    ]);
    expect(rows.some((row) => row.processGroupId === 501)).toBe(true);
  });

  it("reports no live member for a group of only zombies", () => {
    const rows = liveProcessRows(["901 900 Z", "900 900 Z+"].join("\n"));
    expect(rows.some((row) => row.processGroupId === 900)).toBe(false);
    expect(rows).toEqual([]);
  });

  it("ignores empty and unparseable output", () => {
    expect(liveProcessRows("")).toEqual([]);
    expect(liveProcessRows("\n\n  \n")).toEqual([]);
    expect(liveProcessRows("PID PGID STAT\n")).toEqual([]);
    expect(liveProcessRows("ps: illegal option -- g\n")).toEqual([]);
  });

  it("counts every non-zombie state, however decorated", () => {
    expect(liveProcessRows("1 1 Ss+\n2 1 R+\n3 1 U\n4 1 I\n5 1 T\n").map((row) => row.pid)).toEqual(
      [1, 2, 3, 4, 5],
    );
  });
});
