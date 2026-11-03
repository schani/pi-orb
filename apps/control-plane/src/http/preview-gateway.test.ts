import { once } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { RUNTIME_SUBPROTOCOL } from "@pi-orb/protocol";
import { NoSimulationTask } from "determined";
import Fastify from "fastify";
import { ok, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { WebSocket } from "ws";
import { PreviewConnections } from "../domain/preview-connections.ts";
import { makeHarness, seedRunningOrb } from "../testkit/fixtures.ts";
import { previewRoutingUrl, registerPreviewGateway } from "./preview-gateway.ts";
import { createPreviewHosts, type PreviewHosts } from "./preview-host.ts";

it("preserves valid live input above the preview queue budget", async () => {
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.org",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.net",
  })._unsafeUnwrap();
  const app = Fastify();
  const h = makeHarness();
  const task = new NoSimulationTask("live-payload-contract", false);
  await registerPreviewGateway(app, task, {
    deps: h.deps,
    hosts,
    appOrigin: "https://app.example.com",
    connections: new PreviewConnections(h.deps, () => okAsync(undefined)),
    transport: {
      openHttp: () => {
        throw new Error("must not dial");
      },
      openWebSocket: () => {
        throw new Error("must not dial");
      },
    },
  });
  app.get("/live", { websocket: true }, (socket) => {
    socket.once("message", (bytes) =>
      socket.send(String(Buffer.isBuffer(bytes) ? bytes.byteLength : 0)),
    );
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new WebSocket(`${address.replace(/^http/u, "ws")}/live`, RUNTIME_SUBPROTOCOL, {
    headers: { host: "app.example.com" },
  });
  try {
    await once(client, "open");
    const outcome = new Promise<string>((resolve) => {
      client.once("message", (bytes) => resolve(String(bytes)));
      client.once("close", (code) => resolve(`closed:${code}`));
    });
    client.send(Buffer.alloc(2 * 1024 * 1024));
    expect(await outcome).toBe(String(2 * 1024 * 1024));
  } finally {
    client.terminate();
    await app.close();
  }
});

it("never dispatches preview WebSockets to a static application route", async () => {
  let routingHosts: PreviewHosts | undefined;
  const app = Fastify({ rewriteUrl: (request) => previewRoutingUrl(routingHosts, request) });
  const h = makeHarness();
  const task = new NoSimulationTask("preview-route-isolation", false);
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.org",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.net",
  })._unsafeUnwrap();
  routingHosts = hosts;
  app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request) => {
    request.previewIdentity = { expiresAt: Date.now() + 60000 } as never;
  });
  await registerPreviewGateway(app, task, {
    deps: h.deps,
    hosts,
    appOrigin: "https://app.example.com",
    connections: new PreviewConnections(h.deps, () => okAsync(undefined)),
    transport: {
      openHttp: () => {
        throw new Error("must not dial");
      },
      openWebSocket: () => {
        throw new Error("must not dial");
      },
    },
  });
  let applicationHandled = false;
  app.get("/api/v1/orbs/x/live", { websocket: true }, (socket) => {
    applicationHandled = true;
    socket.close(1000);
  });
  await app.ready();
  await expect(
    app.injectWS("/api/v1/orbs/x/live", {
      headers: {
        host: "p5173-o00000000-0000-0000-0000-000000000001.preview.example.org",
        origin: "https://p5173-o00000000-0000-0000-0000-000000000001.preview.example.org",
      },
    }),
  ).rejects.toThrow("Unexpected server response: 404");
  expect(applicationHandled).toBe(false);
  await app.close();
});

it("buffers bounded early browser application frames before the bridge starts", async () => {
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.org",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.net",
  })._unsafeUnwrap();
  const app = Fastify({ rewriteUrl: (request) => previewRoutingUrl(hosts, request) });
  const h = makeHarness();
  const task = new NoSimulationTask("early-preview-frame", false);
  const id = "00000000-0000-0000-0000-000000000001";
  seedRunningOrb(task, h, id);
  const orb = h.store.orbSnapshot(id)!;
  await h.store.registerPreview(task, {
    orbId: id,
    port: 5173,
    registrationId: "r1",
    caller: { runtimeTokenHash: orb.runtimeTokenHash!, hostIncarnation: 0 },
    now: task.wallNow(),
  });
  const health = h.deps.runtimeClient.health.bind(h.deps.runtimeClient);
  h.deps.runtimeClient.health = (task, url, context) =>
    health(task, url, context).map((value) =>
      value.status === "ready" ? { ...value, incarnation: 0, executionId: "boot" } : value,
    );
  app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request) => {
    request.previewIdentity = { expiresAt: Date.now() + 60000 } as never;
  });
  let received!: () => void;
  const firstMessage = new Promise<void>((resolve) => {
    received = resolve;
  });
  const frames: string[] = [];
  await registerPreviewGateway(app, task, {
    deps: h.deps,
    hosts,
    appOrigin: "https://app.example.com",
    connections: new PreviewConnections(h.deps, () =>
      ResultAsync.fromSafePromise(new Promise<void>(() => {})),
    ),
    transport: {
      openHttp: () => {
        throw new Error("must not dial");
      },
      openWebSocket: () =>
        okAsync({
          protocol: "",
          closeInfo: null,
          read: () => firstMessage.then(() => ok(null)),
          write: async (frame) => {
            frames.push(Buffer.from(frame.bytes).toString());
            return ok(undefined);
          },
          close: () => {},
        }),
    },
  });
  app.websocketServer.once("connection", (socket) => {
    socket.once("message", received);
  });
  await app.ready();
  const rawEvents = new IncomingMessage(new Socket());
  let closed!: Promise<number>;
  await app.injectWS(
    "/hmr",
    {
      once: rawEvents.once.bind(rawEvents),
      off: rawEvents.off.bind(rawEvents),
      rawHeaders: [
        "host",
        `p5173-o${id}.preview.example.org`,
        "origin",
        `https://p5173-o${id}.preview.example.org`,
      ],
      headers: {
        host: `p5173-o${id}.preview.example.org`,
        origin: `https://p5173-o${id}.preview.example.org`,
      },
    },
    {
      onInit: (socket: import("ws").WebSocket) => {
        closed = new Promise((resolve) => socket.once("close", resolve));
      },
      onOpen: (socket: import("ws").WebSocket) => socket.send("first"),
    },
  );
  expect(await closed).toBe(1006);
  expect(frames).toEqual(["first"]);
  await app.close();
});

