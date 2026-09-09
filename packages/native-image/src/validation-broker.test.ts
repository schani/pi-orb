import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_RUNTIME_PATH,
  McpCatalogSchema,
  ProjectSecretSnapshotSchema,
  TokenGrantSchema,
} from "@pi-orb/protocol";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { validationBrokerSource } from "./validation-broker.ts";

const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    if (child.exitCode === null) await once(child, "exit");
  }
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("validation broker", () => {
  it("serves only the runtime boot contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-orb-validation-broker-"));
    directories.push(directory);
    const source = `${directory}/broker.mjs`;
    const marker = `${directory}/unrecognized`;
    await writeFile(source, validationBrokerSource("runtime-token"));
    const child = spawn(process.execPath, [source], {
      env: {
        ...process.env,
        PI_ORB_VALIDATION_BROKER_PORT: "0",
        PI_ORB_VALIDATION_BROKER_MARKER: marker,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    const [listening] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("validation broker exited before listening");
      }),
    ]);
    expect(listening).toMatchObject({ port: expect.any(Number) });
    const port = listening.port as number;
    expect(port).toBeGreaterThan(0);
    const request = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { authorization: "Bearer runtime-token", ...init.headers },
      });
    const secrets = await request("/runtime/v1/project-secrets");
    expect(secrets.status).toBe(200);
    expect(Check(ProjectSecretSnapshotSchema, await secrets.json())).toBe(true);
    const mcp = await request(MCP_RUNTIME_PATH);
    expect(mcp.status).toBe(200);
    const catalog = await mcp.json();
    expect(Check(McpCatalogSchema, catalog)).toBe(true);
    expect(catalog).toEqual({ revision: 0, servers: [] });

    const grant = await request("/runtime/v1/tokens/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "startup" }),
    });
    expect(grant.status).toBe(200);
    expect(Check(TokenGrantSchema, await grant.json())).toBe(true);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/runtime/v1/project-secrets`);
    expect(unauthorized.status).toBe(401);
    const unauthorizedMcp = await fetch(`http://127.0.0.1:${port}${MCP_RUNTIME_PATH}`);
    expect(unauthorizedMcp.status).toBe(401);
    const unknown = await request("/runtime/v1/tokens/github", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await readFile(marker, "utf8")).toBe("POST /runtime/v1/tokens/github\n");
  });
});
