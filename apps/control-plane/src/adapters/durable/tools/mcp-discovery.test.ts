import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { McpTimeoutError } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { type McpDiscoveryEvent, McpTools } from "./mcp.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("records serial discovery stages and elapsed time without rediscovering available servers", async () => {
  let now = 0;
  const events: McpDiscoveryEvent[] = [];
  const held = deferred();
  const release = deferred();
  const connected: string[] = [];
  const mcp = new McpTools(
    ["first", "second"].map((name) => ({
      name,
      connect: () => {
        connected.push(name);
        now += 2;
        const { client, server } = createInMemoryTransportPair();
        server.onMessage(async (message) => {
          if (!("method" in message) || !("id" in message)) return;
          if (message.method === "initialize") {
            now += 3;
            await server.send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name, version: "1" },
              },
            });
          }
          if (message.method === "tools/list") {
            if (name === "first") {
              held.resolve();
              await release.promise;
            }
            now += 5;
            await server.send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
          }
        });
        void server.start();
        return okAsync(client);
      },
    })),
    new CallableCatalog([]),
    { now: () => now, record: (event) => events.push(event) },
  );
  const discovery = mcp.discover(BACKGROUND_CONTEXT);
  await held.promise;
  expect(connected).toEqual(["first"]);
  expect(events.at(-1)).toMatchObject({ server: "first", phase: "list_tools", outcome: "started" });
  release.resolve();
  expect((await discovery).isOk()).toBe(true);
  expect(connected).toEqual(["first", "second"]);
  expect(
    events
      .filter((event) => event.outcome === "completed")
      .map(({ server, phase, elapsedMs, aborted }) => ({ server, phase, elapsedMs, aborted })),
  ).toEqual(
    ["first", "second"].flatMap((server) => [
      { server, phase: "transport", elapsedMs: 2, aborted: false },
      { server, phase: "initialize", elapsedMs: 3, aborted: false },
      { server, phase: "list_tools", elapsedMs: 5, aborted: false },
      { server, phase: "close", elapsedMs: 0, aborted: false },
    ]),
  );
  const count = events.length;
  await mcp.discover(BACKGROUND_CONTEXT);
  expect(events).toHaveLength(count);
  await mcp.close();
});

it.each(["initialize", "list_tools", "close"] as const)(
  "records outer cancellation while %s is active, including cleanup",
  async (phase) => {
    let now = 0;
    const events: McpDiscoveryEvent[] = [];
    const entered = deferred();
    const release = deferred();
    const controller = new AbortController();
    const { client, server } = createInMemoryTransportPair();
    server.onMessage(async (message) => {
      if (!("method" in message) || !("id" in message)) return;
      if (message.method === "initialize" && phase !== "initialize")
        await server.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          },
        });
      if (message.method === "tools/list" && phase !== "list_tools")
        await server.send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    });
    if (phase === "close") {
      const close = client.close.bind(client);
      client.close = async () => {
        await release.promise;
        await close();
      };
    }
    void server.start();
    const mcp = new McpTools(
      [{ name: "fixture", connect: () => okAsync(client) }],
      new CallableCatalog([]),
      {
        now: () => now,
        record: (event) => {
          events.push(event);
          if (event.phase === phase && event.outcome === "started") entered.resolve();
        },
      },
    );
    const discovery = mcp.discover(withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
    await entered.promise;
    now = 9;
    controller.abort();
    expect(events).toContainEqual(
      expect.objectContaining({
        attempt: 1,
        server: "fixture",
        phase,
        outcome: "aborted",
        elapsedMs: 9,
        aborted: true,
        serverOrdinal: 1,
        serverTotal: 1,
        discoveryElapsedMs: 9,
      }),
    );
    release.resolve();
    const result = await discovery;
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("cancelled");
    expect(events.some((event) => event.phase === "close")).toBe(true);
    expect(events.some((event) => event.errorCategory === "request_timeout")).toBe(false);
    await mcp.close();
  },
);

it("distinguishes an SDK timeout from an outer abort and omits raw errors", async () => {
  const events: McpDiscoveryEvent[] = [];
  const { client } = createInMemoryTransportPair();
  client.start = async () => {
    throw new McpTimeoutError(30_000);
  };
  const mcp = new McpTools(
    [
      { name: "secret-failure", connect: () => errAsync({ code: "forbidden", message: "SECRET" }) },
      { name: "timeout", connect: () => okAsync(client) },
    ],
    new CallableCatalog([]),
    { now: () => 0, record: (event) => events.push(event) },
  );
  expect((await mcp.discover(BACKGROUND_CONTEXT)).isOk()).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({
      server: "secret-failure",
      phase: "transport",
      outcome: "failed",
      errorCategory: "forbidden",
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      server: "timeout",
      phase: "initialize",
      outcome: "failed",
      errorCategory: "request_timeout",
      aborted: false,
    }),
  );
  expect(JSON.stringify(events)).not.toContain("SECRET");
  await mcp.close();
});
