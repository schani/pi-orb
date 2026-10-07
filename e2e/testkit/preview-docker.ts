import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTROL_PLANE_URL_ENV, RUNTIME_TOKEN_ENV } from "@pi-orb/protocol";
import { parseDockerLoopbackPort } from "../docker-port.ts";
import { docker } from "../harness.ts";
import { startPreviewSocketBridge } from "./preview-socket-bridge.ts";

export async function startPreviewDockerRuntime() {
  const name = `pi-orb-preview-fixture-${randomUUID()}`;
  const orbId = randomUUID();
  const token = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), "pi-orb-preview-sockets-"));
  const unix = process.platform === "linux";
  const bridge = unix ? await startPreviewSocketBridge(join(directory, "runtime.sock")) : undefined;
  const args = [
    "create",
    "--name",
    name,
    "--label",
    `pi-orb.e2e-preview-owned=${name}`,
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=128m",
    "--tmpfs",
    "/workspace:rw,size=128m",
    ...(unix
      ? [
          "--network",
          "none",
          "--mount",
          `type=bind,source=${directory},target=/fixture`,
          "--env",
          "PREVIEW_FIXTURE_UNIX=1",
        ]
      : ["--publish", "127.0.0.1::8080"]),
    "--mount",
    `type=bind,source=${resolve("e2e")},target=/app/e2e,readonly`,
    "--env",
    `PREVIEW_FIXTURE_ORB=${orbId}`,
    "--env",
    `PREVIEW_FIXTURE_TOKEN=${token}`,
    "--entrypoint",
    "node",
    "pi-orb-preview-fixture:dev",
    "e2e/testkit/preview-docker-entry.ts",
  ];
  let child: ChildProcess | undefined;
  let logs = "";
  const start = () =>
    new Promise<void>((ready, reject) => {
      child = spawn("docker", ["start", "--attach", name], { stdio: ["ignore", "pipe", "pipe"] });
      const deadline = setTimeout(
        () => reject(new Error(`Preview Docker readiness deadline: ${logs}`)),
        30_000,
      );
      const dispose = () => clearTimeout(deadline);
      child.once("error", (cause) => {
        dispose();
        reject(cause);
      });
      child.once("exit", (code) => {
        dispose();
        reject(new Error(`Preview Docker exited ${code}: ${logs}`));
      });
      child.stderr?.on("data", (chunk) => {
        logs += String(chunk);
      });
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += String(chunk);
        logs += String(chunk);
        if (output.includes("preview-fixture-ready\n")) {
          dispose();
          ready();
        }
      });
    });
  try {
    await docker(args);
    await start();
    const publishedOrigin = async () =>
      `http://127.0.0.1:${parseDockerLoopbackPort(await docker(["port", name, "8080/tcp"]))._unsafeUnwrap()}`;
    let baseUrl = bridge?.origin ?? (await publishedOrigin());
    const info = (await (await fetch(`${baseUrl}/__fixture/info`)).json()) as { ports: number[] };
    return {
      name,
      orbId,
      token,
      get baseUrl() {
        return baseUrl;
      },
      ...(unix ? { brokerSocket: join(directory, "broker.sock") } : {}),
      ports: info.ports,
      logs: () => logs,
      info: async () =>
        (await fetch(`${baseUrl}/__fixture/info`)).json() as Promise<{
          requests: { path: string; headers: Record<string, string> }[];
          wrongRequests: number;
          frames: unknown[];
          active: boolean;
          runtimeInstanceId: string;
          executionId: string;
        }>,
      finishBinary: () => fetch(`${baseUrl}/__fixture/binary`, { method: "POST" }),
      event: (data: string) =>
        fetch(`${baseUrl}/__fixture/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data }),
        }),
      update: (value: string) =>
        fetch(`${baseUrl}/__fixture/vite`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value }),
        }),
      cli: (brokerPort: number, command: string[]) =>
        docker([
          "exec",
          "--env",
          `${CONTROL_PLANE_URL_ENV}=${unix ? "http://127.0.0.1:8081" : `http://host.docker.internal:${brokerPort}`}`,
          "--env",
          `${RUNTIME_TOKEN_ENV}=${token}`,
          name,
          "pi-orb",
          ...command,
        ]),
      restart: async () => {
        await docker(["stop", "--time", "1", name]);
        await start();
        if (!unix) baseUrl = await publishedOrigin();
      },
      close: async () => {
        await docker(["rm", "--force", name]);
        await bridge?.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await docker(["rm", "--force", name]).catch(() => undefined);
    await bridge?.close();
    await rm(directory, { recursive: true, force: true });
    throw new Error(
      `Preview Docker fixture failed; socket errors: ${bridge?.errors.join(",") ?? "none"}; logs: ${logs}`,
      { cause },
    );
  }
}
