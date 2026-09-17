import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../../docker/pi-orb");
function run(args: string[], url: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cli, args, {
      env: { ...process.env, PI_ORB_CONTROL_PLANE_URL: url, PI_ORB_RUNTIME_TOKEN: "sleep-token" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("pi-orb sleep CLI", () => {
  let server: Server;
  let url: string;
  let requests: number;
  beforeEach(async () => {
    requests = 0;
    server = createServer((request, response) => {
      requests++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/runtime/v1/orb/sleep");
      expect(request.headers.authorization).toBe("Bearer sleep-token");
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk));
      request.on("end", () => {
        expect(JSON.parse(body)).toEqual({ v: 1, durationSeconds: 3600 });
        response.writeHead(202, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            v: 1,
            sleepId: "11111111-1111-4111-8111-111111111111",
            sleepUntil: "2026-09-18T04:05:06.000Z",
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no test port");
    url = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  it("dispatches one self-sleep request and prints its deadline", async () => {
    const result = await run(["sleep", "1h"], url);
    expect(result).toEqual({
      code: 0,
      stdout: "Sleep scheduled until 2026-09-18T04:05:06.000Z.\n",
      stderr: "",
    });
    expect(requests).toBe(1);
  });

  it("rejects malformed durations before HTTP", async () => {
    const result = await run(["sleep", "soon"], url);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: pi-orb sleep");
    expect(requests).toBe(0);
  });
});
