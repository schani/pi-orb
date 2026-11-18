import { channel } from "node:diagnostics_channel";
import { errorMonitor, once } from "node:events";
import { createServer, get, ServerResponse } from "node:http";
import { Socket } from "node:net";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { err, ok } from "neverthrow";
import { expect, it } from "vitest";
import { HttpDiagnostics, readFileDescriptorCount } from "./http-diagnostics.ts";

function fixture() {
  let now = 0;
  const samples: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let tick = () => {};
  let cancelled = false;
  const diagnostics = new HttpDiagnostics({
    projectId: "test-project",
    now: () => now,
    readFdCount: () => ok(27),
    emit: (sample) => {
      if (sample.message === "control-plane.http.transport") events.push(sample);
      else samples.push(sample);
    },
    createRuntime: () => ({ sample: () => ({}), [Symbol.dispose]: () => {} }),
    schedule: (callback) => {
      tick = callback;
      return () => {
        cancelled = true;
      };
    },
  });
  return {
    diagnostics,
    samples,
    events,
    [Symbol.dispose]: () => diagnostics[Symbol.dispose](),
    tick: () => tick(),
    time: (value: number) => {
      now = value;
    },
    cancelled: () => cancelled,
  };
}

it("reports half-closed socket ages and bounds trace-correlated abnormal events", () => {
  using f = fixture();
  const server = createServer();
  server.on("upgrade", () => {});
  f.diagnostics.observeServer(server);
  const socket = new Socket({ allowHalfOpen: true });
  server.emit("connection", socket);
  server.emit("upgrade", {}, socket, Buffer.alloc(0));
  Object.defineProperty(socket, "readableEnded", { value: true });
  f.time(20_000);
  for (let i = 0; i < 12; i++) {
    const response = new ServerResponse({ method: "GET" } as never);
    server.emit(
      "request",
      {
        url: "/api/private?secret=hidden",
        socket,
        headers: { "x-cloud-trace-context": "0123456789abcdef0123456789abcdef/123;o=1" },
      },
      response,
    );
    response.emit("close");
    response.emit("finish");
  }
  const events = f.events;
  expect(events).toHaveLength(10);
  expect(events[0]).toMatchObject({
    event: "response_closed_early",
    connection_id: 1,
    request_id: 1,
    request_kind: "public",
    headers_sent: false,
    writable_finished: false,
    readable_ended: true,
    writable_ended: false,
    socket_destroyed: false,
    "logging.googleapis.com/trace": "projects/test-project/traces/0123456789abcdef0123456789abcdef",
  });
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    inbound_half_closed_connections: 1,
    oldest_inbound_connection_ms: 20_000,
    oldest_upgraded_connection_ms: 20_000,
    responses_closed_early: 12,
    transport_events_suppressed: 2,
  });
  expect(JSON.stringify([...f.samples, ...f.events])).not.toMatch(/secret|private|123;o/);
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({ transport_events_suppressed: 0 });
  f.diagnostics[Symbol.dispose]();
  socket.destroy();
});

it("counts errors without exposing messages or allowing codes and trace headers to carry data", () => {
  using f = fixture();
  const server = createServer();
  server.on("clientError", () => {});
  f.diagnostics.observeServer(server);
  const socket = new Socket();
  socket.on("error", () => {});
  server.emit("connection", socket);
  socket.emit("error", Object.assign(new Error("secret address"), { code: "ECONNRESET" }));
  server.emit("clientError", Object.assign(new Error("secret packet"), { code: "secret" }), socket);
  const response = new ServerResponse({ method: "GET" } as never);
  server.emit(
    "request",
    { url: "/health", socket, headers: { "x-cloud-trace-context": "secret" } },
    response,
  );
  response.emit("close");
  expect(f.events[0]).toMatchObject({
    event: "socket_error",
    error_code: "ECONNRESET",
    connection_id: 1,
  });
  expect(f.events).toContainEqual(
    expect.objectContaining({ event: "client_error", error_code: "other" }),
  );
  expect(f.events.find((event) => event.event === "response_closed_early")).not.toHaveProperty(
    "logging.googleapis.com/trace",
  );
  expect(JSON.stringify(f.events)).not.toContain("secret");
  f.diagnostics[Symbol.dispose]();
  socket.destroy();
});

