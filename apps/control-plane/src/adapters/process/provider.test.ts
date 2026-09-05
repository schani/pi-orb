import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it } from "vitest";
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

function fixture(root: string): string {
  const path = join(root, "runtime.mjs");
  writeFileSync(
    path,
    `import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
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
writeFileSync(process.env.OBSERVED_ENV_FILE, JSON.stringify({
  orbId: process.env.PI_ORB_ID,
  repositoryUrl: process.env.PI_ORB_REPOSITORY_URL,
  incarnation: process.env.PI_ORB_HOST_INCARNATION,
  workDir: process.env.PI_ORB_WORK_DIR,
  home: process.env.HOME,
  controlPlaneUrl: process.env.PI_ORB_CONTROL_PLANE_URL,
  port: process.env.PI_ORB_RUNTIME_PORT,
  path: process.env.PATH,
  gitConfigCount: process.env.GIT_CONFIG_COUNT,
  gitConfigKey0: process.env.GIT_CONFIG_KEY_0,
  gitConfigValue0: process.env.GIT_CONFIG_VALUE_0,
  gitConfigKey1: process.env.GIT_CONFIG_KEY_1,
  gitConfigValue1: process.env.GIT_CONFIG_VALUE_1,
  pid: process.pid,
}));
const server = createServer((_req, res) => { res.end("ok"); });
server.listen(Number(process.env.PI_ORB_RUNTIME_PORT), "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("disconnect", stop);
`,
  );
  return path;
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
 * child, so on both supported platforms the process state decides.
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = /^\d+ \(.*\) ([A-Z]) /.exec(stat)?.[1];
      return state !== "Z";
    }
    if (process.platform === "darwin") {
      const probe = spawnSync("ps", ["-o", "pid=,pgid=,stat=", "-p", String(pid)], {
        encoding: "utf8",
      });
      return liveProcessRows(probe.stdout ?? "").some((row) => row.pid === pid);
    }
    return true;
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

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ProcessOrbHostProvider", () => {
  it("uses only its configured state directory and launches a runtime with isolated env", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;

    const values = await eventually(() => {
      try {
        return JSON.parse(readFileSync(observedEnv, "utf8")) as Record<string, string>;
      } catch {
        return null;
      }
    });
    expect(values.orbId).toBe(request.orbId);
    expect(values.repositoryUrl).toBe(request.bootstrap.repositoryUrl);
    expect(values.incarnation).toBe(String(request.incarnation));
    expect(values.controlPlaneUrl).toBe("http://127.0.0.1:7100");
    const expectedWorkDir = join(root, "configured-state", request.orbId, "workspace");
    expect(values.workDir).toBe(expectedWorkDir);
    expect(values.home).toBe(join(expectedWorkDir, "home"));
    expect(existsSync(join(expectedWorkDir, "home"))).toBe(true);
    expect(Number(values.port)).toBeGreaterThan(0);

    const observed = await provider.observe(task, provisioned.value.ref, context);
    expect(observed.isOk() && observed.value?.state).toBe("running");
    expect(observed.isOk() && observed.value?.runtimeAddress?.baseUrl).toBe(
      `http://127.0.0.1:${values.port}`,
    );
    rmSync(observedEnv, { force: true });
  });

  it("prepends an explicitly configured in-orb command directory to PATH", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const commandDirectory = join(tmpdir(), `pi-orb-commands-${crypto.randomUUID()}`);
    const { provider } = makeProvider({ OBSERVED_ENV_FILE: observedEnv }, { commandDirectory });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    const values = await eventually(() => {
      try {
        return JSON.parse(readFileSync(observedEnv, "utf8")) as Record<string, string>;
      } catch {
        return null;
      }
    });
    expect(values.path?.split(":")[0]).toBe(commandDirectory);
    // The image's system gitconfig has no process-host equivalent, so the
    // GitHub credential helper travels in the environment with the shim.
    expect(values.gitConfigCount).toBe("1");
    expect(values.gitConfigKey0).toBe("credential.https://github.com.helper");
    expect(values.gitConfigValue0).toBe("!pi-orb-git-credential");
    rmSync(observedEnv, { force: true });
  });

  it("appends the credential helper after inherited git configuration entries", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const commandDirectory = join(tmpdir(), `pi-orb-commands-${crypto.randomUUID()}`);
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
    const values = await eventually(() => {
      try {
        return JSON.parse(readFileSync(observedEnv, "utf8")) as Record<string, string>;
      } catch {
        return null;
      }
    });
    expect(values.gitConfigCount).toBe("2");
    expect(values.gitConfigKey0).toBe("user.name");
    expect(values.gitConfigValue0).toBe("inherited");
    expect(values.gitConfigKey1).toBe("credential.https://github.com.helper");
    expect(values.gitConfigValue1).toBe("!pi-orb-git-credential");
    rmSync(observedEnv, { force: true });
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
        port: 43210,
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

  it("discards runtime metadata while retaining the workspace", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
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
    rmSync(observedEnv, { force: true });
  });

  it("a stale discard fence cannot remove a newer incarnation", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
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
    rmSync(observedEnv, { force: true });
  });

  it("terminates the runtime and removes its complete state directory", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
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
    rmSync(observedEnv, { force: true });
  });

  it("retains token and workspace metadata across stop and start", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    await eventually(() => {
      try {
        return readFileSync(observedEnv).length > 0 ? true : null;
      } catch {
        return null;
      }
    });

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
    rmSync(observedEnv, { force: true });
  });

  it("discards the persisted process group after a provider restart", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    if (provisioned.isErr()) return;
    const values = await eventually(() => {
      try {
        return JSON.parse(readFileSync(observedEnv, "utf8")) as { pid: number };
      } catch {
        return null;
      }
    });
    expect(processExists(values.pid)).toBe(true);

    const replacement = new ProcessOrbHostProvider({
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7100",
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
    rmSync(observedEnv, { force: true });
  });

  it("reuses durable metadata after the owning control-plane process restarts", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const first = await provider.provision(task, request, context);
    expect(first.isOk()).toBe(true);
    if (first.isErr()) return;
    await eventually(() => {
      try {
        return readFileSync(observedEnv).length > 0 ? true : null;
      } catch {
        return null;
      }
    });
    await provider.close();

    const replacement = new ProcessOrbHostProvider({
      stateDirectory: join(root, "configured-state"),
      runtimeEntryPoint: join(root, "runtime.mjs"),
      controlPlaneUrl: "http://127.0.0.1:7100",
      restartDelayMs: 10,
      extraEnv: { OBSERVED_ENV_FILE: observedEnv },
    });
    providers.push(replacement);
    const reused = await replacement.provision(task, request, context);
    expect(reused.isOk() && reused.value.runtimeTokenHash).toBe(first.value.runtimeTokenHash);
    // Same launch facts, same durable stamp: a restart must not look like a
    // spec change, which would replace every orb's compute on its next start.
    expect(reused.isOk() && reused.value.specFingerprint).toBe(first.value.specFingerprint);
    rmSync(observedEnv, { force: true });
  });

  it("supervises an unexpectedly exited runtime in the control-plane process", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const crashFile = join(tmpdir(), `pi-orb-crash-${crypto.randomUUID()}`);
    const { provider } = makeProvider({
      OBSERVED_ENV_FILE: observedEnv,
      CRASH_ONCE_FILE: crashFile,
    });
    const result = await provider.provision(task, request, context);
    expect(result.isOk()).toBe(true);
    await eventually(() => {
      try {
        return readFileSync(observedEnv).length > 0 ? true : null;
      } catch {
        return null;
      }
    });
    const listed = await provider.listManagedHosts(task, context);
    expect(listed.isOk() && listed.value[0]?.state).toBe("running");
    rmSync(observedEnv, { force: true });
    rmSync(crashFile, { force: true });
  });

  it("a discard racing the crash relaunch cannot resurrect fenced metadata", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const crashFile = join(tmpdir(), `pi-orb-crash-${crypto.randomUUID()}`);
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
    rmSync(observedEnv, { force: true });
    rmSync(crashFile, { force: true });
  });

  it("discard kills a live managed child even when no process group is recorded", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const { provider, root } = makeProvider({ OBSERVED_ENV_FILE: observedEnv });
    const provisioned = await provider.provision(task, request, context);
    expect(provisioned.isOk()).toBe(true);
    const values = await eventually(() => {
      try {
        return JSON.parse(readFileSync(observedEnv, "utf8")) as { pid: number };
      } catch {
        return null;
      }
    });
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
    rmSync(observedEnv, { force: true });
  });

  it("discard kills group members that outlive the leader", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
    const memberPidFile = join(tmpdir(), `pi-orb-member-${crypto.randomUUID()}`);
    const { provider, root } = makeProvider(
      { OBSERVED_ENV_FILE: observedEnv, GROUP_MEMBER_PID_FILE: memberPidFile },
      { terminateGraceMs: 150 },
    );
    let memberPid: number | null = null;
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

      // The leader dies on SIGTERM; the member ignores it. Discard may only
      // report absence once the whole group is gone, which requires the
      // SIGKILL rung and the post-SIGKILL group probe.
      const discarded = await provider.discardCompute(
        task,
        { orbId: request.orbId, throughIncarnation: 0 },
        context,
      );
      expect(discarded.isOk(), JSON.stringify(discarded)).toBe(true);
      expect(processExists(memberPid)).toBe(false);
      expect(existsSync(join(root, "configured-state", request.orbId, "host.json"))).toBe(false);
    } finally {
      if (memberPid !== null && processExists(memberPid)) {
        try {
          process.kill(memberPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(observedEnv, { force: true });
      rmSync(memberPidFile, { force: true });
    }
  });
});

describe("ProcessOrbHostProvider host specification", () => {
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
        port: 43_210,
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
    expect(
      new ProcessOrbHostProvider(base).desiredSpecFingerprint({
        ...specInput,
        repositoryUrl: "https://github.com/o/other",
      }),
    ).not.toBe(original);
    // The generation is a rollover fence, not part of the specification.
    expect(fingerprint({ specGeneration: 9 })).toBe(original);
  });

  it("keeps the committed stamp while the live configuration moves on", async () => {
    // The SIGHUP contract at unit level: reloading configuration changes what
    // the provider *desires*, never what the running incarnation was born
    // with. Replacement happens on the next start, not underneath the orb.
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
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
    rmSync(observedEnv, { force: true });
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

  it("start accepts legacy unstamped metadata when no stamp is expected", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
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
    rmSync(observedEnv, { force: true });
  });

  it("provision refuses metadata carrying a different stamp", async () => {
    const observedEnv = join(tmpdir(), `pi-orb-observed-${crypto.randomUUID()}.json`);
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
    rmSync(observedEnv, { force: true });
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
