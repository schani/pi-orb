import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROJECT_SECRETS_RUNTIME_PATH } from "@pi-orb/protocol";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { fetchProjectSecretSnapshot, fetchProjectSecretSnapshotAtBoot } from "./endpoint.ts";

let server: Server;
let env: BrokerEnv;
const authorizations: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    authorizations.push(String(request.headers.authorization));
    if (request.url !== PROJECT_SECRETS_RUNTIME_PATH || request.method !== "GET") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ revision: 3, values: { NPM_TOKEN: "runtime-secret" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  env = { controlPlaneUrl: `http://127.0.0.1:${port}`, runtimeToken: "runtime-bearer" };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("project-secret boot snapshot endpoint", () => {
  it("fetches one closed snapshot with the incarnation bearer", async () => {
    const result = await fetchProjectSecretSnapshot(env);
    expect(result.isOk() && result.value).toEqual({
      revision: 3,
      values: { NPM_TOKEN: "runtime-secret" },
    });
    expect(authorizations.at(-1)).toBe("Bearer runtime-bearer");
  });

  it("retries bounded bootstrap authorization/schema races", async () => {
    let attempts = 0;
    const warming = createServer((_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        response.writeHead(attempts === 1 ? 401 : 503, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revision: 1, values: { TOKEN: "ready" } }));
    });
    onTestFinished(async () => {
      warming.closeAllConnections();
      await new Promise<void>((resolve) => warming.close(() => resolve()));
    });
    await new Promise<void>((resolve) => warming.listen(0, "127.0.0.1", resolve));
    const { port } = warming.address() as AddressInfo;
    let now = 0;
    const result = await fetchProjectSecretSnapshotAtBoot(
      { controlPlaneUrl: `http://127.0.0.1:${port}`, runtimeToken: "runtime-bearer" },
      {
        retryWindowMs: 3_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(result.isOk() && result.value.values).toEqual({ TOKEN: "ready" });
    expect(attempts).toBe(3);
  });

  it("stops a permanent outage at the explicit boot budget", async () => {
    const attempts: number[] = [];
    let now = 0;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts.push(now);
      return new Response("{}", { status: 503 });
    });
    onTestFinished(() => request.mockRestore());
    const result = await fetchProjectSecretSnapshotAtBoot(
      { controlPlaneUrl: "http://control.test", runtimeToken: "test" },
      {
        retryWindowMs: 3_000,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          expect(now).toBeLessThanOrEqual(3_000);
        },
      },
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: "project_secret_fetch_error",
      code: "unavailable",
      retryable: true,
    });
    expect(now).toBe(3_000);
    expect(attempts).toEqual([0, 1_000, 2_000, 3_000]);
  });

  it("fails typed on malformed success and transport errors", async () => {
    const malformed = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ revision: 1, values: { "bad-name": "secret" } }));
    });
    onTestFinished(async () => {
      malformed.closeAllConnections();
      await new Promise<void>((resolve) => malformed.close(() => resolve()));
    });
    await new Promise<void>((resolve) => malformed.listen(0, "127.0.0.1", resolve));
    const { port } = malformed.address() as AddressInfo;
    const bad = await fetchProjectSecretSnapshot({
      controlPlaneUrl: `http://127.0.0.1:${port}`,
      runtimeToken: "runtime-bearer",
    });
    expect(bad.isErr() && bad.error.code).toBe("invalid_response");
    const rejection = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("owned rejection"));
    onTestFinished(() => rejection.mockRestore());
    const unavailable = await fetchProjectSecretSnapshot({
      controlPlaneUrl: "http://control.test",
      runtimeToken: "runtime-bearer",
    });
    expect(unavailable.isErr() && unavailable.error.code).toBe("unavailable");
  });
});
