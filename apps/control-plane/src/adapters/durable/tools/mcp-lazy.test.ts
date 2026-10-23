import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { projectHistory } from "../projection.ts";
import { CallableCatalog } from "./catalog.ts";
import { createDurableTools } from "./index.ts";
import { McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

function endpoint(name: string) {
  let connections = 0;
  return {
    count: () => connections,
    name,
    connect: () => {
      connections++;
      const { client, server } = createInMemoryTransportPair();
      server.onMessage(async (message) => {
        if (!("method" in message) || !("id" in message)) return;
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name, version: "1" },
              }
            : message.method === "tools/list"
              ? { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: "pong" }] };
        await server.send({ jsonrpc: "2.0", id: message.id, result });
      });
      void server.start();
      return okAsync(client);
    },
  };
}

it("inventories unprobed servers without network, rejects unknown selection and isolates selected discovery", async () => {
  const healthy = endpoint("healthy");
  let broken = 0;
  const tools = createDurableTools({
    mcp: [
      {
        name: "broken",
        connect: () => {
          broken++;
          return errAsync({ code: "unavailable", message: "SECRET" });
        },
      },
      healthy,
    ],
  });
  expect(tools.mcpStatus()).toEqual([
    { name: "broken", status: "unprobed" },
    { name: "healthy", status: "unprobed" },
  ]);
  const diagnostics: unknown[] = [];
  const api = { diagnostic: (value: unknown) => diagnostics.push(value) };
  const missing = await tools.catalog.invoke("mcp_discover", {}, api as never, BACKGROUND_CONTEXT);
  expect(missing.isErr() || missing.value.isError).toBe(true);
  expect(broken).toBe(0);
  expect(healthy.count()).toBe(0);
  const unknown = await tools.catalog.invoke(
    "mcp_discover",
    { server: "missing" },
    api as never,
    BACKGROUND_CONTEXT,
  );
  expect(unknown.isOk() && unknown.value.isError).toBe(true);
  expect(broken).toBe(0);
  expect(healthy.count()).toBe(0);
  await tools.catalog.invoke("mcp_status", {}, api as never, BACKGROUND_CONTEXT);
  expect(broken).toBe(0);
  await tools.catalog.invoke(
    "mcp_discover",
    { server: "healthy" },
    api as never,
    BACKGROUND_CONTEXT,
  );
  expect(broken).toBe(0);
  expect(healthy.count()).toBe(1);
  expect(tools.mcpStatus()).toEqual([
    { name: "broken", status: "unprobed" },
    { name: "healthy", status: "available" },
  ]);
  expect(tools.catalog.definitions().some((tool) => tool.name === "mcp__healthy__ping")).toBe(true);
  await tools.close();
});

it("retries failed servers only on explicit discovery and returns sanitized failure diagnostics", async () => {
  let attempts = 0;
  const healthy = endpoint("fixture");
  const tools = createDurableTools({
    mcp: [
      {
        name: "fixture",
        unavailableState: () => "needs-auth",
        connect: () =>
          ++attempts === 1 ? errAsync({ code: "forbidden", message: "SECRET" }) : healthy.connect(),
      },
    ],
  });
  const failed = await tools.discover(BACKGROUND_CONTEXT, "fixture");
  expect(JSON.stringify(failed)).toContain("needs-auth");
  expect(JSON.stringify(failed)).not.toContain("SECRET");
  tools.mcpStatus();
  expect(attempts).toBe(1);
  await tools.discover(BACKGROUND_CONTEXT, "fixture");
  expect(attempts).toBe(2);
  expect(tools.mcpStatus()).toEqual([{ name: "fixture", status: "available" }]);
  expect(tools.catalog.definitions().some((tool) => tool.name === "mcp__fixture__ping")).toBe(true);
  await tools.discover(BACKGROUND_CONTEXT, "fixture");
  expect(attempts).toBe(2);
  await tools.close();
});

it("merges concurrent selective discovery and preserves parent cancellation", async () => {
  const release: (() => void)[] = [];
  let entered!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mcp = new McpTools(
    ["a", "b"].map((name) => ({
      name,
      connect: () =>
        ResultAsync.fromSafePromise(
          new Promise<void>((resolve) => {
            release.push(resolve);
            if (release.length === 2) entered();
          }),
        ).andThen(() => errAsync({ code: "unavailable" as const, message: "SECRET" })),
    })),
    new CallableCatalog([]),
  );
  const a = mcp.discover(BACKGROUND_CONTEXT, "a");
  const b = mcp.discover(BACKGROUND_CONTEXT, "b");
  await bothEntered;
  expect(release).toHaveLength(2);
  release[0]?.();
  release[1]?.();
  await Promise.all([a, b]);
  expect(mcp.status().map(({ name, status }) => ({ name, status }))).toEqual([
    { name: "a", status: "unavailable" },
    { name: "b", status: "unavailable" },
  ]);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await mcp.discover(withAbortSignal(controller.signal, BACKGROUND_CONTEXT), "a");
  expect(cancelled.isErr() && cancelled.error.code).toBe("cancelled");
  await mcp.close();
});

it("commits failed discovery diagnostics to the parent transcript and model result", async () => {
  const tools = createDurableTools({
    mcp: [
      {
        name: "fixture",
        unavailableState: () => "needs-auth",
        connect: () => errAsync({ code: "forbidden", message: "SECRET" }),
      },
    ],
  });
  const fixture = await openCodemodeHarness(tools.catalog);
  try {
    const result = await fixture.run('text(await tools.mcp_discover({server:"fixture"}));');
    expect(JSON.stringify(result.output)).toContain("needs-auth");
    const records = await fixture.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(records.items)).toContain("MCP fixture: needs-auth.");
    expect(JSON.stringify(records.items)).not.toContain("SECRET");
    const history = projectHistory(records.items, "session");
    expect(history.isOk()).toBe(true);
    expect(JSON.stringify(history)).toContain("MCP fixture: needs-auth.");
  } finally {
    await fixture.close();
    await tools.close();
  }
});

it("reopens unprobed and rebuilds the catalog only on explicit discovery", async () => {
  const healthy = endpoint("fixture");
  let tools = createDurableTools({ mcp: [healthy] });
  try {
    await tools.discover(BACKGROUND_CONTEXT, "fixture");
    await tools.close();
    tools = createDurableTools({ mcp: [healthy] });
    expect(tools.mcpStatus()).toEqual([{ name: "fixture", status: "unprobed" }]);
    expect(tools.catalog.definitions().some((tool) => tool.name === "mcp__fixture__ping")).toBe(
      false,
    );
    expect(healthy.count()).toBe(1);
    await tools.discover(BACKGROUND_CONTEXT, "fixture");
    expect(tools.catalog.definitions().some((tool) => tool.name === "mcp__fixture__ping")).toBe(
      true,
    );
    expect(healthy.count()).toBe(2);
  } finally {
    await tools.close();
  }
});
