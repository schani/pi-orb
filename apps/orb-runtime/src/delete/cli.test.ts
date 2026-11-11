import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../testkit/cli.ts";

function run(args: string[], url: string, token = "cleanup-token") {
  return runCli(args, {
    env: { PATH: process.env.PATH, PI_ORB_CONTROL_PLANE_URL: url, PI_ORB_RUNTIME_TOKEN: token },
  });
}

describe.each([
  { action: "delete", state: "deleting", acknowledgement: "Deletion requested." },
  { action: "archive", state: "archiving", acknowledgement: "Archive requested." },
])("pi-orb $action CLI", ({ action, state, acknowledgement }) => {
  let server: Server;
  let url: string;
  let requests: number;
  let status: number;
  let payload: unknown;
  let disconnect: boolean;
  let target: { self: true } | { orbId: string };
  beforeEach(async () => {
    requests = 0;
    status = 202;
    payload = { orbId: "self", state };
    disconnect = false;
    target = { self: true };
    server = createServer((request, response) => {
      requests++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(`/runtime/v1/orb/${action}`);
      expect(request.headers.authorization).toBe("Bearer cleanup-token");
      if (disconnect) {
        request.socket.destroy();
        return;
      }
      expect(request.headers["content-type"]).toBe("application/json");
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        expect(JSON.parse(body)).toEqual(target);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      });
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
    const result = await run([action, "self"], url);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(acknowledgement);
    expect(result.stdout).toContain("permanently deleted");
    if (action === "archive") {
      expect(result.stdout).toContain("This turn may finish");
      expect(result.stdout).toContain("conversation retained");
    }
    expect(requests).toBe(1);
  });
  it("requires a target before making a request", async () => {
    const result = await run([action], url);
    expect(result).toMatchObject({ code: 2, stdout: "" });
    expect(requests).toBe(0);
  });
  it("targets an explicit descendant ID without implying this turn is affected", async () => {
    const orbId = "123e4567-e89b-42d3-a456-426614174000";
    target = { orbId };
    payload = { orbId, state };
    const result = await run([action, orbId], url);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(orbId);
    expect(result.stdout).not.toMatch(/this turn/i);
    expect(requests).toBe(1);
  });
  it.each([["child"], ["--yes"], ["--json"], ["self", "--recursive"]])(
    "rejects invalid targets %j before requesting cleanup",
    async (...args) => {
      const result = await run([action, ...args], url);
      expect(result).toMatchObject({ code: 2, stdout: "" });
      expect(requests).toBe(0);
    },
  );
  it("fails closed outside an orb", async () => {
    expect((await run([action, "self"], url, "")).code).toBe(2);
    expect((await run([action, "self"], "")).code).toBe(2);
    expect(requests).toBe(0);
  });
  it.each([
    [400, "invalid_request", 2],
    [401, "unauthorized", 3],
    [404, "not_found", 4],
    [409, "conflict", 4],
    [503, "unavailable", 6],
    [500, "internal", 7],
  ] as const)("reports typed HTTP %i failure", async (httpStatus, code, exit) => {
    status = httpStatus;
    const message = code === "invalid_request" ? `use pi-orb ${action} self` : "safe failure";
    payload = { error: { code, message, retryable: false } };
    const result = await run([action, "self"], url);
    expect(result.code).toBe(exit);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });
  it("rejects a malformed acknowledgement", async () => {
    payload = { state, detail: "private-token" };
    const result = await run([action, "self"], url);
    expect(result.code).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("acceptance is unknown");
    expect(result.stderr).not.toContain("private-token");
  });
  it("lists cleanup usage in dispatcher and inspection help", async () => {
    for (const args of [[], ["orbs", "one", "two"]]) {
      const result = await run(args, url);
      expect(result.stderr).toContain(`pi-orb ${action} <self|orb-id>`);
    }
    expect(requests).toBe(0);
  });
  it("does not turn a lost response into a false success or safe-failure claim", async () => {
    disconnect = true;
    const result = await run([action, "self"], url);
    expect(result.code).toBe(6);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("acceptance is unknown");
    expect(result.stderr).not.toContain("cleanup-token");
    expect(requests).toBe(1);
  });
});
