import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoSimulationTask } from "determined";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessOrbHostProvider } from "./provider.ts";

const task = new NoSimulationTask("process provider test", false);
const context = { signal: new AbortController().signal };
const request = { orbId: "orb-1", bootstrap: { repositoryUrl: "https://github.com/o/r" } };
const roots: string[] = [];
const providers: ProcessOrbHostProvider[] = [];

function fixture(root: string): string {
  const path = join(root, "runtime.mjs");
  writeFileSync(
    path,
    `import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
const crash = process.env.CRASH_ONCE_FILE;
if (crash && !existsSync(crash)) { writeFileSync(crash, "crashed"); process.exit(23); }
writeFileSync(process.env.OBSERVED_ENV_FILE, JSON.stringify({
  orbId: process.env.PI_ORB_ID,
  repositoryUrl: process.env.PI_ORB_REPOSITORY_URL,
  workDir: process.env.PI_ORB_WORK_DIR,
  home: process.env.HOME,
  controlPlaneUrl: process.env.PI_ORB_CONTROL_PLANE_URL,
  port: process.env.PI_ORB_RUNTIME_PORT,
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

function makeProvider(extraEnv: Record<string, string> = {}): {
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
  });
  providers.push(provider);
  return { provider, root };
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
    expect((await provider.destroy(task, request.orbId, context)).isOk()).toBe(true);
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
    expect((await provider.start(task, first.value.ref, context)).isOk()).toBe(true);
    const reused = await provider.provision(task, request, context);
    expect(reused.isOk() && reused.value.runtimeTokenHash).toBe(first.value.runtimeTokenHash);
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
});
