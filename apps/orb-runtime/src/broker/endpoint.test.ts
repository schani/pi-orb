import { createServer } from "node:http";
import { NoSimulationTask } from "determined";
import { expect, it, vi } from "vitest";
import { HttpBrokerEndpoint } from "./endpoint.ts";

it("status-only errors drain response cancellation before releasing ownership", async () => {
  let entered = () => {};
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let drained = false;
  const response = new Response(
    new ReadableStream({
      cancel: async () => {
        entered();
        await gate;
        drained = true;
      },
    }),
    { status: 401 },
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const endpoint = new HttpBrokerEndpoint(
    { controlPlaneUrl: "http://fixture.invalid", runtimeToken: "fixture" },
    "model",
  );
  const pending = endpoint
    .requestToken(new NoSimulationTask("status-body-drain", false), { reason: "expiring" })
    .then((outcome) => {
      expect(drained).toBe(true);
      return outcome;
    });
  try {
    await entry;
    release();
    expect(await pending).toEqual({ kind: "unauthorized" });
  } finally {
    release();
    fetch.mockRestore();
  }
});

it("a late response cannot bypass a delayed HTTP deadline timer", async () => {
  let monotonic = 0;
  const server = createServer((_req, response) => {
    monotonic = 30_001;
    response.writeHead(200);
    response.end(
      JSON.stringify({ accessToken: "fixture", expiresAt: 9999999999999, generation: 1 }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const task = new NoSimulationTask("late-broker-response", false);
  const heldDeadline = new AbortController();
  vi.spyOn(task, "monotonicNow").mockImplementation(() => monotonic);
  vi.spyOn(task, "createDeadline").mockReturnValue({
    signal: heldDeadline.signal,
    cancel: () => {},
  });
  try {
    const endpoint = new HttpBrokerEndpoint(
      { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "fixture" },
      "model",
    );
    expect(await endpoint.requestToken(task, { reason: "expiring" })).toEqual({
      kind: "retryable",
      message: "broker HTTP request budget exhausted",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("malformed successful JSON is fatal, not a transport retry", async () => {
  const server = createServer((_req, response) => {
    response.writeHead(200);
    response.end("{");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  try {
    const endpoint = new HttpBrokerEndpoint(
      { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "fixture" },
      "model",
    );
    expect(
      await endpoint.requestToken(new NoSimulationTask("malformed-broker", false), {
        reason: "startup",
      }),
    ).toEqual({ kind: "fatal", message: "malformed token response" });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  { phase: "headers", budget: false },
  { phase: "body", budget: false },
  { phase: "headers", budget: true },
  { phase: "body", budget: true },
])("bounds held broker $phase (owned deadline=$budget)", async ({ phase, budget }) => {
  let arrived = () => {};
  const entered = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const server = createServer((_req, response) => {
    if (phase === "body") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    }
    arrived();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  const controller = new AbortController();
  const task = new NoSimulationTask("broker-cancel-contract", false);
  const cancelled = vi.fn();
  if (budget)
    vi.spyOn(task, "createDeadline").mockReturnValue({
      signal: controller.signal,
      cancel: cancelled,
    });
  const endpoint = new HttpBrokerEndpoint(
    { controlPlaneUrl: `http://127.0.0.1:${address.port}`, runtimeToken: "fixture" },
    "model",
  );
  const pending = endpoint.requestToken(
    task,
    { reason: "expiring" },
    budget ? undefined : controller.signal,
  );
  let fence: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered;
    controller.abort();
    expect(
      await Promise.race([
        pending,
        new Promise((resolve) => {
          fence = setTimeout(() => resolve("still-blocked"), 500);
        }),
      ]),
    ).toEqual(
      budget
        ? { kind: "retryable", message: "broker HTTP request budget exhausted" }
        : { kind: "cancelled" },
    );
    if (budget) {
      expect(task.createDeadline).toHaveBeenCalledWith(30_000, "broker HTTP request budget");
      expect(cancelled).toHaveBeenCalledOnce();
    }
  } finally {
    clearTimeout(fence);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pending;
  }
});
