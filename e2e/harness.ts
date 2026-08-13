import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_ORIGIN = process.env["PI_ORB_FAKE_OPENAI"] ?? "https://fake-openai.flingit.run";

export interface FakeSession {
  sessionKey: string;
  oauthBaseUrl: string;
  inferenceBaseUrl: string;
}

const controlUrl = (sessionKey: string, path = ""): string =>
  `${FAKE_ORIGIN}/api/__mock__/sessions/${sessionKey}${path}`;

export async function createFakeSession(name: string, scenario: unknown): Promise<FakeSession> {
  const response = await fetch(`${FAKE_ORIGIN}/api/__mock__/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, scenario }),
  });
  if (!response.ok) throw new Error(`fake session creation failed: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  return {
    sessionKey: String(body["sessionKey"]),
    oauthBaseUrl: String(body["oauthBaseUrl"]),
    inferenceBaseUrl: String(body["inferenceBaseUrl"]),
  };
}

export async function fakeControl(
  sessionKey: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(controlUrl(sessionKey, path), {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`fake control ${path} failed: HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

export async function deleteFakeSession(sessionKey: string): Promise<void> {
  await fetch(controlUrl(sessionKey), { method: "DELETE" }).catch(() => undefined);
}

export function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, maxBuffer: 16e6 }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`docker ${args[0]}: ${stderr || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * Every container of one orb, any incarnation, by the Docker provider's orb
 * label (container names carry an `-i<incarnation>` suffix, so name-based
 * lookups go stale across compute replacement).
 */
export async function orbContainerNames(orbId: string): Promise<string[]> {
  const names = await docker([
    "ps",
    "--all",
    "--filter",
    `label=pi-orb.orb-id=${orbId}`,
    "--format",
    "{{.Names}}",
  ]);
  return names
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Best-effort cleanup of one orb's containers across all incarnations. */
export async function removeOrbContainers(orbId: string): Promise<void> {
  const names = await orbContainerNames(orbId).catch(() => [] as string[]);
  for (const name of names) {
    await docker(["rm", "-f", name]).catch(() => undefined);
  }
}

/** Thrown by a probe to abort a waitFor immediately instead of retrying. */
export class FatalProbeError extends Error {}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const intervalMs = options?.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch((error: unknown) => {
      if (error instanceof FatalProbeError) throw error;
      return null;
    });
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface ControlPlaneHandle {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  authDir: string;
  logs: string[];
  stop(): Promise<void>;
}

export async function startControlPlane(options: {
  databaseUrl?: string;
  pglitePath?: string;
  processStateDirectory?: string;
  port: number;
  fake: FakeSession;
  nameFake?: FakeSession;
  dockerNetwork?: string;
  runtimeImage?: string;
  launchFailureMarker?: string;
  hostSpecGeneration?: number;
  e2eHostSpec?: string;
  authDir?: string;
}): Promise<ControlPlaneHandle> {
  const authDir = options.authDir ?? mkdtempSync(join(tmpdir(), "pi-orb-e2e-auth-"));
  const logs: string[] = [];
  const child = spawn("node", ["apps/control-plane/src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ...(options.pglitePath === undefined
        ? { DATABASE_URL: options.databaseUrl }
        : {
            PI_ORB_DATABASE_KIND: "pglite",
            PI_ORB_PGLITE_PATH: options.pglitePath,
            PI_ORB_HOST_PROVIDER: "process",
            PI_ORB_PROCESS_STATE_DIR: options.processStateDirectory,
          }),
      PORT: String(options.port),
      PI_ORB_AUTH_DIR: authDir,
      PI_ORB_RUNTIME_IMAGE: options.runtimeImage,
      PI_ORB_DOCKER_NETWORK: options.dockerNetwork,
      PI_ORB_E2E_LAUNCH_FAILURE_MARKER: options.launchFailureMarker,
      PI_ORB_HOST_SPEC_GENERATION: String(options.hostSpecGeneration ?? 0),
      PI_ORB_E2E_HOST_SPEC: options.e2eHostSpec,
      PI_ORB_FAKE_OPENAI_OAUTH_URL: options.fake.oauthBaseUrl,
      PI_ORB_FAKE_OPENAI_INFERENCE_URL: options.fake.inferenceBaseUrl,
      ...(options.nameFake === undefined
        ? {}
        : { PI_ORB_NAME_INFERENCE_URL: options.nameFake.inferenceBaseUrl }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  const baseUrl = `http://127.0.0.1:${options.port}`;
  await waitFor(
    "control plane HTTP",
    async () => {
      const response = await fetch(`${baseUrl}/api/v1/projects`);
      return response.ok ? true : null;
    },
    { timeoutMs: 30_000, intervalMs: 500 },
  );
  return {
    process: child,
    port: options.port,
    baseUrl,
    authDir,
    logs,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000).unref();
      }),
  };
}

export async function api(
  baseUrl: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}
