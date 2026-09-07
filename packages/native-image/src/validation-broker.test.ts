import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { ProjectSecretSnapshotSchema, TokenGrantSchema } from "@pi-orb/protocol";
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

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  server.close();
  await once(server, "close");
  return port;
}

describe("validation broker", () => {
  it("serves only the runtime boot contracts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-orb-validation-broker-"));
    directories.push(directory);
    const source = `${directory}/broker.mjs`;
    const marker = `${directory}/unrecognized`;
    const port = await unusedPort();
    await writeFile(source, validationBrokerSource("runtime-token"));
    const child = spawn(process.execPath, [source], {
      env: {
        ...process.env,
        PI_ORB_VALIDATION_BROKER_PORT: String(port),
        PI_ORB_VALIDATION_BROKER_MARKER: marker,
      },
      stdio: "ignore",
    });
    children.push(child);
    const request = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        headers: { authorization: "Bearer runtime-token", ...init.headers },
      });
    let secrets: Response | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      secrets = await request("/runtime/v1/project-secrets").catch(() => undefined);
      if (secrets !== undefined) break;
      await setTimeout(20);
    }
    expect(secrets?.status).toBe(200);
    expect(Check(ProjectSecretSnapshotSchema, await secrets?.json())).toBe(true);

    const grant = await request("/runtime/v1/tokens/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "startup" }),
    });
    expect(grant.status).toBe(200);
    expect(Check(TokenGrantSchema, await grant.json())).toBe(true);

    const unauthorized = await fetch(`http://127.0.0.1:${port}/runtime/v1/project-secrets`);
    expect(unauthorized.status).toBe(401);
    const unknown = await request("/runtime/v1/tokens/github", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);
    expect(await readFile(marker, "utf8")).toBe("POST /runtime/v1/tokens/github\n");
  });
});