it("preserves upstream protocol selection, ping/pong and normal close over real sockets", async () => {
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.org",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.net",
  })._unsafeUnwrap();
  const app = Fastify({ rewriteUrl: (request) => previewRoutingUrl(hosts, request) });
  const h = makeHarness();
  const task = new NoSimulationTask("preview-protocol", false);
  const id = "00000000-0000-0000-0000-000000000002";
  seedRunningOrb(task, h, id);
  const orb = h.store.orbSnapshot(id)!;
  await h.store.registerPreview(task, {
    orbId: id,
    port: 5173,
    registrationId: "r1",
    caller: { runtimeTokenHash: orb.runtimeTokenHash!, hostIncarnation: 0 },
    now: task.wallNow(),
  });
  const health = h.deps.runtimeClient.health.bind(h.deps.runtimeClient);
  h.deps.runtimeClient.health = (task, url, context) =>
    health(task, url, context).map((value) =>
      value.status === "ready" ? { ...value, incarnation: 0, executionId: "boot" } : value,
    );
  app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request) => {
    request.previewIdentity = { expiresAt: Date.now() + 60000 } as never;
  });
  let offered: readonly string[] = [];
  let closeCalls = 0;
  let forwardedFrames = 0;
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let disposed!: () => void;
  const disposal = new Promise<void>((resolve) => {
    disposed = resolve;
  });
  await registerPreviewGateway(app, task, {
    deps: h.deps,
    hosts,
    appOrigin: "https://app.example.com",
    connections: new PreviewConnections(h.deps, () =>
      ResultAsync.fromSafePromise(new Promise<void>(() => {})),
    ),
    transport: {
      openHttp: () => {
        throw new Error("must not dial");
      },
      openWebSocket: (_task, _route, _path, _headers, protocols) => {
        offered = protocols;
        return okAsync({
          protocol: "second",
          closeInfo: { code: 1000, reason: "complete" },
          read: () => completion.then(() => ok(null)),
          write: async () => {
            forwardedFrames++;
            return ok(undefined);
          },
          close: () => {
            closeCalls++;
            finish();
            disposed();
          },
        });
      },
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new WebSocket(`${address.replace(/^http/u, "ws")}/hmr`, ["first", "second"], {
    headers: {
      host: `p5173-o${id}.preview.example.org`,
      origin: `https://p5173-o${id}.preview.example.org`,
    },
  });
  const closed = once(client, "close");
  try {
    await once(client, "open");
    expect(client.protocol).toBe("second");
    expect(offered).toEqual(["first", "second"]);
    const pong = once(client, "pong");
    client.ping("probe");
    expect(String((await pong)[0])).toBe("probe");
    expect(forwardedFrames).toBe(0);
    finish();
    const [code, reason] = await closed;
    expect(code).toBe(1000);
    expect(String(reason)).toBe("complete");
    await disposal;
    expect(closeCalls).toBe(1);
  } finally {
    client.terminate();
    await app.close();
  }
});

it("preserves requested missing preview URL and returns a dashboard link without starting compute", async () => {
  const app = Fastify();
  const h = makeHarness();
  const task = new NoSimulationTask("preview-gateway-test", false);
  const hosts = createPreviewHosts({
    previewOrigin: "https://preview.example.org",
    appOrigin: "https://app.example.com",
    filesOrigin: "https://files.example.net",
  })._unsafeUnwrap();
  app.decorateRequest("previewIdentity", undefined);
  app.addHook("onRequest", async (request) => {
    request.previewIdentity = { userId: "test", expiresAt: Date.now() + 60000 } as never;
  });
  await registerPreviewGateway(app, task, {
    deps: h.deps,
    hosts,
    appOrigin: "https://app.example.com",
    connections: new PreviewConnections(h.deps, () => okAsync(undefined)),
    transport: {
      openHttp: () => {
        throw new Error("must not dial");
      },
      openWebSocket: () => {
        throw new Error("must not dial");
      },
    },
  });
  const response = await app.inject({
    url: "/deep?q=1",
    headers: {
      host: "p5173-o00000000-0000-0000-0000-000000000001.preview.example.org",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  expect(response.statusCode).toBe(404);
  expect(response.headers.location).toBeUndefined();
  expect(response.body).toContain("Orb doesn't exist");
  expect(response.body).toContain('href="https://app.example.com"');
  await app.close();
});
