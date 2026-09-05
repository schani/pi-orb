import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../../docker/pi-orb");
function run(args: string[], url: string, token = "archive-token") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, PI_ORB_CONTROL_PLANE_URL: url, PI_ORB_RUNTIME_TOKEN: token },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("pi-orb archive CLI", () => {
  let server: Server;
  let url: string;
  let requests: number;
  let status: number;
  let payload: unknown;
  let disconnect: boolean;
  beforeEach(async () => {
    requests = 0;
    status = 202;
    payload = { orbId: "self", state: "archiving" };
    disconnect = false;
    server = createServer((request, response) => {
      requests++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/runtime/v1/orb/archive");
      expect(request.headers.authorization).toBe("Bearer archive-token");
      if (disconnect) {
        request.socket.destroy();
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("acknowledges acceptance, not completion", async () => {
    const result = await run(["archive"], url);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Archive requested.");
    expect(result.stdout).toContain("permanently deleted");
    expect(requests).toBe(1);
  });
  it.each([
    ["archive", "sibling"],
    ["archive", "--yes"],
    ["archive", "--json"],
  ])("rejects extra arguments %j", async (...args) => {
    const result = await run(args, url);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(requests).toBe(0);
  });
  it("fails closed outside an orb", async () => {
    expect((await run(["archive"], url, "")).code).toBe(2);
    expect(requests).toBe(0);
  });
  it.each([
    [401, "unauthorized", 3],
    [409, "conflict", 4],
    [503, "unavailable", 6],
    [500, "internal", 7],
  ] as const)("reports typed HTTP %i failure", async (httpStatus, code, exit) => {
    status = httpStatus;
    payload = { error: { code, message: "safe failure", retryable: false } };
    const result = await run(["archive"], url);
    expect(result.code).toBe(exit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("safe failure");
  });
  it("does not turn a lost response into a false success or safe-failure claim", async () => {
    disconnect = true;
    const result = await run(["archive"], url);
    expect(result.code).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("acceptance is unknown");
    expect(result.stderr).not.toContain("archive-token");
    expect(requests).toBe(1);
  });
});
