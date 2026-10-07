import { createHash, createHmac } from "node:crypto";
import { createServer, request } from "node:http";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { OrbAgent } from "../domain/orb-agent.ts";
import { RuntimePreviewService } from "../domain/preview.ts";
import { PreviewActivity } from "../domain/preview-activity.ts";
import { HmacPreviewVerifier } from "../preview/admission.ts";
import { registerPreviewRoutes } from "./preview-route.ts";

async function runtime(port: number, activity = new PreviewActivity()) {
  const target = {
    orbId: "orb",
    port,
    registrationId: "generation",
    incarnation: 2,
    executionId: "execution",
    runtimeInstanceId: "runtime",
  };
  const agent = {
    previewActivity: activity,
    runtimeInstanceId: "runtime",
    getHealth: () => ({ status: "ready", ...target }),
    gateView: () => ({ acceptingWork: true }),
  } as unknown as OrbAgent;
  const app = Fastify();
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  const service = new RuntimePreviewService({
    agent,
    orbId: "orb",
    verifier: new HmacPreviewVerifier("secret"),
    reservedPorts: () => [(app.server.address() as { port: number } | null)?.port ?? 0],
  });
  await app.register(async (scope) => registerPreviewRoutes(scope, service));
  await app.listen({ port: 0, host: "127.0.0.1" });
  function grant(overrides: object = {}, expiresAt = Date.now() + 10000) {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        target: { ...target, ...overrides },
        origin: "https://preview.example",
        expiresAt,
      }),
    ).toString("base64url");
    return `${payload}.${createHmac("sha256", createHash("sha256").update("secret").digest("hex")).update(`pi-orb-preview-admission-v1\n${payload}`).digest("base64url")}`;
  }
  return { app, service, grant, activity };
}

it("WS carries binary application data; ping/pong and silent HMR do not own idle", async () => {
  const upstreamHttp = createServer();
  const upstreamWs = new WebSocketServer({
    server: upstreamHttp,
    handleProtocols: (protocols) => (protocols.has("application-v1") ? "application-v1" : false),
  });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
  const port = (upstreamHttp.address() as { port: number }).port;
  let now = 0;
  const f = await runtime(port, new PreviewActivity(() => now));
  let applicationHeaders: import("node:http").IncomingHttpHeaders | undefined;
  const accepted = new Promise<WebSocket>((resolve) =>
    upstreamWs.once("connection", (socket, request) => {
      applicationHeaders = request.headers;
      resolve(socket);
    }),
  );
  const down = new WebSocket(
    `${f.app.listeningOrigin.replace("http", "ws")}/v1/preview/${port}`,
    ["unselected", "application-v1"],
    {
      headers: {
        "x-pi-orb-preview-admission": f.grant(),
        "x-pi-orb-preview-path": Buffer.from("/hmr?x=1").toString("base64url"),
        host: "spoof.example",
        "x-forwarded-host": "spoof.example",
        "x-forwarded-proto": "http",
        forwarded: "host=spoof.example;proto=http",
      },
    },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      down.once("open", resolve);
      down.once("error", reject);
    });
    expect(down.protocol).toBe("application-v1");
    const up = await accepted;
    expect(applicationHeaders?.host).toBe("preview.example");
    expect(applicationHeaders?.["x-forwarded-host"]).toBe("preview.example");
    expect(applicationHeaders?.["x-forwarded-proto"]).toBe("https");
    expect(applicationHeaders?.forwarded).toBeUndefined();
    const ready = new Promise<void>((resolve) => down.once("message", () => resolve()));
    up.send("ready");
    await ready; // The upstream upgrade has reached the runtime before advancing the clock.
    now = 15001;
    expect(f.activity.blocksIdle()).toBe(false);
    await new Promise<void>((resolve) => {
      down.once("pong", () => resolve());
      down.ping("heartbeat");
    });
    expect(f.activity.blocksIdle()).toBe(false);
    const received = new Promise<void>((resolve) =>
      up.once("message", (bytes, binary) => {
        expect(binary).toBe(true);
        expect(bytes).toEqual(Buffer.from([0, 255]));
        resolve();
      }),
    );
    down.send(Buffer.from([0, 255]));
    await received;
    expect(f.activity.blocksIdle()).toBe(true);
    const echoed = new Promise<void>((resolve) =>
      down.once("message", (bytes, binary) => {
        expect(binary).toBe(false);
        expect(bytes.toString()).toBe("application");
        resolve();
      }),
    );
    up.send("application");
    await echoed;
    const closed = new Promise<number>((resolve) => down.once("close", (code) => resolve(code)));
    up.close(1000, "done");
    expect(await closed).toBe(1000);
  } finally {
    down.terminate();
    f.service.closeAll();
    await f.app.close();
    for (const client of upstreamWs.clients) client.terminate();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
  }
});

