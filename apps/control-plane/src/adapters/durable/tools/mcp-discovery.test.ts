import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { McpTimeoutError } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { type McpDiscoveryFailure, McpTools } from "./mcp.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["initialize", "list_tools", "close"] as const)(
  "records cancellation during %s before cleanup settles",
  async (phase) => {
    let now = 0;
    const failures: McpDiscoveryFailure[] = [];
    const entered = deferred(),
      release = deferred();
    const controller = new AbortController();
    const { client, server } = createInMemoryTransportPair();
    server.onMessage(async (message) => {
      if (!("method" in message) || !("id" in message)) return;
      if (
        (message.method === "initialize" && phase === "initialize") ||
        (message.method === "tools/list" && phase === "list_tools")
      ) {
        entered.resolve();
        return;
      }
      await server.send({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              }
            : { tools: [] },
      });
    });
    if (phase === "close") {
      const close = client.close.bind(client);
      client.close = async () => {
        entered.resolve();
        await release.promise;
        await close();
      };
    }
    void server.start();
    const mcp = new McpTools(
      [{ name: "fixture", connect: () => okAsync(client) }],
      new CallableCatalog([]),
      { now: () => now, record: (failure) => failures.push(failure) },
    );
    const discovery = mcp.discover(
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
      "fixture",
    );
    await entered.promise;
    now = 9;
    controller.abort();
    expect(failures).toEqual([
      {
        server: "fixture",
        phase,
        outcome: "aborted",
        elapsedMs: 9,
        discoveryElapsedMs: 9,
        errorCategory: "abort",
      },
    ]);
    release.resolve();
    const result = await discovery;
    expect(result.isErr() && result.error.code).toBe("cancelled");
    await mcp.close();
  },
);

it("distinguishes SDK timeout from credential rejection without raw errors", async () => {
  const failures: McpDiscoveryFailure[] = [];
  const { client } = createInMemoryTransportPair();
  client.start = async () => {
    throw new McpTimeoutError(30_000);
  };
  const mcp = new McpTools(
    [
      { name: "credential", connect: () => errAsync({ code: "forbidden", message: "SECRET" }) },
      { name: "timeout", connect: () => okAsync(client) },
    ],
    new CallableCatalog([]),
    { now: () => 0, record: (failure) => failures.push(failure) },
  );
  for (const server of ["credential", "timeout"])
    expect((await mcp.discover(BACKGROUND_CONTEXT, server)).isOk()).toBe(true);
  expect(failures).toEqual([
    {
      server: "credential",
      phase: "transport",
      outcome: "failed",
      elapsedMs: 0,
      discoveryElapsedMs: 0,
      errorCategory: "forbidden",
    },
    {
      server: "timeout",
      phase: "initialize",
      outcome: "failed",
      elapsedMs: 0,
      discoveryElapsedMs: 0,
      errorCategory: "request_timeout",
    },
  ]);
  await mcp.close();
});
