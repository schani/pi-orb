import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { expect, it } from "vitest";
import { MemoryAgentPersistence } from "../memory-persistence.testkit.ts";
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
  const diagnostics: unknown[] = [];
  const api = { diagnostic: (value: unknown) => diagnostics.push(value) };
  const failed = await tools.catalog.invoke(
    "mcp_discover",
    { server: "fixture" },
    api as never,
    BACKGROUND_CONTEXT,
  );
  expect(JSON.stringify(failed)).toContain("needs-auth");
  expect(JSON.stringify(failed)).not.toContain("SECRET");
  expect(diagnostics).toContainEqual({
    severity: "info",
    code: "mcp_status",
    message: "MCP fixture: needs-auth.",
  });
  await tools.catalog.invoke("mcp_status", {}, api as never, BACKGROUND_CONTEXT);
  expect(attempts).toBe(1);
  await tools.catalog.invoke(
    "mcp_discover",
    { server: "fixture" },
    api as never,
    BACKGROUND_CONTEXT,
  );
  expect(attempts).toBe(2);
  expect(tools.mcpStatus()).toEqual([{ name: "fixture", status: "available" }]);
  await tools.close();
});

it("merges concurrent selective discovery and preserves parent cancellation", async () => {
  const release: (() => void)[] = [];
  const mcp = new McpTools(
    ["a", "b"].map((name) => ({
      name,
      connect: () =>
        ResultAsync.fromSafePromise(new Promise<void>((resolve) => release.push(resolve))).andThen(
          () => errAsync({ code: "unavailable" as const, message: "SECRET" }),
        ),
    })),
    new CallableCatalog([]),
  );
  const a = mcp.discover(BACKGROUND_CONTEXT, "a");
  const b = mcp.discover(BACKGROUND_CONTEXT, "b");
  // Endpoint construction has an adapter microtask boundary.
  await Promise.resolve();
  await Promise.resolve();
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
        connect: () => errAsync({ code: "unavailable", message: "SECRET" }),
      },
    ],
  });
  const fixture = await openCodemodeHarness(tools.catalog);
  try {
    const result = await fixture.run('text(await tools.mcp_discover({server:"fixture"}));');
    expect(JSON.stringify(result.output)).toContain("unavailable");
    const records = await fixture.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(records.items)).toContain("MCP fixture: unavailable.");
    expect(JSON.stringify(records.items)).not.toContain("SECRET");
  } finally {
    await fixture.close();
    await tools.close();
  }
});

it("reports an earlier failed server before later discovery is cancelled", async () => {
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const tools = createDurableTools({
    mcp: [
      { name: "failed", connect: () => errAsync({ code: "unavailable", message: "SECRET" }) },
      {
        name: "held",
        connect: () => {
          const { client, server } = createInMemoryTransportPair();
          server.onMessage(() => {
            entered();
          });
          void server.start();
          return okAsync(client);
        },
      },
    ],
  });
  const fixture = await openCodemodeHarness(tools.catalog);
  const watch = await fixture.harness.watchDoc(LiveDoc, fixture.root.id, BACKGROUND_CONTEXT);
  let visible!: () => void;
  const published = new Promise<void>((resolve) => {
    visible = resolve;
  });
  watch?.start(async (live) => {
    if (
      live?.tools?.some((slot) =>
        slot.diagnostics?.some((diagnostic) => diagnostic.message === "MCP failed: unavailable."),
      )
    )
      visible();
  });
  try {
    const run = fixture.run("await tools.mcp_discover({});");
    await holding;
    await published;
    await fixture.abort();
    await run;
    const entries = await fixture.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries.items)).toContain("MCP failed: unavailable.");
  } finally {
    await watch?.stop();
    await fixture.close();
    await tools.close();
  }
});

it("reopens without restoring historical MCP health and permits explicit rediscovery", async () => {
  const authority = new MemoryAgentPersistence();
  const healthy = endpoint("fixture");
  let tools = createDurableTools({ mcp: [healthy] });
  let fixture = await openCodemodeHarness(tools.catalog, {
    storage: (await authority.openOrb("recovery", false))._unsafeUnwrap().storage,
  });
  try {
    expect(
      JSON.stringify(
        (await fixture.run('text(await tools.mcp_discover({server:"fixture"}));')).output,
      ),
    ).toContain("available");
    await fixture.close();
    await tools.close();
    tools = createDurableTools({ mcp: [healthy] });
    fixture = await openCodemodeHarness(tools.catalog, {
      storage: (await authority.openOrb("recovery", false))._unsafeUnwrap().storage,
    });
    expect(
      JSON.stringify((await fixture.run("text(await tools.mcp_status({}));")).output),
    ).toContain("unprobed");
    expect(healthy.count()).toBe(1);
    expect(
      JSON.stringify(
        (await fixture.run('text(await tools.mcp_discover({server:"fixture"}));')).output,
      ),
    ).toContain("available");
    expect(healthy.count()).toBe(2);
  } finally {
    await fixture.close();
    await tools.close();
    await authority.close();
  }
});

it("publishes each server failure once across parallel and sequential discoveries", async () => {
  const tools = createDurableTools({
    mcp: ["a", "b"].map((name) => ({
      name,
      connect: () => errAsync({ code: "unavailable" as const, message: "SECRET" }),
    })),
  });
  const fixture = await openCodemodeHarness(tools.catalog);
  try {
    await fixture.run(
      'await Promise.all([tools.mcp_discover({server:"a"}), tools.mcp_discover({server:"b"})]); await tools.mcp_discover({server:"a"});',
    );
    const records = await fixture.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const parent = records.items.find((entry) => entry.kind === "pi.tool-result");
    const data = parent?.data as { diagnostics?: { message: string }[] } | undefined;
    for (const server of ["a", "b"])
      expect(
        data?.diagnostics?.filter((item) => item.message === `MCP ${server}: unavailable.`),
      ).toHaveLength(1);
  } finally {
    await fixture.close();
    await tools.close();
  }
});