it("oversized WS frames terminate bounded forwarding without reaching the application", async () => {
  const upstreamHttp = createServer();
  const upstreamWs = new WebSocketServer({ server: upstreamHttp });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
  const port = (upstreamHttp.address() as { port: number }).port;
  const f = await runtime(port);
  let frames = 0;
  upstreamWs.on("connection", (socket) => {
    socket.on("message", () => frames++);
    socket.send("ready");
  });
  const down = new WebSocket(`${f.app.listeningOrigin.replace("http", "ws")}/v1/preview/${port}`, {
    headers: {
      "x-pi-orb-preview-admission": f.grant(),
      "x-pi-orb-preview-path": Buffer.from("/").toString("base64url"),
    },
  });
  down.on("error", () => undefined);
  try {
    await new Promise<void>((resolve) => down.once("message", () => resolve()));
    const closed = new Promise<void>((resolve) => down.once("close", () => resolve()));
    down.send(Buffer.alloc(1024 * 1024 + 1));
    await closed;
    expect(frames).toBe(0);
  } finally {
    down.terminate();
    f.service.closeAll();
    await f.app.close();
    for (const socket of upstreamWs.clients) socket.terminate();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
  }
});

it("rejects spoofed, expired, wrong-identity and runtime-listener grants without dialing", async () => {
  let requests = 0;
  const upstream = createServer((_req, res) => {
    requests++;
    res.end("unexpected");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const f = await runtime(port);
  try {
    for (const grant of [
      "spoofed",
      f.grant({}, Date.now() - 1),
      f.grant({ executionId: "other" }),
      f.grant({ incarnation: 3 }),
      f.grant({ runtimeInstanceId: "other" }),
      f.grant({ port: port + 1 }),
      f.grant({ orbId: "other" }),
    ]) {
      const response = await f.app.inject({
        url: `/v1/preview/${port}`,
        headers: {
          "x-pi-orb-preview-admission": grant,
          "x-pi-orb-preview-path": Buffer.from("/").toString("base64url"),
        },
      });
      expect([401, 409]).toContain(response.statusCode);
      expect(["unauthenticated", "stale_target"]).toContain(
        response.headers["x-pi-orb-preview-error"],
      );
    }
    const listener = (f.app.server.address() as { port: number }).port;
    expect(
      (
        await f.app.inject({
          url: `/v1/preview/${listener}`,
          headers: {
            "x-pi-orb-preview-admission": f.grant({ port: listener }),
            "x-pi-orb-preview-path": Buffer.from("/").toString("base64url"),
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(requests).toBe(0);
  } finally {
    await f.app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("fixed HTTP ingress preserves raw dot paths and strips spoofed platform errors", async () => {
  const paths: string[] = [];
  const upstream = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.writeHead(502, { "x-pi-orb-preview-error": "unauthenticated" });
    res.end("application 502");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  const f = await runtime(port);
  try {
    for (const path of [
      "/../../v1/history?x=%2F",
      "/%2e%2e/%2E./v1/history",
      "//other.example/raw?x=1",
    ]) {
      const response = await f.app.inject({
        url: `/v1/preview/${port}`,
        headers: {
          "x-pi-orb-preview-admission": f.grant(),
          "x-pi-orb-preview-path": Buffer.from(path).toString("base64url"),
        },
      });
      expect(response.statusCode).toBe(502);
      expect(response.body).toBe("application 502");
      expect(response.headers["x-pi-orb-preview-error"]).toBeUndefined();
      expect(paths.at(-1)).toBe(path);
    }
    const before = paths.length;
    for (const path of [
      undefined,
      "!!",
      "Lw==",
      Buffer.from("relative").toString("base64url"),
      Buffer.from("/x\r\nInjected: y").toString("base64url"),
      Buffer.from("/\0").toString("base64url"),
      Buffer.from("/\u0085").toString("base64url"),
      Buffer.from("\ufeff/path").toString("base64url"),
      "A".repeat(16385),
      Buffer.from([47, 255]).toString("base64url"),
    ]) {
      const response = await f.app.inject({
        url: `/v1/preview/${port}`,
        headers: {
          "x-pi-orb-preview-admission": f.grant(),
          ...(path === undefined ? {} : { "x-pi-orb-preview-path": path }),
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["x-pi-orb-preview-error"]).toBe("invalid_request");
    }
    expect(paths.length).toBe(before);
    expect(
      (
        await f.app.inject({
          url: `/v1/preview/${port}/old`,
          headers: { "x-pi-orb-preview-admission": f.grant() },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await f.app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

it("fixed WS ingress delivers original dot path without URL normalization", async () => {
  const upstreamHttp = createServer();
  const upstreamWs = new WebSocketServer({ server: upstreamHttp });
  await new Promise<void>((resolve) => upstreamHttp.listen(0, "127.0.0.1", resolve));
  const port = (upstreamHttp.address() as { port: number }).port;
  const f = await runtime(port);
  const path = "/../../v1/history?dot=%2e%2e";
  const accepted = new Promise<string | undefined>((resolve) =>
    upstreamWs.once("connection", (_socket, request) => resolve(request.url)),
  );
  const down = new WebSocket(`${f.app.listeningOrigin.replace("http", "ws")}/v1/preview/${port}`, {
    headers: {
      "x-pi-orb-preview-admission": f.grant(),
      "x-pi-orb-preview-path": Buffer.from(path).toString("base64url"),
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      down.once("open", resolve);
      down.once("error", reject);
    });
    expect(await accepted).toBe(path);
  } finally {
    down.terminate();
    f.service.closeAll();
    await f.app.close();
    for (const socket of upstreamWs.clients) socket.terminate();
    await new Promise<void>((resolve) => upstreamWs.close(() => resolve()));
    await new Promise<void>((resolve) => upstreamHttp.close(() => resolve()));
  }
});

it("intentional Stop aborts an upload blocked by upstream backpressure and releases HTTP ownership", async () => {
  let accept: (() => void) | undefined;
  const seen = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const upstream = createServer((req) => {
    req.pause();
    accept?.();
  });
  const sockets = new Set<import("node:net").Socket>();
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  let now = 0;
  const f = await runtime(port, new PreviewActivity(() => now));
  const req = request(`${f.app.listeningOrigin}/v1/preview/${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-pi-orb-preview-admission": f.grant(),
      "x-pi-orb-preview-path": Buffer.from("/upload").toString("base64url"),
    },
  });
  const closed = new Promise<void>((resolve) => {
    req.once("close", resolve);
    req.on("error", () => undefined);
  });
  try {
    req.write(Buffer.alloc(1024 * 1024));
    await seen;
    expect(f.activity.blocksIdle()).toBe(true);
    f.service.closeAll();
    await closed;
    now = 15001;
    expect(f.activity.blocksIdle()).toBe(false);
  } finally {
    req.destroy();
    f.service.closeAll();
    await f.app.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
