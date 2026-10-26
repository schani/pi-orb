import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { errAsync, okAsync } from "neverthrow";
import { expect, it } from "vitest";
import { CallableCatalog } from "./catalog.ts";
import { type McpServerStatus, McpTools } from "./mcp.ts";
import { openCodemodeHarness } from "./testkit/codemode.ts";

function endpoint(name: string, names: string[]) {
  const state = { names, fail: false, calls: [] as string[], instructions: `${name} instructions` };
  return {
    state,
    name,
    connect: () => {
      if (state.fail) return errAsync({ code: "unavailable" as const, message: "private" });
      const { client, server } = createInMemoryTransportPair();
      server.onMessage((message) => {
        if (!("method" in message) || !("id" in message)) return;
        const respond = (result: unknown) =>
          server.send({ jsonrpc: "2.0", id: message.id, result });
        if (message.method === "initialize")
          void respond({
            protocolVersion: "2025-11-25",
            capabilities: { ...(state.names.length ? { tools: {} } : {}), resources: {} },
            serverInfo: { name, version: "1" },
            instructions: state.instructions,
          });
        if (message.method === "tools/list")
          void respond({
            tools: state.names.map((name) => ({
              name,
              inputSchema: { type: "object", additionalProperties: false },
            })),
          });
        if (message.method === "resources/list") void respond({ resources: [] });
        if (message.method === "tools/call") {
          const tool = (message.params as { name: string }).name;
          state.calls.push(tool);
          void respond({ content: [{ type: "text", text: `${name}/${tool}` }] });
        }
      });
      void server.start();
      return okAsync(client);
    },
  };
}
const unavailable = (name: string) => ({
  name,
  status: "unavailable",
  error: { code: "unavailable", message: "MCP server unavailable" },
});

it.each([
  ["prod-us", "delete", "prod_us", "delete", "mcp__prod_us__delete"],
  ["prod_us", "delete", "prod-us", "delete", "mcp__prod_us__delete"],
  ["prod", "db__delete", "prod__db", "delete", "mcp__prod__db__delete"],
  ["prod__db", "delete", "prod", "db__delete", "mcp__prod__db__delete"],
])("keeps %s/%s when later %s/%s collides", async (a, toolA, b, toolB, scriptName) => {
  const first = endpoint(a, [toolA]);
  const later = endpoint(b, ["unique", toolB]);
  const healthy = endpoint("healthy", ["ping"]);
  const catalog = new CallableCatalog([]);
  const edges: McpServerStatus[] = [];
  const mcp = new McpTools([first, later, healthy], catalog, undefined, (status) => {
    edges.push(status);
    return okAsync(undefined);
  });
  let native: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    // Raw dispatch must not silently select the later endpoint.
    const direct = await catalog.invoke(
      `mcp__${a}__${toolA}`,
      {},
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect.soft(direct.isOk()).toBe(true);
    expect.soft(first.state.calls).toEqual([toolA]);
    expect.soft(later.state.calls).toEqual([]);
    native = await openCodemodeHarness(catalog);
    const textOnly = await native.run('text("hello");');
    expect.soft(textOnly.isError).toBe(false);
    expect.soft(JSON.stringify(textOnly.output)).toContain("hello");
    const called = await native.run(
      `text((await tools.${scriptName}({})).content[0].text); text((await tools.mcp__healthy__ping({})).content[0].text);`,
    );
    expect.soft(called.isError).toBe(false);
    expect.soft(JSON.stringify(called.output)).toContain(`${a}/${toolA}`);
    expect.soft(first.state.calls).toEqual([toolA, toolA]);
    expect.soft(later.state.calls).toEqual([]);
    expect.soft(healthy.state.calls).toEqual(["ping"]);
    expect
      .soft(catalog.definitions().some((tool) => tool.name === `mcp__${b}__unique`))
      .toBe(false);
    expect
      .soft(mcp.status())
      .toEqual([
        { name: a, status: "available" },
        unavailable(b),
        { name: "healthy", status: "available" },
      ]);
    expect.soft(edges).toEqual(mcp.status());
    expect
      .soft(catalog.namespaceValues().find((namespace) => namespace.name === `mcp__${b}`))
      .toEqual({
        name: `mcp__${b}`,
        description: `${b}: unavailable`,
      });
  } finally {
    await native?.close();
    await mcp.close();
  }
});

