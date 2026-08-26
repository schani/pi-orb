import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { ID_TOKEN_PATH } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrokerEnv } from "../broker/endpoint.ts";
import { HttpIdTokenEndpoint, MINT_REQUEST_TIMEOUT_MS } from "./endpoint.ts";
import { CLI_ID_TOKEN_CONSTANTS, type IdTokenEndpointResult } from "./token.ts";

/**
 * Transport mapping against a real HTTP server: statuses, the declared error
 * envelope, `Retry-After`, and malformed bodies. The scripted reply is chosen
 * by the requested audience so one server serves every case.
 */

interface Reply {
  readonly status: number;
  readonly body: string;
  readonly retryAfter?: string;
}

const replies: Record<string, Reply> = {
  ok: { status: 200, body: JSON.stringify({ token: "header.body.signature" }) },
  "malformed-ok": { status: 200, body: JSON.stringify({ jwt: "not the declared field" }) },
  "not-json": { status: 200, body: "<html>proxy</html>" },
  bad: {
    status: 400,
    body: JSON.stringify({ error: "invalid_request", message: "audience too long" }),
  },
  denied: { status: 401, body: JSON.stringify({ error: "unauthorized" }) },
  stopped: {
    status: 403,
    body: JSON.stringify({ error: "not_mintable", message: "orb state stopped may not mint" }),
  },
  throttled: {
    status: 429,
    body: JSON.stringify({ error: "rate_limited", retryAfterMs: 1_500 }),
    retryAfter: "2",
  },
  "throttled-header-only": { status: 429, body: "nonsense", retryAfter: "3" },
  down: {
    status: 503,
    body: JSON.stringify({ error: "retryable", message: "signing keys unavailable" }),
  },
  bug: { status: 500, body: JSON.stringify({ error: "internal", message: "store invariant" }) },
  "gateway-html": { status: 502, body: "<html>bad gateway</html>" },
};

let server: Server;
let env: BrokerEnv;
const seenAuthorization: string[] = [];
const seenBodies: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      seenAuthorization.push(String(request.headers.authorization));
      seenBodies.push(raw);
      if (request.url !== ID_TOKEN_PATH || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const audience = (JSON.parse(raw) as { audience: string }).audience;
      const reply = replies[audience] ?? { status: 418, body: "{}" };
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.retryAfter === undefined ? {} : { "retry-after": reply.retryAfter }),
      });
      response.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  env = { controlPlaneUrl: `http://127.0.0.1:${port}`, runtimeToken: "runtime-bearer" };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function mint(audience: string, ttlSeconds?: number): Promise<IdTokenEndpointResult> {
  const endpoint = new HttpIdTokenEndpoint(env);
  return await endpoint.mint(
    new NoSimulationTask("id-token-endpoint-test", false),
    ttlSeconds === undefined ? { audience } : { audience, ttlSeconds },
  );
}

describe("id-token HTTP endpoint", () => {
  it("sends the bearer and only the caller's audience and lifetime", async () => {
    seenAuthorization.length = 0;
    seenBodies.length = 0;
    expect(await mint("ok", 120)).toEqual({ kind: "token", token: "header.body.signature" });
    expect(seenAuthorization).toEqual(["Bearer runtime-bearer"]);
    expect(JSON.parse(seenBodies[0] ?? "{}")).toEqual({ audience: "ok", ttlSeconds: 120 });
  });

  it("omits ttlSeconds when the caller asked for the default lifetime", async () => {
    seenBodies.length = 0;
    expect((await mint("ok")).kind).toBe("token");
    expect(JSON.parse(seenBodies[0] ?? "{}")).toEqual({ audience: "ok" });
  });

  it("maps each declared error code", async () => {
    expect(await mint("bad")).toEqual({ kind: "invalid_request", message: "audience too long" });
    expect(await mint("denied")).toEqual({ kind: "unauthorized" });
    expect(await mint("stopped")).toEqual({
      kind: "not_mintable",
      message: "orb state stopped may not mint",
    });
    expect(await mint("throttled")).toEqual({ kind: "rate_limited", retryAfterMs: 1_500 });
    expect(await mint("down")).toEqual({
      kind: "retryable",
      message: "signing keys unavailable",
    });
    expect(await mint("bug")).toEqual({ kind: "internal", message: "store invariant" });
  });

  it("treats a malformed success body as a bug, never as a token", async () => {
    expect(await mint("malformed-ok")).toEqual({
      kind: "internal",
      message: "malformed mint response",
    });
    expect(await mint("not-json")).toEqual({
      kind: "internal",
      message: "malformed mint response",
    });
  });

  it("falls back to the status when the error body is not the declared envelope", async () => {
    expect(await mint("throttled-header-only")).toEqual({
      kind: "rate_limited",
      retryAfterMs: 3_000,
    });
    expect(await mint("gateway-html")).toEqual({
      kind: "retryable",
      message: "control plane HTTP 502",
    });
  });

  it("gives up on a control plane that accepts the connection and never answers", async () => {
    // The worst failure for an executable credential source is not an error,
    // it is a hang: the SDK calling `pi-orb id-token` waits on a socket that a
    // half-dead control plane will never write to. The upper bound is enforced
    // by the suite's own test timeout — if the request were unbounded this test
    // could not pass at all — so nothing here is asserted against wall time
    // except the lower bound. That bound carries one millisecond of slack: the
    // deadline is armed on libuv's event-loop clock, whose start time is
    // truncated to whole milliseconds, while `Date.now()` reads the wall clock,
    // so a correctly armed timer can legitimately measure one millisecond
    // short (observed under full-suite load: 2999 for a 3000 ms deadline).
    const sockets: Socket[] = [];
    const silent = createServer(() => {
      // Accepted, parsed, and deliberately never answered.
    });
    silent.on("connection", (socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    const endpoint = new HttpIdTokenEndpoint({
      controlPlaneUrl: `http://127.0.0.1:${port}`,
      runtimeToken: "runtime-bearer",
    });

    const startedAt = Date.now();
    const outcome = await endpoint.mint(new NoSimulationTask("silent", false), { audience: "ok" });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toEqual({
      kind: "retryable",
      message: `control plane did not answer within ${MINT_REQUEST_TIMEOUT_MS}ms`,
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(MINT_REQUEST_TIMEOUT_MS - 1);

    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  });

  it("leaves room in the CLI's budget for a retry after one timeout", () => {
    // The timeout is the transport's share of `retryWindowMs`, not the whole
    // of it: a single non-answering attempt must not exhaust the invocation.
    expect(MINT_REQUEST_TIMEOUT_MS).toBeLessThan(CLI_ID_TOKEN_CONSTANTS.retryWindowMs / 2);
  });

  it("maps an unreachable control plane to a retryable outcome, never a throw", async () => {
    const endpoint = new HttpIdTokenEndpoint({
      // Port 1 on loopback: nothing listens, so the connection is refused.
      controlPlaneUrl: "http://127.0.0.1:1",
      runtimeToken: "runtime-bearer",
    });
    const outcome = await endpoint.mint(new NoSimulationTask("unreachable", false), {
      audience: "ok",
    });
    expect(outcome.kind).toBe("retryable");
  });
});