it("emits details for 429 and 5xx responses while healthy responses remain aggregate-only", () => {
  using f = fixture();
  const server = createServer();
  f.diagnostics.observeServer(server);
  for (const status of [200, 404, 429, 503]) {
    const response = new ServerResponse({ method: "GET" } as never);
    response.statusCode = status;
    response.writeHead(status);
    server.emit("request", { url: "/", headers: {} }, response);
    response.emit("finish");
    response.emit("close");
  }
  expect(f.events).toHaveLength(2);
  expect(f.events[0]).toMatchObject({
    event: "response_finished",
    status_code: 429,
    headers_sent: true,
  });
  expect(f.events[1]).toMatchObject({
    event: "response_finished",
    status_code: 503,
    headers_sent: true,
  });
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    responses_finished: 4,
    responses_closed_early: 0,
    requests_in_flight: 0,
  });
});

it("samples stalled requests independently of health probes and cleans up once", () => {
  const f = fixture();
  const server = createServer();
  f.diagnostics.observeServer(server);
  const socket = new Socket();
  server.emit("connection", socket);
  const response = new ServerResponse({ method: "GET" } as never);
  server.emit("request", { url: "/private?secret=hidden" }, response);
  const health = new ServerResponse({ method: "GET" } as never);
  server.emit("request", { url: "/health" }, health);
  health.emit("finish");
  health.emit("close");
  f.time(30_000);
  f.tick();
  expect(f.samples[0]).toMatchObject({
    message: "control-plane.http",
    fd_count: 27,
    inbound_connections: 1,
    requests_in_flight: 1,
    oldest_request_ms: 30_000,
    public_requests_started: 1,
    last_public_request_age_ms: 30_000,
    interval_ms: 30_000,
    health_requests_started: 1,
    responses_finished: 1,
    responses_closed_early: 0,
  });
  expect(JSON.stringify(f.samples)).not.toContain("secret");
  f.time(60_000);
  f.tick();
  expect(f.samples[1]).toMatchObject({ oldest_request_ms: 60_000, public_requests_started: 0 });
  response.emit("close");
  response.emit("finish");
  socket.emit("close");
  f.tick();
  expect(f.samples[2]).toMatchObject({
    requests_in_flight: 0,
    inbound_connections: 0,
    oldest_request_ms: 0,
    public_requests_started: 0,
    responses_closed_early: 1,
  });
  f.diagnostics[Symbol.dispose]();
  expect(f.cancelled()).toBe(true);
  expect(server.listenerCount("request")).toBe(0);
  expect(server.listenerCount(errorMonitor)).toBe(0);
  socket.destroy();
});

it("counts upgraded and outbound sockets, preserves error handling, and detaches observers", () => {
  const f = fixture();
  const server = createServer();
  server.on("upgrade", () => {});
  f.diagnostics.observeServer(server);
  const inbound = new Socket();
  const outbound = new Socket();
  server.emit("connection", inbound);
  server.emit("upgrade", {}, inbound, Buffer.alloc(0));
  channel("net.client.socket").publish({ socket: outbound });
  expect(() => server.emit("error", new Error("private detail"))).toThrow("private detail");
  expect(() => outbound.emit("error", new Error("private address"))).toThrow("private address");
  f.tick();
  expect(f.samples[0]).toMatchObject({
    upgraded_connections: 1,
    outbound_connections: 1,
    server_errors: 1,
    socket_errors: 1,
  });
  expect(JSON.stringify(f.samples)).not.toContain("private");
  const closeListeners = inbound.listenerCount("close");
  f.diagnostics[Symbol.dispose]();
  expect(outbound.listenerCount(errorMonitor)).toBe(0);
  expect(inbound.listenerCount("close")).toBe(closeListeners - 1);
  const sampleCount = f.samples.length;
  f.diagnostics[Symbol.dispose]();
  channel("net.client.socket").publish({ socket: outbound });
  f.tick();
  expect(f.samples).toHaveLength(sampleCount);
  expect(outbound.listenerCount(errorMonitor)).toBe(0);
  inbound.destroy();
  outbound.destroy();
});