it.each([
  ["get-user", "get_user"],
  ["get_user", "get-user"],
  ["same", "same"],
])("rejects an entire batch containing %s and %s", async (a, b) => {
  const conflicting = endpoint("bad", ["unique", a, b]);
  const healthy = endpoint("healthy", ["ping"]);
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([conflicting, healthy], catalog);
  let native: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
  try {
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect
      .soft(mcp.status())
      .toEqual([unavailable("bad"), { name: "healthy", status: "available" }]);
    expect
      .soft(
        catalog
          .definitions()
          .map((tool) => tool.name)
          .filter((name) => name.startsWith("mcp__bad__")),
      )
      .toEqual([]);
    // Rejected resource-capable endpoints must not publish resource access either.
    const resources = await catalog.invoke(
      "list_mcp_resources",
      { server: "bad" },
      {} as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    expect.soft(resources.isOk() && resources.value.isError).toBe(true);
    native = await openCodemodeHarness(catalog);
    const result = await native.run(
      'text("hello"); text((await tools.mcp__healthy__ping({})).content[0].text);',
    );
    expect.soft(result.isError).toBe(false);
    expect.soft(JSON.stringify(result.output)).toContain("hello");
    expect.soft(healthy.state.calls).toEqual(["ping"]);
    expect.soft(conflicting.state.calls).toEqual([]);
  } finally {
    await native?.close();
    await mcp.close();
  }
});

it.each([false, true])(
  "rediscovery preserves retained ownership (changed alias: %s)",
  async (changed) => {
    const server = endpoint("retry", ["get-user"]);
    const catalog = new CallableCatalog([]);
    const mcp = new McpTools([server], catalog);
    let native: Awaited<ReturnType<typeof openCodemodeHarness>> | undefined;
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      server.state.fail = true;
      const failed = await catalog.invoke(
        "mcp__retry__get-user",
        {},
        {} as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      expect(failed.isOk() && failed.value.isError).toBe(true);
      expect(mcp.status()).toEqual([unavailable("retry")]);
      server.state.fail = false;
      if (changed) server.state.names = ["unique", "get_user"];
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect
        .soft(mcp.status())
        .toEqual([changed ? unavailable("retry") : { name: "retry", status: "available" }]);
      expect
        .soft(
          catalog
            .definitions()
            .map((tool) => tool.name)
            .filter((name) => name.startsWith("mcp__retry__")),
        )
        .toEqual(["mcp__retry__get-user"]);
      native = await openCodemodeHarness(catalog);
      const result = await native.run(
        'text("hello"); text((await tools.mcp__retry__get_user({})).content[0].text);',
      );
      expect.soft(result.isError).toBe(false);
      expect.soft(JSON.stringify(result.output)).toContain("retry/get-user");
      expect.soft(server.state.calls).toEqual(["get-user"]);
    } finally {
      await native?.close();
      await mcp.close();
    }
  },
);

it.each(["mcp__local__get_user", "mcp__local__get-user"])(
  "preserves hidden local incumbent %s and permits a corrected retry",
  async (name) => {
    let calls = 0;
    const local = defineTool({
      name,
      description: "local incumbent",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        calls++;
        return { output: [{ type: "text" as const, text: "local" }] };
      },
    });
    const all = new CallableCatalog([local]);
    all.metadata(name, { deferred: true });
    const server = endpoint("local", ["unique", "get_user"]);
    const mcp = new McpTools([server], all.without([name]));
    try {
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect.soft(mcp.status()).toEqual([unavailable("local")]);
      expect.soft(all.definitions()).toEqual([local]);
      expect.soft(all.metadata(name)).toEqual({ deferred: true });
      (await all.invoke(name, {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect.soft(calls).toBe(1);
      expect.soft(server.state.calls).toEqual([]);
      server.state.names = ["unique", "corrected"];
      (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
      expect.soft(mcp.status()).toEqual([{ name: "local", status: "available" }]);
      (
        await all.invoke("mcp__local__corrected", {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
      )._unsafeUnwrap();
      expect.soft(server.state.calls).toEqual(["corrected"]);
      expect.soft(all.definitions().find((tool) => tool.name === name)).toBe(local);
    } finally {
      await mcp.close();
    }
  },
);

it("rejects duplicate rows on rediscovery before granting same-tool replacement", async () => {
  const server = endpoint("retry", ["same"]);
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([server], catalog);
  try {
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    const incumbent = catalog.definitions().find((tool) => tool.name === "mcp__retry__same");
    server.state.fail = true;
    await catalog.invoke("mcp__retry__same", {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT);
    server.state.fail = false;
    server.state.names = ["unique", "same", "same"];
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect.soft(mcp.status()).toEqual([unavailable("retry")]);
    expect
      .soft(catalog.definitions().filter((tool) => tool.name.startsWith("mcp__retry__")))
      .toEqual([incumbent]);
    server.state.names = ["same"];
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect.soft(mcp.status()).toEqual([{ name: "retry", status: "available" }]);
  } finally {
    await mcp.close();
  }
});

it("refreshes initialize instructions on tool and resource connections", async () => {
  const tools = endpoint("tools", ["ping"]);
  const resources = endpoint("resources", []);
  const catalog = new CallableCatalog([]);
  const mcp = new McpTools([tools, resources], catalog);
  const instructions = (name: string) =>
    catalog.namespaceValues().find((namespace) => namespace.name === `mcp__${name}`)?.instructions;
  try {
    tools.state.instructions = resources.state.instructions = "A";
    (await mcp.discover(BACKGROUND_CONTEXT))._unsafeUnwrap();
    expect(instructions("tools")).toBe("A");
    expect(instructions("resources")).toBe("A");

    tools.state.instructions = "B";
    const called = (
      await catalog.invoke("mcp__tools__ping", {}, {} as ToolExecutionApi, BACKGROUND_CONTEXT)
    )._unsafeUnwrap();
    expect(called.isError).not.toBe(true);
    expect(tools.state.calls).toEqual(["ping"]);
    expect.soft(instructions("tools")).toBe("B");

    for (const server of [tools, resources]) {
      server.state.instructions = "C";
      const listed = (
        await catalog.invoke(
          "list_mcp_resources",
          { server: server.name },
          {} as ToolExecutionApi,
          BACKGROUND_CONTEXT,
        )
      )._unsafeUnwrap();
      expect(listed.isError).not.toBe(true);
      expect.soft(instructions(server.name)).toBe("C");
    }
  } finally {
    await mcp.close();
  }
});
