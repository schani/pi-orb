import { channel } from "node:diagnostics_channel";
import { errorMonitor, once } from "node:events";
import { createServer, get, ServerResponse } from "node:http";
import { Socket } from "node:net";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { err, ok, type Result } from "neverthrow";
import { expect, it } from "vitest";
import { HttpDiagnostics, readFileDescriptorCount } from "./http-diagnostics.ts";

function fixture() {
  let now = 0;
  const samples: Record<string, unknown>[] = [];
  let tick = () => {};
  let cpuTick = () => {};
  let loopTick = () => {};
  let cpu: Result<{ process: number; main: number }, { code: "unavailable" }> = ok({
    process: 0,
    main: 0,
  });
  let cancelled = 0;
  const diagnostics = new HttpDiagnostics({
    now: () => now,
    readFdCount: () => ok(27),
    emit: (sample) => samples.push(sample),
    readCpu: () => cpu,
    schedule: (callback, interval) => {
      if (interval === 1_000) cpuTick = callback;
      else if (interval === 100) loopTick = callback;
      else tick = callback;
      return () => {
        cancelled++;
      };
    },
  });
  return {
    diagnostics,
    samples,
    cpu: (value: typeof cpu) => {
      cpu = value;
    },
    cpuTick: () => cpuTick(),
    loopTick: () => loopTick(),
    [Symbol.dispose]: () => diagnostics[Symbol.dispose](),
    tick: () => tick(),
    time: (value: number) => {
      now = value;
    },
    cancelled: () => cancelled,
  };
}

it("retains CPU peaks and event-loop delay, then resets each reporting window", () => {
  using f = fixture();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    process_cpu_peak_percent: null,
    main_cpu_peak_percent: null,
    event_loop_delay_max_ms: null,
  });
  f.time(700);
  f.loopTick();
  f.time(1_000);
  f.cpu(ok({ process: 1_800_000, main: 900_000 }));
  f.cpuTick();
  f.time(30_000);
  f.cpu(ok({ process: 3_000_000, main: 1_500_000 }));
  f.cpuTick();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    process_cpu_peak_percent: 180,
    main_cpu_peak_percent: 90,
    cpu_sample_max_interval_ms: 29_000,
    event_loop_delay_max_ms: 700,
  });
  f.time(31_000);
  f.cpu(ok({ process: 3_100_000, main: 1_550_000 }));
  f.cpuTick();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    process_cpu_peak_percent: 10,
    main_cpu_peak_percent: 5,
    cpu_sample_max_interval_ms: 1_000,
    event_loop_delay_max_ms: null,
  });
  f.diagnostics[Symbol.dispose]();
  f.diagnostics[Symbol.dispose]();
  expect(f.cancelled()).toBe(3);
});

it("captures a stall immediately after reporting without resetting the timing baseline", () => {
  using f = fixture();
  f.time(100);
  f.loopTick();
  f.tick();
  f.time(1_000);
  f.loopTick();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({ event_loop_delay_max_ms: 900 });
});

it("reestablishes the CPU baseline after an unavailable read", () => {
  using f = fixture();
  f.time(1_000);
  f.cpu(err({ code: "unavailable" }));
  f.cpuTick();
  f.time(2_000);
  f.cpu(ok({ process: 5_000_000, main: 2_000_000 }));
  f.cpuTick();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    process_cpu_peak_percent: null,
    main_cpu_peak_percent: null,
  });
  f.time(3_000);
  f.cpu(ok({ process: 5_100_000, main: 2_050_000 }));
  f.cpuTick();
  f.tick();
  expect(f.samples.at(-1)).toMatchObject({
    process_cpu_peak_percent: 10,
    main_cpu_peak_percent: 5,
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
  expect(f.cancelled()).toBe(3);
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
  const diagnostics = new HttpDiagnostics({
    readFdCount: () => err({ code: "unavailable" }),
    emit: () => {
      throw new Error("closed stdout");
    },
    schedule: () => () => {},
  });
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