it("keeps telemetry failures from affecting requests", () => {
  using diagnostics = new HttpDiagnostics({
    readFdCount: () => err({ code: "unavailable" }),
    emit: () => {
      throw new Error("closed stdout");
    },
    schedule: () => () => {},
  });
  const server = createServer();
  diagnostics.observeServer(server);
  const response = new ServerResponse({ method: "GET" } as never);
  server.emit("request", { url: "/health", headers: {} }, response);
  expect(() => response.emit("close")).not.toThrow();
  expect(response.listenerCount("finish")).toBe(0);
  expect(() => diagnostics.sample()).not.toThrow();
  diagnostics[Symbol.dispose]();
});

it("observes real HTTP requests before routing and preserves malformed-request handling", async () => {
  const f = fixture();
  const app = Fastify();
  f.diagnostics.observeServer(app.server);
  app.get("/health", async () => ({ status: "ok" }));
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const request = get(`${address}/health`, { agent: false });
    const [response] = await once(request, "response");
    expect(response.statusCode).toBe(200);
    response.resume();
    await once(response, "end");
    const socket = new Socket();
    socket.connect(Number(new URL(address).port), "127.0.0.1");
    await once(socket, "connect");
    const data = once(socket, "data");
    socket.end("INVALID HTTP\r\n\r\n");
    expect(String((await data)[0])).toContain("400 Bad Request");
    socket.destroy();
    f.tick();
    expect(f.samples[0]).toMatchObject({ health_requests_started: 1, client_errors: 1 });
  } finally {
    f.diagnostics[Symbol.dispose]();
    await app.close();
  }
});

it("reads descriptor counts without returning descriptor targets", () => {
  const result = readFileDescriptorCount();
  if (process.platform === "linux" || process.platform === "darwin") {
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeGreaterThan(0);
  }
});

it("does not enable upgrades or replace Node's parser-error handling", () => {
  const f = fixture();
  const server = createServer();
  f.diagnostics.observeServer(server);
  expect(server.listenerCount("upgrade")).toBe(0);
  expect(server.listenerCount("clientError")).toBe(0);
  f.diagnostics[Symbol.dispose]();
});

it("counts real TCP sockets until both ends close", async () => {
  const f = fixture();
  const server = createServer();
  f.diagnostics.observeServer(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  const accepted = once(server, "connection");
  const client = new Socket();
  try {
    const connected = once(client, "connect");
    client.connect(address.port, "127.0.0.1");
    const [[peer]] = await Promise.all([accepted, connected]);
    f.tick();
    expect(f.samples[0]).toMatchObject({
      listening: 1,
      inbound_connections: 1,
      outbound_connections: 1,
    });
    const closed = Promise.all([once(client, "close"), once(peer, "close")]);
    client.destroy();
    peer.destroy();
    await closed;
    f.tick();
    expect(f.samples[1]).toMatchObject({ inbound_connections: 0, outbound_connections: 0 });
  } finally {
    client.destroy();
    f.diagnostics[Symbol.dispose]();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("reports an unavailable descriptor sample without inventing a zero", () => {
  const samples: Record<string, unknown>[] = [];
  using diagnostics = new HttpDiagnostics({
    readFdCount: () => err({ code: "unavailable" }),
    emit: (sample) => {
      samples.push(sample);
    },
    schedule: () => () => {},
  });
  diagnostics.sample();
  expect(samples[0]).toMatchObject({
    fd_count: null,
    fd_sample_status: "unavailable",
    last_public_request_age_ms: -1,
  });
});

it("detaches upgrade observation before Fastify removes its protocol handler", async () => {
  const f = fixture();
  const app = Fastify();
  app.addHook("onReady", async () => f.diagnostics.observeServer(app.server));
  app.addHook("preClose", async () => f.diagnostics.stopObservingUpgrades());
  await app.register(websocket);
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  let continueClose!: () => void;
  const release = new Promise<void>((resolve) => {
    continueClose = resolve;
  });
  app.addHook("preClose", async () => {
    markReached();
    await release;
  });
  let closing: Promise<void> | undefined;
  try {
    await app.ready();
    expect(app.server.listenerCount("upgrade")).toBe(2);
    closing = app.close();
    await Promise.race([reached, closing]);
    expect(app.server.listenerCount("upgrade")).toBe(0);
  } finally {
    continueClose();
    f.diagnostics[Symbol.dispose]();
    await (closing ?? app.close());
  }
});
